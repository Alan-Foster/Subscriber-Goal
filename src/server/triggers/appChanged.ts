import { context, reddit, redis } from '@devvit/web/server';
import { ensureSavedSubredditDisplayName } from '../data/subredditDisplayNameData';
import { getTrackedPosts, queueUpdates } from '../data/updaterData';

export async function onAppChanged(): Promise<void> {
  if (!context.subredditName && !context.subredditId) {
    console.info(
      '[appChanged] skipping subreddit setup: no subreddit context on lifecycle trigger'
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
        `[appChanged] skipping subreddit setup: failed to resolve current subreddit (${String(error)})`
      );
      return;
    }
  }

  await ensureSavedSubredditDisplayName(redis, subredditName);

  const trackedPosts = await getTrackedPosts(redis);
  if (!trackedPosts.length) {
    return;
  }
  console.log(`Scheduling update queue for: ${trackedPosts.join(',')}`);
  await queueUpdates(redis, trackedPosts);
}
