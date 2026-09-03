import { context, reddit, redis } from "@devvit/web/server";
import { ensureSavedSubredditDisplayName } from "../data/subredditDisplayNameData";
import { initializeRecentSubscriberIndexMigration } from "../data/subGoalData";
import {
  clearLegacySubscriberErasureTombstones,
  initializeSubscriberStatsMigration,
} from "../data/subscriberStats";
import { getTrackedPosts, queueUpdates } from "../data/updaterData";
import { initializePostKindMigration } from "../data/postKindMigration";
import { initializeLegacyAfterSubscribeActionMigration } from "../data/legacyAfterSubscribeActionMigration";
import { initializeOnboardingSubscriberGoal } from "../core/onboardingSubscriberGoal";
import { scheduleOnboardingReminder } from "../core/onboardingReminder";
import {
  backfillSubscriberGoalPostFlair,
  ensureSubscriberGoalPostFlair,
} from "../core/subscriberGoalPostFlair";
import { getSubscriberGoalCandidatePostIds } from "../data/subscriberGoalCandidates";
import { reconcileSubscriberGoalStickies } from "../utils/redditUtils";

export async function onAppChanged({
  lifecycleSource = "unknown",
}: {
  lifecycleSource?: "install" | "upgrade" | "unknown";
} = {}): Promise<void> {
  if (!context.subredditName && !context.subredditId) {
    console.info(
      "[appChanged] skipping subreddit setup: no subreddit context on lifecycle trigger",
    );
    return;
  }

  let subredditName = context.subredditName;
  if (!subredditName) {
    try {
      const subreddit = await reddit.getCurrentSubreddit();
      subredditName = subreddit.name;
    } catch (error) {
      console.warn(
        `[appChanged] skipping subreddit setup: failed to resolve current subreddit (${String(error)})`,
      );
      return;
    }
  }

  await ensureSavedSubredditDisplayName(redis, subredditName);
  await clearLegacySubscriberErasureTombstones(redis);
  await initializeSubscriberStatsMigration(redis);
  await initializeOnboardingSubscriberGoal(redis, { lifecycleSource });
  await scheduleOnboardingReminder(redis, { lifecycleSource });
  await initializeRecentSubscriberIndexMigration(redis);

  let lifecycleSubreddit:
    | { id: string; name: string }
    | undefined = context.subredditId
    ? { id: context.subredditId, name: subredditName }
    : undefined;
  if (!lifecycleSubreddit) {
    try {
      lifecycleSubreddit = await reddit.getCurrentSubreddit();
    } catch (error) {
      console.warn(
        `[appChanged] Subscriber Goal post repair could not resolve subreddit: ${String(error)}`,
      );
    }
  }

  let candidatePostIds: string[] | undefined;
  try {
    candidatePostIds = await getSubscriberGoalCandidatePostIds(redis);
  } catch (error) {
    console.warn(
      `[appChanged] failed to discover Subscriber Goal repair candidates: ${String(error)}`,
    );
  }

  let flairId: string | undefined;
  try {
    flairId = (await ensureSubscriberGoalPostFlair(reddit, subredditName)).id;
  } catch (error) {
    console.warn(
      `[appChanged] failed to ensure Subscriber Goal post flair: subreddit=${subredditName} error=${String(error)}`,
    );
  }
  if (lifecycleSubreddit && candidatePostIds && flairId) {
    try {
      await backfillSubscriberGoalPostFlair(
        reddit,
        lifecycleSubreddit,
        candidatePostIds,
        flairId,
      );
    } catch (error) {
      console.warn(
        `[appChanged] failed to backfill Subscriber Goal post flair: subreddit=${subredditName} error=${String(error)}`,
      );
    }
  }
  if (lifecycleSubreddit && candidatePostIds) {
    try {
      const result = await reconcileSubscriberGoalStickies(reddit, {
        knownPostIds: candidatePostIds,
        subreddit: lifecycleSubreddit,
      });
      console.info(
        `[appChanged] Subscriber Goal pin reconciliation: kept=${result.keptPostId ?? "none"} unstickied=${result.unstickied.length} failed=${result.failed.length}`,
      );
    } catch (error) {
      console.warn(
        `[appChanged] failed to reconcile Subscriber Goal pins: subreddit=${subredditName} error=${String(error)}`,
      );
    }
  }

  const trackedPosts = await getTrackedPosts(redis);
  await initializePostKindMigration(redis, trackedPosts);
  await initializeLegacyAfterSubscribeActionMigration(redis, trackedPosts);
  if (!trackedPosts.length) {
    return;
  }
  console.log(`Scheduling update queue for: ${trackedPosts.join(",")}`);
  await queueUpdates(redis, trackedPosts);
}
