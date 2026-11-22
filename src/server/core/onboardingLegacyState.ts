import type { RedisClient } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";
import type { OnboardingLifecycleSource } from "./goalDiscovery";

export type LegacyMigration = {
  version: string;
  armedAt: number;
  lifecycleSource: OnboardingLifecycleSource;
  attempts: number;
  operationId?: string;
  reminderSentAt?: number;
  deliveryUnknown?: boolean;
};

export async function findPendingLegacyOnboardingWork(
  redis: RedisClient,
): Promise<LegacyMigration | undefined> {
  let hasTerminalLegacyGoal = false;
  for (const candidate of [
    {
      key: "onboarding_subscriber_goal_v3_state",
      version: "onboarding_subscriber_goal_v3",
      operationId: (armedAt: number) =>
        `onboarding:onboarding_subscriber_goal_v3:${armedAt}`,
    },
    {
      key: "onboarding_subscriber_goal_v2_state",
      version: "onboarding_subscriber_goal_v2",
      operationId: (armedAt: number) => `onboarding:${armedAt}`,
    },
  ]) {
    const raw = await redis.hGetAll(candidate.key);
    if (raw.status === "complete") hasTerminalLegacyGoal = true;
    if (raw.status !== "pending" && raw.status !== "processing") continue;
    const armedAt = parseStateNumber(raw.armedAt);
    if (armedAt === undefined) continue;
    const reminder = await findLegacyReminderDisposition(redis);
    return {
      version: candidate.version,
      armedAt,
      lifecycleSource: parseLifecycleSource(raw.lifecycleSource),
      attempts: parseStateNumber(raw.attempts) ?? 0,
      operationId: candidate.operationId(armedAt),
      ...(reminder.sentAt ? { reminderSentAt: reminder.sentAt } : {}),
      ...(raw.status === "processing" || reminder.deliveryUnknown
        ? { deliveryUnknown: true }
        : {}),
    };
  }

  const rawLegacyV1 = await redis.get("onboarding_subscriber_goal_v1");
  if (rawLegacyV1) {
    const legacy = await readLegacyV1Goal(redis, rawLegacyV1);
    if (legacy === "terminal") hasTerminalLegacyGoal = true;
    else if (legacy) return legacy;
  }

  if (hasTerminalLegacyGoal) return undefined;

  for (const candidate of [
    ["onboarding_reminder_v2_state", "onboarding_reminder_v2"],
    ["onboarding_reminder_v1_state", "onboarding_reminder_v1"],
  ] as const) {
    const raw = await redis.hGetAll(candidate[0]);
    if (raw.status !== "pending" && raw.status !== "processing") continue;
    const armedAt = parseStateNumber(raw.armedAt);
    if (armedAt === undefined) continue;
    return {
      version: candidate[1],
      armedAt,
      lifecycleSource: parseLifecycleSource(raw.lifecycleSource),
      attempts: parseStateNumber(raw.attempts) ?? 0,
      ...(raw.status === "processing" ? { deliveryUnknown: true } : {}),
    };
  }
  return undefined;
}

export function parseLifecycleSource(
  value: unknown,
): OnboardingLifecycleSource {
  return value === "install" || value === "upgrade" || value === "recovery"
    ? value
    : "unknown";
}

async function findLegacyReminderDisposition(redis: RedisClient): Promise<{
  sentAt?: number;
  deliveryUnknown?: boolean;
}> {
  for (const key of [
    "onboarding_reminder_v2_state",
    "onboarding_reminder_v1_state",
  ]) {
    const raw = await redis.hGetAll(key);
    if (raw.status === "complete" && raw.result === "sent") {
      const sentAt =
        parseStateNumber(raw.sentAt) ??
        parseStateNumber(raw.completedAt) ??
        parseStateNumber(raw.armedAt);
      return sentAt === undefined ? {} : { sentAt };
    }
    if (
      raw.status === "processing" ||
      (raw.status === "complete" && raw.result === "failed")
    ) {
      return { deliveryUnknown: true };
    }
  }
  return {};
}

async function readLegacyV1Goal(
  redis: RedisClient,
  legacyV1: string,
): Promise<LegacyMigration | "terminal" | undefined> {
  try {
    const raw = JSON.parse(legacyV1) as Record<string, unknown>;
    if (raw.status === "pending" || raw.status === "processing") {
      const armedAt = Number(raw.armedAt);
      if (Number.isFinite(armedAt)) {
        const reminder = await findLegacyReminderDisposition(redis);
        return {
          version: "onboarding_subscriber_goal_v1",
          armedAt,
          lifecycleSource: parseLifecycleSource(raw.lifecycleSource),
          attempts: Number.isFinite(Number(raw.attempts))
            ? Number(raw.attempts)
            : 0,
          operationId: `onboarding:onboarding_subscriber_goal_v1:${armedAt}`,
          ...(reminder.sentAt ? { reminderSentAt: reminder.sentAt } : {}),
          ...(raw.status === "processing" || reminder.deliveryUnknown
            ? { deliveryUnknown: true }
            : {}),
        };
      }
    }
    if (
      raw.status === "created" ||
      raw.status === "existing" ||
      raw.status === "failed"
    ) {
      return "terminal";
    }
  } catch (error) {
    logDiagnostic(
      "warn",
      "onboarding_legacy_state_invalid",
      {
        workflow: "onboarding_subscriber_goal",
        phase: "legacy_v1_parse",
      },
      error,
    );
  }
  return undefined;
}

export function parseStateNumber(
  value: string | undefined,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
