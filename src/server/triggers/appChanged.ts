import { redis } from '@devvit/web/server';
import { getTrackedPosts, queueUpdates } from '../data/updaterData';

export async function onAppChanged(): Promise<void> {
  const trackedPosts = await getTrackedPosts(redis);
  if (!trackedPosts.length) {
    return;
  }
  console.log(`Scheduling update queue for: ${trackedPosts.join(',')}`);
  await queueUpdates(redis, trackedPosts);
}
