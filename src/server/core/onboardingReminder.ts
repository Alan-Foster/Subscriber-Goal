import type { RedditClient, RedisClient } from "../types";
import {
  findExistingSubscriberGoal,
  getDetectionDiagnosticsFromError,
  type OnboardingDetectionDiagnostics,
  type OnboardingExistingSource,
  type OnboardingLifecycleSource,
} from "./onboardingSubscriberGoal";

export const onboardingReminderStateKey = "onboarding_reminder_v1_state";
export const onboardingReminderLockKey = "onboarding_reminder_v1_lock";
export const onboardingReminderVersion = "onboarding_reminder_v1";
export const onboardingReminderDelayMs = 60 * 1000;

type OnboardingReminderStatus = "pending" | "processing" | "complete";
type OnboardingReminderResult = "sent" | "existing" | "failed";

export type OnboardingReminderState = {
  version: typeof onboardingReminderVersion;
  status: OnboardingReminderStatus;
  nextRunAt: number;
  armedAt: number;
  lifecycleSource: OnboardingLifecycleSource;
  startedAt?: number;
  completedAt?: number;
  postId?: string;
  existingSource?: OnboardingExistingSource;
  result?: OnboardingReminderResult;
  errorMessage?: string;
};

export type OnboardingReminderSummary = OnboardingDetectionDiagnostics & {
  status: "not_due" | "sent" | "existing" | "failed" | "complete";
  postId?: string;
  existingSource?: OnboardingExistingSource;
  errorMessage?: string;
};

export type OnboardingReminderMessage = {
  subject: string;
  bodyMarkdown: string;
};

const emptySummary = (): Omit<OnboardingReminderSummary, "status"> => ({
  registeredInspected: 0,
  trackedInspected: 0,
  queuedInspected: 0,
  persistedInspected: 0,
  pinnedInspected: 0,
  recentInspected: 0,
  validated: 0,
  stalePruned: 0,
  failed: 0,
});

export function buildOnboardingReminderMessage(
  subredditName: string,
): OnboardingReminderMessage {
  return {
    subject: `Welcome to Subscriber Goal in r/${subredditName}`,
    bodyMarkdown:
      `Welcome to Subscriber Goal for r/${subredditName}!\n\n` +
      "You can find more information about creating a Subscriber Goal at https://developers.reddit.com/apps/subscriber-goal.\n\n" +
      "If you have questions, please send a DM to u/Alan-Foster.\n\n" +
      "If a Subscriber Goal is not created within 24 hours of this installation or update, Subscriber Goal will automatically create one using the default settings for your subreddit.",
  };
}

/** Arms a single reminder for the current install or upgrade lifecycle event. */
export async function scheduleOnboardingReminder(
  redis: RedisClient,
  {
    lifecycleSource = "unknown",
    nowMs = Date.now(),
  }: {
    lifecycleSource?: OnboardingLifecycleSource;
    nowMs?: number;
  },
): Promise<void> {
  const state: OnboardingReminderState = {
    version: onboardingReminderVersion,
    status: "pending",
    armedAt: nowMs,
    nextRunAt: nowMs + onboardingReminderDelayMs,
    lifecycleSource,
  };
  await saveOnboardingReminderState(redis, state);
  console.info(
    `[onboardingReminder] initialized: status=pending nextRunAt=${state.nextRunAt} source=${state.lifecycleSource} version=${state.version}`,
  );
}

export async function processDueOnboardingReminder({
  reddit,
  redis,
  nowMs = Date.now(),
}: {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs?: number;
}): Promise<OnboardingReminderSummary> {
  const base = emptySummary();
  const state = parseOnboardingReminderState(
    await redis.hGetAll(onboardingReminderStateKey),
  );
  if (!state || state.status === "complete" || nowMs < state.nextRunAt) {
    return {
      status: state?.status === "complete" ? "complete" : "not_due",
      ...base,
    };
  }

  const lockToken = `${nowMs}:${Math.random().toString(36).slice(2)}`;
  await redis.set(onboardingReminderLockKey, lockToken, {
    nx: true,
    expiration: new Date(nowMs + 5 * 60 * 1000),
  });
  if ((await redis.get(onboardingReminderLockKey)) !== lockToken) {
    return { status: "not_due", ...base };
  }

  let inspected = base;
  try {
    const reloaded = parseOnboardingReminderState(
      await redis.hGetAll(onboardingReminderStateKey),
    );
    if (
      !reloaded ||
      reloaded.status === "complete" ||
      nowMs < reloaded.nextRunAt
    ) {
      return {
        status: reloaded?.status === "complete" ? "complete" : "not_due",
        ...base,
      };
    }

    console.info(
      `[onboardingReminder] starting check: source=${reloaded.lifecycleSource} nextRunAt=${reloaded.nextRunAt} status=${reloaded.status}`,
    );
    await saveOnboardingReminderState(redis, {
      ...reloaded,
      status: "processing",
      startedAt: nowMs,
    });

    const existing = await findExistingSubscriberGoal(reddit, redis, nowMs);
    inspected = {
      registeredInspected: existing.registeredInspected ?? 0,
      trackedInspected: existing.trackedInspected ?? 0,
      queuedInspected: existing.queuedInspected ?? 0,
      persistedInspected: existing.persistedInspected ?? 0,
      pinnedInspected: existing.pinnedInspected ?? 0,
      recentInspected: existing.recentInspected ?? 0,
      validated: existing.validated ?? 0,
      stalePruned: existing.stalePruned ?? 0,
      failed: existing.failed ?? 0,
    };
    if (existing.postId) {
      const existingSource = existing.source ?? "tracked";
      await saveOnboardingReminderState(redis, {
        ...reloaded,
        status: "complete",
        completedAt: nowMs,
        result: "existing",
        postId: existing.postId,
        existingSource,
      });
      console.info(
        `[onboardingReminder] complete: status=existing existingSource=${existingSource} postId=${existing.postId} ${formatReminderDiagnostics(inspected)}`,
      );
      return {
        status: "existing",
        postId: existing.postId,
        existingSource,
        ...inspected,
      };
    }

    const subreddit = await reddit.getCurrentSubreddit();
    const message = buildOnboardingReminderMessage(subreddit.name);
    await reddit.modMail.createModNotification({
      subredditId: subreddit.id,
      subject: message.subject,
      bodyMarkdown: message.bodyMarkdown,
    });
    await saveOnboardingReminderState(redis, {
      ...reloaded,
      status: "complete",
      completedAt: nowMs,
      result: "sent",
    });
    console.info(
      `[onboardingReminder] complete: status=sent ${formatReminderDiagnostics(inspected)}`,
    );
    return { status: "sent", ...inspected };
  } catch (error) {
    inspected = getDetectionDiagnosticsFromError(error) ?? inspected;
    const errorMessage = String(error);
    try {
      await saveOnboardingReminderState(redis, {
        ...state,
        status: "complete",
        completedAt: nowMs,
        result: "failed",
        errorMessage,
      });
    } catch (stateError) {
      console.error(
        `[onboardingReminder] failed to persist terminal failure: ${String(stateError)}`,
      );
    }
    console.error(
      `[onboardingReminder] complete: status=failed error=${errorMessage} ${formatReminderDiagnostics(inspected)}`,
    );
    return { status: "failed", errorMessage, ...inspected };
  } finally {
    if ((await redis.get(onboardingReminderLockKey)) === lockToken) {
      await redis.del(onboardingReminderLockKey);
    }
  }
}

function formatReminderDiagnostics(
  diagnostics: OnboardingDetectionDiagnostics,
): string {
  return `registeredInspected=${diagnostics.registeredInspected} trackedInspected=${diagnostics.trackedInspected} queuedInspected=${diagnostics.queuedInspected} persistedInspected=${diagnostics.persistedInspected} pinnedInspected=${diagnostics.pinnedInspected} recentInspected=${diagnostics.recentInspected} validated=${diagnostics.validated} stalePruned=${diagnostics.stalePruned} failed=${diagnostics.failed}`;
}

function parseOnboardingReminderState(
  raw: Record<string, string>,
): OnboardingReminderState | undefined {
  const nextRunAt = Number(raw.nextRunAt);
  const armedAt = Number(raw.armedAt);
  if (
    raw.version !== onboardingReminderVersion ||
    !["pending", "processing", "complete"].includes(raw.status ?? "") ||
    !Number.isFinite(nextRunAt) ||
    !Number.isFinite(armedAt)
  ) {
    return undefined;
  }
  return {
    version: onboardingReminderVersion,
    status: raw.status as OnboardingReminderStatus,
    nextRunAt,
    armedAt,
    lifecycleSource:
      raw.lifecycleSource === "install" || raw.lifecycleSource === "upgrade"
        ? raw.lifecycleSource
        : "unknown",
    ...(raw.startedAt && Number.isFinite(Number(raw.startedAt))
      ? { startedAt: Number(raw.startedAt) }
      : {}),
    ...(raw.completedAt && Number.isFinite(Number(raw.completedAt))
      ? { completedAt: Number(raw.completedAt) }
      : {}),
    ...(raw.postId ? { postId: raw.postId } : {}),
    ...(isExistingSource(raw.existingSource)
      ? { existingSource: raw.existingSource }
      : {}),
    ...(isResult(raw.result) ? { result: raw.result } : {}),
    ...(raw.errorMessage ? { errorMessage: raw.errorMessage } : {}),
  };
}

function isExistingSource(
  value: string | undefined,
): value is OnboardingExistingSource {
  return (
    value === "registered" ||
    value === "tracked" ||
    value === "queued" ||
    value === "persisted" ||
    value === "pinned" ||
    value === "recent"
  );
}

function isResult(
  value: string | undefined,
): value is OnboardingReminderResult {
  return value === "sent" || value === "existing" || value === "failed";
}

function serializeOnboardingReminderState(
  state: OnboardingReminderState,
): Record<string, string> {
  return {
    version: state.version,
    status: state.status,
    nextRunAt: String(state.nextRunAt),
    armedAt: String(state.armedAt),
    lifecycleSource: state.lifecycleSource,
    startedAt: String(state.startedAt ?? 0),
    completedAt: String(state.completedAt ?? 0),
    postId: state.postId ?? "",
    existingSource: state.existingSource ?? "",
    result: state.result ?? "",
    errorMessage: state.errorMessage ?? "",
  };
}

async function saveOnboardingReminderState(
  redis: RedisClient,
  state: OnboardingReminderState,
): Promise<void> {
  await redis.hSet(
    onboardingReminderStateKey,
    serializeOnboardingReminderState(state),
  );
}
