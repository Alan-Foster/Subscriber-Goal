import { logDiagnostic } from "../../shared/diagnostics";
import {
  repairAutoCreateNextGoal,
  type AutoCreateNextGoalRepairResult,
} from "../data/subGoalData";
import { getAppSettings, type ServerAppSettings } from "../settings";
import { isLinkId, type RedditClient, type RedisClient } from "../types";
import {
  autoCreateNextGoalSuccessorsKey,
  processDueAutoCreateNextGoals,
} from "./autoCreateNextGoal";
import type { OnboardingLifecycleSource } from "./onboardingSubscriberGoal";

export type CompletedGoalReconciliationOutcome =
  | "completed_no_recovery"
  | "completed_auto_disabled"
  | "replacement_scheduled"
  | "replacement_created"
  | "replacement_retrying"
  | "replacement_exhausted";

export type CompletedGoalReconciliationResult = {
  outcome: CompletedGoalReconciliationOutcome;
  sourcePostId: string;
  successorPostId?: string;
  queueStatus?: AutoCreateNextGoalRepairResult["status"];
};

export async function reconcileCompletedGoal({
  reddit,
  redis,
  lifecycleSource,
  sourcePostId,
  completedTime,
  autoCreateNextGoal,
  nowMs,
  appSettings = getAppSettings(),
}: {
  reddit: RedditClient;
  redis: RedisClient;
  lifecycleSource: OnboardingLifecycleSource;
  sourcePostId: string;
  completedTime: number;
  autoCreateNextGoal: boolean;
  nowMs: number;
  appSettings?: ServerAppSettings;
}): Promise<CompletedGoalReconciliationResult> {
  if (lifecycleSource !== "upgrade") {
    return { outcome: "completed_no_recovery", sourcePostId };
  }
  if (!autoCreateNextGoal) {
    return { outcome: "completed_auto_disabled", sourcePostId };
  }

  const existingSuccessor = await redis.hGet(
    autoCreateNextGoalSuccessorsKey,
    sourcePostId,
  );
  if (existingSuccessor && isLinkId(existingSuccessor)) {
    return {
      outcome: "replacement_created",
      sourcePostId,
      successorPostId: existingSuccessor,
    };
  }

  const repaired = await repairAutoCreateNextGoal(
    redis,
    sourcePostId,
    completedTime,
    nowMs,
  );
  if (repaired.status === "exhausted") {
    return {
      outcome: "replacement_exhausted",
      sourcePostId,
      queueStatus: repaired.status,
    };
  }
  if (repaired.status === "retrying") {
    return {
      outcome: "replacement_retrying",
      sourcePostId,
      queueStatus: repaired.status,
    };
  }
  if (
    repaired.status !== "scheduled" ||
    repaired.runAt === undefined ||
    repaired.runAt > nowMs
  ) {
    return {
      outcome: "replacement_scheduled",
      sourcePostId,
      queueStatus: repaired.status,
    };
  }

  const summary = await processDueAutoCreateNextGoals({
    reddit,
    redis,
    appSettings,
    nowMs,
  });
  const mappedSuccessor = await redis.hGet(
    autoCreateNextGoalSuccessorsKey,
    sourcePostId,
  );
  const successorPostId =
    mappedSuccessor && isLinkId(mappedSuccessor) ? mappedSuccessor : undefined;
  const outcome: CompletedGoalReconciliationOutcome =
    summary.created > 0 || successorPostId
      ? "replacement_created"
      : summary.exhausted > 0
        ? "replacement_exhausted"
        : summary.rescheduled > 0 || summary.failed > 0
          ? "replacement_retrying"
          : "replacement_scheduled";
  logDiagnostic("info", "completed_goal_replacement_processed", {
    workflow: "completed_goal_reconciliation",
    phase: "process_due",
    lifecycleSource,
    sourcePostId,
    outcome,
  });
  return {
    outcome,
    sourcePostId,
    ...(successorPostId ? { successorPostId } : {}),
    queueStatus: repaired.status,
  };
}
