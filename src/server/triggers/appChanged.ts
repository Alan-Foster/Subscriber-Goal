import { context, reddit, redis } from "@devvit/web/server";
import { ensureSavedSubredditDisplayName } from "../data/subredditDisplayNameData";
import { initializeRecentSubscriberIndexMigration } from "../data/subGoalData";
import {
  clearLegacySubscriberErasureTombstones,
  initializeSubscriberStatsMigration,
} from "../data/subscriberStats";
import {
  getOnboardingEligibility,
  getOnboardingSubscriberGoalState,
  initializeOnboardingSubscriberGoal,
  markOnboardingSubscriberGoalIneligible,
  AUTOMATIC_ONBOARDING_ENABLED,
  onboardingMinimumSubscriberCount,
} from "../core/onboardingSubscriberGoal";
import {
  getOnboardingReminderState,
  markOnboardingReminderIneligible,
  scheduleOnboardingReminder,
} from "../core/onboardingReminder";
import { logDiagnostic } from "../../shared/diagnostics";
import { rememberAppInstaller } from "../core/appAccountHealth";
import { scheduleAppRepair } from "../core/appRepair";
import { reconcileOnboardingForLifecycle } from "../core/onboardingLifecycle";

export async function onAppChanged({
  lifecycleSource = "unknown",
  installerUsername,
}: {
  lifecycleSource?: "install" | "upgrade" | "unknown";
  installerUsername?: string;
} = {}): Promise<void> {
  if (!context.subredditName && !context.subredditId) {
    console.info(
      "[appChanged] skipping subreddit setup: no subreddit context on lifecycle trigger",
    );
    return;
  }

  let subredditName = context.subredditName;
  let currentSubreddit:
    | Awaited<ReturnType<typeof reddit.getCurrentSubreddit>>
    | undefined;
  if (!subredditName) {
    try {
      currentSubreddit = await reddit.getCurrentSubreddit();
      subredditName = currentSubreddit.name;
    } catch (error) {
      logDiagnostic(
        "warn",
        "app_changed_phase_failed",
        { workflow: "app_changed", phase: "subreddit_resolution" },
        error,
      );
      throw error;
    }
  }

  const runPhase = async (
    phase: string,
    operation: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      logDiagnostic(
        "warn",
        "app_changed_phase_failed",
        { workflow: "app_changed", phase },
        error,
      );
    }
  };

  await rememberAppInstaller(redis, installerUsername);
  await scheduleAppRepair(redis);

  await runPhase("subreddit_display_name", () =>
    ensureSavedSubredditDisplayName(redis, subredditName),
  );
  await runPhase("subscriber_erasure_cleanup", () =>
    clearLegacySubscriberErasureTombstones(redis),
  );
  await runPhase("subscriber_stats_migration", () =>
    initializeSubscriberStatsMigration(redis),
  );
  if (shouldInitializeReleaseOnboarding(lifecycleSource)) {
    if (!currentSubreddit) {
      try {
        currentSubreddit = await reddit.getCurrentSubreddit();
      } catch (error) {
        logDiagnostic(
          "warn",
          "app_changed_phase_failed",
          { workflow: "app_changed", phase: "onboarding_eligibility" },
          error,
        );
        throw error;
      }
    }
    const eligibility = getOnboardingEligibility(currentSubreddit);
    logDiagnostic("info", "onboarding_eligibility_checked", {
      workflow: "app_changed",
      phase: "lifecycle_setup",
      lifecycleSource,
      subscriberCount: eligibility.subscriberCount,
      minimumSubscriberCount: onboardingMinimumSubscriberCount,
      subredditType: eligibility.subredditType,
      isSfw: eligibility.isSfw,
      safetyStatus: eligibility.safetyStatus,
      eligible: eligibility.eligible,
      reason: eligibility.reason ?? "none",
    });
    console.info(
      `[appChanged] onboarding eligibility: source=${lifecycleSource} subscriberCount=${eligibility.subscriberCount} minimumSubscriberCount=${onboardingMinimumSubscriberCount} subredditType=${eligibility.subredditType} safetyStatus=${eligibility.safetyStatus} isSfw=${eligibility.isSfw} eligible=${eligibility.eligible} reason=${eligibility.reason ?? "none"}`,
    );
    let reconciliationStatus = "not_eligible";
    if (eligibility.eligible) {
      const reconciliation = await reconcileOnboardingForLifecycle(
        reddit,
        redis,
        {
          lifecycleSource:
            lifecycleSource === "install" ? "install" : "upgrade",
        },
      );
      reconciliationStatus = reconciliation.status;
    }
    await initializeOnboardingSubscriberGoal(redis, { lifecycleSource });
    await scheduleOnboardingReminder(redis, { lifecycleSource });
    if (!eligibility.eligible) {
      const nowMs = Date.now();
      await markOnboardingReminderIneligible(
        redis,
        eligibility.subscriberCount,
        nowMs,
        eligibility.reason,
      );
      await markOnboardingSubscriberGoalIneligible(
        redis,
        eligibility.subscriberCount,
        nowMs,
        eligibility.reason,
      );
    }
    const [goalState, reminderState] = await Promise.all([
      getOnboardingSubscriberGoalState(redis),
      getOnboardingReminderState(redis),
    ]);
    const nextAction = describeOnboardingNextAction(goalState, reminderState);
    logDiagnostic("info", "onboarding_lifecycle_setup_complete", {
      workflow: "onboarding_lifecycle",
      phase: "lifecycle_setup_complete",
      lifecycleSource,
      eligible: eligibility.eligible,
      reconciliationStatus,
      nextAction,
      timerArmed:
        reminderState?.status === "pending" || goalState?.status === "pending",
      goalState: goalState?.status ?? "missing_or_unparseable",
      goalResult: goalState?.resultStatus ?? "none",
      goalOperationId: goalState?.operationId ?? "none",
      goalArmedAt: goalState?.armedAt ?? "none",
      goalNextRunAt: goalState?.nextRunAt ?? "none",
      goalNextRunAtIso: formatOptionalTimestamp(goalState?.nextRunAt),
      reminderState: reminderState?.status ?? "missing_or_unparseable",
      reminderResult: reminderState?.result ?? "none",
      reminderNextRunAt: reminderState?.nextRunAt ?? "none",
      reminderNextRunAtIso: formatOptionalTimestamp(reminderState?.nextRunAt),
    });
    console.info(
      `[appChanged] onboarding setup: reconciliation=${reconciliationStatus} nextAction=${nextAction} timerArmed=${reminderState?.status === "pending" || goalState?.status === "pending"} goal=${goalState?.status ?? "missing_or_unparseable"}/${goalState?.resultStatus ?? "none"} reminder=${reminderState?.status ?? "missing_or_unparseable"}/${reminderState?.result ?? "none"} reminderNextRunAt=${formatOptionalTimestamp(reminderState?.nextRunAt)} goalNextRunAt=${formatOptionalTimestamp(goalState?.nextRunAt)} operationId=${goalState?.operationId ?? "none"}`,
    );
  }
  await runPhase("recent_subscriber_index_migration", () =>
    initializeRecentSubscriberIndexMigration(redis),
  );
}

function describeOnboardingNextAction(
  goalState:
    | Awaited<ReturnType<typeof getOnboardingSubscriberGoalState>>
    | undefined,
  reminderState:
    | Awaited<ReturnType<typeof getOnboardingReminderState>>
    | undefined,
): string {
  if (reminderState?.status === "pending") return "awaiting_modmail_timer";
  if (
    reminderState?.status === "processing" ||
    reminderState?.status === "dispatching"
  ) {
    return "modmail_processing";
  }
  if (goalState?.status === "pending") return "awaiting_goal_creation_timer";
  if (goalState?.status === "processing") return "goal_creation_processing";
  if (goalState?.status === "complete") return "terminal_no_action";
  if (goalState?.status === "awaiting_warning")
    return "awaiting_reminder_state";
  return "no_runnable_workflow";
}

function formatOptionalTimestamp(timestamp: number | undefined): string {
  return timestamp === undefined ? "none" : new Date(timestamp).toISOString();
}

export function shouldInitializeReleaseOnboarding(
  lifecycleSource: "install" | "upgrade" | "unknown",
  automationEnabled = AUTOMATIC_ONBOARDING_ENABLED,
): boolean {
  return (
    automationEnabled &&
    (lifecycleSource === "install" || lifecycleSource === "upgrade")
  );
}
