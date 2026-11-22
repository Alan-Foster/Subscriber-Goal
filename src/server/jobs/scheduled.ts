import type { ServerAppSettings } from "../settings";
import type { RedditClient, RedisClient } from "../types";
import { createAppRepairJob } from "../core/appRepair";
import { createSourcePostDeletionJob } from "../core/sourcePostDeletion";
import { dispatchDueJobs } from "./runner";

export async function dispatchScheduledJobs(
  reddit: RedditClient,
  redis: RedisClient,
  appSettings: ServerAppSettings,
  deadlineMs: number,
): Promise<void> {
  await dispatchDueJobs(
    redis,
    [
      createAppRepairJob(reddit, redis),
      createSourcePostDeletionJob(reddit, redis, appSettings),
    ],
    { deadlineMs },
  );
}
