import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import { subGoalLanguages } from "../../shared/subGoalPostI18n";
import { logDiagnostic } from "../../shared/diagnostics";
import type { SubGoalPostHeight } from "../../shared/subGoalPostHeight";
import { subGoalPostHeights } from "../../shared/subGoalPostHeight";
import type { SubGoalColorTheme } from "../../shared/subGoalColorTheme";
import { isSubGoalColorTheme } from "../../shared/subGoalColorTheme";
import {
  isAfterSubscribePreset,
  type AfterSubscribePreset,
} from "../../shared/afterSubscribeAction";
import type { RedisClient } from "../types";
import { releaseOwnedRedisLock } from "../utils/redisOwnedLock";

export const createGoalDraftExpirationMs = 30 * 60 * 1000;
export const createGoalDraftLeaseExpirationMs = 15 * 60 * 1000;
export const devvitWebMaximumRequestMs = 30 * 1000;

// Devvit Web endpoints have a 30-second request limit. The lease is 30x longer.
// https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_overview
if (createGoalDraftLeaseExpirationMs <= devvitWebMaximumRequestMs) {
  throw new Error("create_goal_draft_lease_too_short");
}

type CreateGoalDraftBase = {
  creationAttemptId: string;
  language: SubGoalLanguage;
  postHeight: SubGoalPostHeight;
  subredditDisplayName: string;
  customDeveloperField: string;
};

export type SubscriberGoalDraftDetails = {
  kind: "subscriber-goal";
  postTitle: string;
  subscriberGoal: number;
  colorTheme: SubGoalColorTheme;
  crosspost: boolean;
  afterSubscribePreset: AfterSubscribePreset;
  autoCreateNextGoal: boolean;
};

export type SubscribeOnlyDraftDetails = {
  kind: "subscribe-only";
  postTitle: string;
  colorTheme: SubGoalColorTheme;
  afterSubscribePreset: AfterSubscribePreset;
};

export type CtaOnlyDraftDetails = {
  kind: "cta-only";
  postTitle: string;
  afterSubscribePreset: AfterSubscribePreset;
};

export type CreateGoalDraftDetails =
  SubscriberGoalDraftDetails | SubscribeOnlyDraftDetails | CtaOnlyDraftDetails;

export type CreateGoalDraft =
  | {
      version: 5;
      stage: "setup";
      creationAttemptId: string;
    }
  | ({ version: 5; stage: "details" } & CreateGoalDraftBase)
  | ({
      version: 5;
      stage: "follow-up";
      details: CreateGoalDraftDetails;
    } & CreateGoalDraftBase);

export type CreateGoalDraftInput =
  | { stage: "setup"; creationAttemptId: string }
  | ({ stage: "details" } & CreateGoalDraftBase)
  | ({
      stage: "follow-up";
      details: CreateGoalDraftDetails;
    } & CreateGoalDraftBase);

export function getCreateGoalDraftKey(
  userId: string,
  creationAttemptId: string,
): string {
  return `create_goal_draft_v5:${userId}:${creationAttemptId}`;
}

export function getCreateGoalDraftLeaseKey(
  userId: string,
  creationAttemptId: string,
): string {
  return `${getCreateGoalDraftKey(userId, creationAttemptId)}:lease`;
}

export async function saveCreateGoalDraft(
  redis: RedisClient,
  userId: string,
  draft: CreateGoalDraftInput,
): Promise<void> {
  if (!isCreationAttemptId(draft.creationAttemptId)) {
    throw new Error("invalid_creation_attempt_id");
  }
  const value: CreateGoalDraft = { version: 5, ...draft };
  await redis.set(
    getCreateGoalDraftKey(userId, draft.creationAttemptId),
    JSON.stringify(value),
    {
      expiration: new Date(Date.now() + createGoalDraftExpirationMs),
    },
  );
}

export async function getCreateGoalDraft(
  redis: RedisClient,
  userId: string,
  creationAttemptId: string,
): Promise<CreateGoalDraft | null> {
  if (!isCreationAttemptId(creationAttemptId)) return null;
  const rawDraft = await redis.get(
    getCreateGoalDraftKey(userId, creationAttemptId),
  );
  if (!rawDraft) {
    return null;
  }

  try {
    const draft = JSON.parse(rawDraft) as Partial<CreateGoalDraft>;
    if (
      isCreateGoalDraft(draft) &&
      draft.creationAttemptId === creationAttemptId
    ) {
      return draft;
    }
    logDiagnostic("warn", "persisted_json_invalid", {
      workflow: "create_goal_draft",
      phase: "schema_validation",
    });
    return null;
  } catch (error) {
    logDiagnostic(
      "warn",
      "persisted_json_invalid",
      { workflow: "create_goal_draft", phase: "json_decode" },
      error,
    );
    return null;
  }
}

export async function deleteCreateGoalDraft(
  redis: RedisClient,
  userId: string,
  creationAttemptId: string,
): Promise<void> {
  if (!isCreationAttemptId(creationAttemptId)) {
    throw new Error("invalid_creation_attempt_id");
  }
  await redis.del(getCreateGoalDraftKey(userId, creationAttemptId));
}

export class CreateGoalDraftLeaseInProgressError extends Error {
  constructor() {
    super(
      "A form submission for this creation attempt is already in progress.",
    );
    this.name = "CreateGoalDraftLeaseInProgressError";
  }
}

export async function withCreateGoalDraftLease<T>(
  redis: RedisClient,
  userId: string,
  creationAttemptId: string,
  callback: () => Promise<T>,
): Promise<T> {
  if (!isCreationAttemptId(creationAttemptId)) {
    throw new Error("invalid_creation_attempt_id");
  }
  const key = getCreateGoalDraftLeaseKey(userId, creationAttemptId);
  const token = createLeaseToken();
  await redis.set(key, token, {
    nx: true,
    expiration: new Date(Date.now() + createGoalDraftLeaseExpirationMs),
  });
  if ((await redis.get(key)) !== token) {
    throw new CreateGoalDraftLeaseInProgressError();
  }

  try {
    return await callback();
  } finally {
    try {
      await releaseOwnedRedisLock(redis, key, token);
    } catch (error) {
      logDiagnostic(
        "warn",
        "create_goal_draft_lease_release_failed",
        { workflow: "create_goal_draft", phase: "lease_release" },
        error,
      );
    }
  }
}

function createLeaseToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isCreateGoalDraft(
  value: Partial<CreateGoalDraft>,
): value is CreateGoalDraft {
  if (value.version !== 5 || !isCreationAttemptId(value.creationAttemptId)) {
    return false;
  }
  if (value.stage === "setup") {
    return true;
  }
  const detailed = value as Partial<
    Extract<CreateGoalDraft, { stage: "details" | "follow-up" }>
  >;
  if (
    !subGoalLanguages.includes(detailed.language as SubGoalLanguage) ||
    !subGoalPostHeights.includes(detailed.postHeight as SubGoalPostHeight) ||
    typeof detailed.subredditDisplayName !== "string" ||
    detailed.subredditDisplayName.length === 0 ||
    typeof detailed.customDeveloperField !== "string"
  ) {
    return false;
  }
  if (value.stage === "details") {
    return true;
  }
  if (value.stage !== "follow-up" || !value.details) {
    return false;
  }
  if (value.postHeight === "tiny") {
    return isSubscribeOnlyDetails(value.details);
  }
  if (value.postHeight === "cta") {
    return isCtaOnlyDetails(value.details);
  }
  return isSubscriberGoalDetails(value.details);
}

export function isCreationAttemptId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isSubscriberGoalDetails(
  value: CreateGoalDraftDetails,
): value is SubscriberGoalDraftDetails {
  return (
    value.kind === "subscriber-goal" &&
    typeof value.postTitle === "string" &&
    value.postTitle.length > 0 &&
    typeof value.subscriberGoal === "number" &&
    Number.isFinite(value.subscriberGoal) &&
    value.subscriberGoal > 0 &&
    isSubGoalColorTheme(value.colorTheme) &&
    typeof value.crosspost === "boolean" &&
    isAfterSubscribePreset(value.afterSubscribePreset) &&
    typeof value.autoCreateNextGoal === "boolean"
  );
}

function isSubscribeOnlyDetails(
  value: CreateGoalDraftDetails,
): value is SubscribeOnlyDraftDetails {
  return (
    value.kind === "subscribe-only" &&
    typeof value.postTitle === "string" &&
    value.postTitle.length > 0 &&
    isSubGoalColorTheme(value.colorTheme) &&
    isAfterSubscribePreset(value.afterSubscribePreset)
  );
}

function isCtaOnlyDetails(
  value: CreateGoalDraftDetails,
): value is CtaOnlyDraftDetails {
  return (
    value.kind === "cta-only" &&
    typeof value.postTitle === "string" &&
    value.postTitle.length > 0 &&
    isAfterSubscribePreset(value.afterSubscribePreset)
  );
}
