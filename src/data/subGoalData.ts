import {RedditAPIClient, RedisClient} from '@devvit/public-api';

export type SubGoalData = {
  goal: number;
  header: string;
  recentSubscriber: string | null;
  completedTime: number;
};

export async function getSubGoalData (redis: RedisClient, postId: string): Promise<SubGoalData> {
  const [goal, header, recentSubscriber, completedTime] = await redis.hMGet('subscriber_goals', [
    `${postId}_goal`,
    `${postId}_header`,
    `${postId}_recent_subscriber`,
    `${postId}_completed_time`,
  ]) as [string | null, string | null, string | null, string | null];
  return {
    goal: goal ? parseInt(goal) : 0,
    header: header ?? '',
    recentSubscriber: recentSubscriber ?? null,
    completedTime: completedTime ? parseInt(completedTime) : 0,
  };
}

export async function setSubGoalData (redis: RedisClient, postId: string, data: SubGoalData): Promise<void> {
  await redis.hSet('subscriber_goals', {
    [`${postId}_goal`]: data.goal.toString(),
    [`${postId}_header`]: data.header,
    [`${postId}_recent_subscriber`]: data.recentSubscriber ?? '',
    [`${postId}_completed_time`]: data.completedTime.toString(),
  });
}

export async function checkCompletionStatus (reddit: RedditAPIClient, redis: RedisClient, postId: string): Promise<number> {
  const subGoalData = await getSubGoalData(redis, postId);
  if (subGoalData.completedTime) {
    return subGoalData.completedTime;
  }

  const currentSubscribers = (await reddit.getCurrentSubreddit()).numberOfSubscribers;
  if (currentSubscribers >= subGoalData.goal) {
    subGoalData.completedTime = Date.now();
    await setSubGoalData(redis, postId, subGoalData);
    return subGoalData.completedTime;
  }
  return 0;
}

