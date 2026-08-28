import type { SubGoalLanguage } from "../../shared/subGoalPostI18n";
import { subGoalLanguages } from "../../shared/subGoalPostI18n";
import type { SubGoalPostHeight } from "../../shared/subGoalPostHeight";
import { subGoalPostHeights } from "../../shared/subGoalPostHeight";
import type { RedisClient } from "../types";

export const createGoalDraftExpirationMs = 30 * 60 * 1000;

export type CreateGoalDraft = {
  version: 1;
  language: SubGoalLanguage;
  postHeight: SubGoalPostHeight;
};

export function getCreateGoalDraftKey(userId: string): string {
  return `create_goal_draft:${userId}`;
}

export async function saveCreateGoalDraft(
  redis: RedisClient,
  userId: string,
  draft: Omit<CreateGoalDraft, "version">,
): Promise<void> {
  const value: CreateGoalDraft = { version: 1, ...draft };
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
    if (
      draft.version !== 1 ||
      !subGoalLanguages.includes(draft.language as SubGoalLanguage) ||
      !subGoalPostHeights.includes(draft.postHeight as SubGoalPostHeight)
    ) {
      return null;
    }
    return draft as CreateGoalDraft;
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
