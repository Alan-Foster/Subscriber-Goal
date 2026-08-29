import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import { subGoalLanguages } from "../../shared/subGoalPostI18n";
import type { SubGoalPostHeight } from "../../shared/subGoalPostHeight";
import { subGoalPostHeights } from "../../shared/subGoalPostHeight";
import type { SubGoalColorTheme } from "../../shared/subGoalColorTheme";
import { isSubGoalColorTheme } from "../../shared/subGoalColorTheme";
import {
  isAfterSubscribePreset,
  type AfterSubscribePreset,
} from "../../shared/afterSubscribeAction";
import type { RedisClient } from "../types";

export const createGoalDraftExpirationMs = 30 * 60 * 1000;

type CreateGoalDraftBase = {
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

export type CreateGoalDraftDetails =
  | SubscriberGoalDraftDetails
  | SubscribeOnlyDraftDetails;

export type CreateGoalDraft =
  | ({ version: 4; stage: "details" } & CreateGoalDraftBase)
  | ({
      version: 4;
      stage: "follow-up";
      details: CreateGoalDraftDetails;
    } & CreateGoalDraftBase);

export type CreateGoalDraftInput =
  | ({ stage: "details" } & CreateGoalDraftBase)
  | ({
      stage: "follow-up";
      details: CreateGoalDraftDetails;
    } & CreateGoalDraftBase);

export function getCreateGoalDraftKey(userId: string): string {
  return `create_goal_draft:${userId}`;
}

export async function saveCreateGoalDraft(
  redis: RedisClient,
  userId: string,
  draft: CreateGoalDraftInput,
): Promise<void> {
  const value: CreateGoalDraft = { version: 4, ...draft };
  await redis.set(getCreateGoalDraftKey(userId), JSON.stringify(value), {
    expiration: new Date(Date.now() + createGoalDraftExpirationMs),
  });
}

export async function getCreateGoalDraft(
  redis: RedisClient,
  userId: string,
): Promise<CreateGoalDraft | null> {
  const rawDraft = await redis.get(getCreateGoalDraftKey(userId));
  if (!rawDraft) {
    return null;
  }

  try {
    const draft = JSON.parse(rawDraft) as Partial<CreateGoalDraft>;
    return isCreateGoalDraft(draft) ? draft : null;
  } catch {
    return null;
  }
}

export async function deleteCreateGoalDraft(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(getCreateGoalDraftKey(userId));
}

function isCreateGoalDraft(
  value: Partial<CreateGoalDraft>,
): value is CreateGoalDraft {
  if (
    value.version !== 4 ||
    !subGoalLanguages.includes(value.language as SubGoalLanguage) ||
    !subGoalPostHeights.includes(value.postHeight as SubGoalPostHeight) ||
    typeof value.subredditDisplayName !== "string" ||
    value.subredditDisplayName.length === 0 ||
    typeof value.customDeveloperField !== "string"
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
  return isSubscriberGoalDetails(value.details);
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
