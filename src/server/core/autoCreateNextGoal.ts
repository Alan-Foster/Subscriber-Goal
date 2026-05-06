import type { ServerAppSettings } from '../settings';
import type { RedditClient, RedisClient } from '../types';
import {
  cancelAutoCreateNextGoal,
  getDueAutoCreateNextGoalPostIds,
  getSubGoalData
} from '../data/subGoalData';
import { getDefaultSubscriberGoal } from '../utils/numberUtils';
import { createSubscriberGoal } from './createSubscriberGoal';

export type AutoCreateNextGoalSummary = {
  due: number;
  created: number;
  skipped: number;
  failed: number;
};

export async function processDueAutoCreateNextGoals({
  reddit,
  redis,
  appSettings,
  nowMs = Date.now()
}: {
  reddit: RedditClient;
  redis: RedisClient;
  appSettings: ServerAppSettings;
  nowMs?: number;
}): Promise<AutoCreateNextGoalSummary> {
  const duePostIds = await getDueAutoCreateNextGoalPostIds(redis, nowMs);
  const summary: AutoCreateNextGoalSummary = {
    due: duePostIds.length,
    created: 0,
    skipped: 0,
    failed: 0
  };

  for (const sourcePostId of duePostIds) {
    try {
      const sourceGoalData = await getSubGoalData(redis, sourcePostId);
      if (
        !sourceGoalData.goal ||
        !sourceGoalData.completedTime ||
        !sourceGoalData.autoCreateNextGoal
      ) {
        summary.skipped += 1;
        continue;
      }

      const subreddit = await reddit.getCurrentSubreddit();
      const subredditDisplayName = sourceGoalData.subredditDisplayName ?? subreddit.name;
      const sourceSubredditIsNsfw = (subreddit as { isNsfw?: boolean }).isNsfw === true;
      const crosspost =
        !sourceSubredditIsNsfw &&
        subreddit.name.toLowerCase() !== appSettings.promoSubreddit.toLowerCase();

      await createSubscriberGoal({
        reddit,
        redis,
        appSettings,
        options: {
          title: `Welcome to r/${subredditDisplayName}!`,
          goal: getDefaultSubscriberGoal(subreddit.numberOfSubscribers),
          subredditDisplayName,
          crosspost,
          colorTheme: sourceGoalData.colorTheme,
          autoCreateNextGoal: true,
          cancelPendingAutoCreateGoals: true
        }
      });
      summary.created += 1;
      break;
    } catch (error) {
      summary.failed += 1;
      console.error(
        `Failed to auto-create next subscriber goal from ${sourcePostId}: ${String(error)}`
      );
    } finally {
      await cancelAutoCreateNextGoal(redis, sourcePostId);
    }
  }

  return summary;
}
