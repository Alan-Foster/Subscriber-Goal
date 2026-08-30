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

  const trackedPosts = await getTrackedPosts(redis);
  await initializePostKindMigration(redis, trackedPosts);
  await initializeLegacyAfterSubscribeActionMigration(redis, trackedPosts);
  if (!trackedPosts.length) {
    return;
  }
  console.log(`Scheduling update queue for: ${trackedPosts.join(",")}`);
  await queueUpdates(redis, trackedPosts);
}
