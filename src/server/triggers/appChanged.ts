import { reddit, redis } from '@devvit/web/server';
import { ensureSavedSubredditDisplayName } from '../data/subredditDisplayNameData';
import { getTrackedPosts, queueUpdates } from '../data/updaterData';

export async function onAppChanged(): Promise<void> {
  const subreddit = await reddit.getCurrentSubreddit();
  await ensureSavedSubredditDisplayName(redis, subreddit.name);

  const trackedPosts = await getTrackedPosts(redis);
  if (!trackedPosts.length) {
    return;
  }
  console.log(`Scheduling update queue for: ${trackedPosts.join(',')}`);
  await queueUpdates(redis, trackedPosts);
}
