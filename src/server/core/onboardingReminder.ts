import type { RedditClient, RedisClient } from "../types";
import {
  findExistingSubscriberGoal,
  type OnboardingLifecycleSource,
} from "./onboardingSubscriberGoal";

export const onboardingReminderStateKey = "onboarding_reminder_v1_state";
export const onboardingReminderLockKey = "onboarding_reminder_v1_lock";
export const onboardingReminderVersion = "onboarding_reminder_v1";
export const onboardingReminderDelayMs = 60 * 1000;

type OnboardingReminderStatus = "pending" | "processing" | "complete";
type OnboardingReminderResult = "sent" | "existing" | "failed";
type ExistingSource = "tracked" | "queued" | "pinned" | "recent";

export type OnboardingReminderState = {
  version: typeof onboardingReminderVersion;
  status: OnboardingReminderStatus;
  nextRunAt: number;
  armedAt: number;
  lifecycleSource: OnboardingLifecycleSource;
  startedAt?: number;
  completedAt?: number;
  postId?: string;
  existingSource?: ExistingSource;
  result?: OnboardingReminderResult;
  errorMessage?: string;
};

export type OnboardingReminderSummary = {
  status: "not_due" | "sent" | "existing" | "failed" | "complete";
  trackedInspected: number;
  pinnedInspected: number;
  recentInspected: number;
  postId?: string;
  existingSource?: ExistingSource;
  errorMessage?: string;
};

export type OnboardingReminderMessage = {
  subject: string;
  bodyMarkdown: string;
};

const emptySummary = (): Omit<OnboardingReminderSummary, "status"> => ({
  trackedInspected: 0,
  pinnedInspected: 0,
  recentInspected: 0,
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
      trackedInspected: existing.trackedInspected,
      pinnedInspected: existing.pinnedInspected,
      recentInspected: existing.recentInspected,
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
        `[onboardingReminder] complete: status=existing existingSource=${existingSource} postId=${existing.postId} trackedInspected=${inspected.trackedInspected} pinnedInspected=${inspected.pinnedInspected} recentInspected=${inspected.recentInspected}`,
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
      `[onboardingReminder] complete: status=sent trackedInspected=${inspected.trackedInspected} pinnedInspected=${inspected.pinnedInspected} recentInspected=${inspected.recentInspected}`,
    );
    return { status: "sent", ...inspected };
  } catch (error) {
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
      `[onboardingReminder] complete: status=failed error=${errorMessage} trackedInspected=${inspected.trackedInspected} pinnedInspected=${inspected.pinnedInspected} recentInspected=${inspected.recentInspected}`,
    );
    return { status: "failed", errorMessage, ...inspected };
  } finally {
    if ((await redis.get(onboardingReminderLockKey)) === lockToken) {
      await redis.del(onboardingReminderLockKey);
    }
  }
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

function isExistingSource(value: string | undefined): value is ExistingSource {
  return (
    value === "tracked" ||
    value === "queued" ||
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
