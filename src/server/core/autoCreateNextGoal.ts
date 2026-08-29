import type { ServerAppSettings } from '../settings';
import type { RedditClient, RedisClient } from '../types';
import {
  cancelAutoCreateNextGoal,
  getDueAutoCreateNextGoalPostIds,
  getSubGoalData
} from '../data/subGoalData';
import { getDefaultSubscriberGoal } from '../utils/numberUtils';
import { createSubscriberGoal } from './createSubscriberGoal';
import { getSubGoalPostMessages } from '../../shared/subGoalPostI18n';
import {
  getTerminalRemovedByCategory,
  isMissingPostError,
} from '../utils/postStatus';
import { isLinkId } from '../types';
import {
  getPostUrl,
  notifyStickyFailure,
} from '../utils/stickyFailureNotifications';

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
      if (!isLinkId(sourcePostId)) {
        summary.skipped += 1;
        console.info(
          `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=invalid_post_id`
        );
        continue;
      }

      const sourceGoalData = await getSubGoalData(redis, sourcePostId);
      if (
        !sourceGoalData.goal ||
        !sourceGoalData.completedTime ||
        !sourceGoalData.autoCreateNextGoal
      ) {
        summary.skipped += 1;
        continue;
      }

      try {
        const sourcePost = await reddit.getPostById(sourcePostId);
        const removedByCategory = getTerminalRemovedByCategory(sourcePost);
        if (removedByCategory) {
          summary.skipped += 1;
          console.info(
            `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=removedByCategory:${removedByCategory}`
          );
          continue;
        }
      } catch (sourcePostError) {
        if (isMissingPostError(sourcePostError)) {
          summary.skipped += 1;
          console.info(
            `[autoCreateNextGoal] skipping inactive source post: sourcePostId=${sourcePostId} reason=missing_post`
          );
          continue;
        }
        throw sourcePostError;
      }

      const subreddit = await reddit.getCurrentSubreddit();
      const subredditDisplayName = sourceGoalData.subredditDisplayName ?? subreddit.name;
      const messages = getSubGoalPostMessages(sourceGoalData.language);
      const sourceSubredditIsNsfw = (subreddit as { isNsfw?: boolean }).isNsfw === true;
      const crosspost =
        !sourceSubredditIsNsfw &&
        subreddit.name.toLowerCase() !== appSettings.promoSubreddit.toLowerCase();

      const { post, stickyResult } = await createSubscriberGoal({
        reddit,
        redis,
        appSettings,
        options: {
          title: messages.defaultPostTitle({ subredditName: subredditDisplayName }),
          goal: getDefaultSubscriberGoal(subreddit.numberOfSubscribers),
          subredditDisplayName,
          crosspost,
          colorTheme: sourceGoalData.colorTheme,
          postHeight: sourceGoalData.postHeight,
          autoCreateNextGoal: true,
          language: sourceGoalData.language,
          afterSubscribeAction: sourceGoalData.afterSubscribeAction,
          cancelPendingAutoCreateGoals: true
        }
      });
      if (stickyResult.status === 'not_pinned') {
        console.warn(
          `[autoCreateNextGoal] created next goal but failed to pin it: sourcePostId=${sourcePostId} postId=${post.id} subreddit=${subreddit.name} error=${stickyResult.errorMessage ?? 'none'}`
        );
        await notifyStickyFailure({
          reddit,
          subredditId: subreddit.id,
          subredditName: subreddit.name,
          postTitle: post.title,
          postUrl: getPostUrl(post),
          errorMessage: stickyResult.errorMessage,
        });
      }
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
