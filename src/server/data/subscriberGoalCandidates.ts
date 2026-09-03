import type { RedisClient } from "../types";
import {
  postGoalSuffix,
  postHeightSuffix,
  postKindSuffix,
  subscriberGoalsKey,
} from "./subGoalData";
import { getRegisteredSubscriberGoalPosts } from "./subscriberGoalPostRegistry";
import { getQueuedUpdates, getTrackedPosts } from "./updaterData";
import {
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";

export async function getSubscriberGoalCandidatePostIds(
  redis: RedisClient,
): Promise<string[]> {
  const [registered, tracked, queued, persisted] = await Promise.all([
    getRegisteredSubscriberGoalPosts(redis),
    getTrackedPosts(redis),
    getQueuedUpdates(redis),
    getPersistedSubscriberGoalPostIds(redis),
  ]);
  return [...new Set([...registered, ...tracked, ...queued, ...persisted])];
}

export async function getPersistedSubscriberGoalPostIds(
  redis: RedisClient,
): Promise<string[]> {
  const postIds = new Set<string>();
  let cursor = 0;
  do {
    const page = await redis.hScan(subscriberGoalsKey, cursor, undefined, 500);
    cursor = page.cursor;
    for (const { field, value } of page.fieldValues) {
      if (
        field.endsWith(postKindSuffix) &&
        (value === subscriberGoalPostKind || value === subscribeOnlyPostKind)
      ) {
        postIds.add(field.slice(0, -postKindSuffix.length));
      } else if (
        field.endsWith(postGoalSuffix) &&
        Number.isFinite(Number(value)) &&
        Number(value) > 0
      ) {
        postIds.add(field.slice(0, -postGoalSuffix.length));
      } else if (field.endsWith(postHeightSuffix) && value === "tiny") {
        postIds.add(field.slice(0, -postHeightSuffix.length));
      }
    }
  } while (cursor !== 0);
  return [...postIds];
}
