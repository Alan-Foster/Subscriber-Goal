import { dispatchNewPost } from './crosspostData';
import { queueUpdate, trackPost } from './updaterData';
export const subscriberGoalsKey = 'subscriber_goals';
export const postGoalSuffix = '_goal';
export const postRecentSubscriberSuffix = '_recent_subscriber';
export const postCompletedTimeSuffix = '_completed_time';
export async function getSubGoalData(redis, postId) {
    const [goal, recentSubscriber, completedTime] = (await redis.hMGet(subscriberGoalsKey, [
        `${postId}${postGoalSuffix}`,
        `${postId}${postRecentSubscriberSuffix}`,
        `${postId}${postCompletedTimeSuffix}`,
    ]));
    return {
        goal: goal ? parseInt(goal) : 0,
        recentSubscriber: recentSubscriber ?? null,
        completedTime: completedTime ? parseInt(completedTime) : 0,
    };
}
export async function setSubGoalData(redis, postId, data) {
    await redis.hSet(subscriberGoalsKey, {
        [`${postId}${postGoalSuffix}`]: data.goal.toString(),
        [`${postId}${postRecentSubscriberSuffix}`]: data.recentSubscriber ?? '',
        [`${postId}${postCompletedTimeSuffix}`]: data.completedTime.toString(),
    });
}
export async function checkCompletionStatus(reddit, redis, postId) {
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
export async function registerNewSubGoalPost(reddit, redis, appSettings, post, goal, crosspost) {
    await setSubGoalData(redis, post.id, {
        goal,
        recentSubscriber: '',
        completedTime: 0,
    });
    await trackPost(redis, post.id, post.createdAt);
    await queueUpdate(redis, post.id, post.createdAt);
    if (appSettings.promoSubreddit.toLowerCase() !== post.subredditName.toLowerCase() &&
        crosspost) {
        await dispatchNewPost(reddit, appSettings, post.id, goal);
    }
}
export async function eraseFromRecentSubscribers(redis, username) {
    const foundRecords = await redis.hGetAll(subscriberGoalsKey);
    const keysToUpdate = {};
    const normalized = username.toLowerCase();
    for (const key in foundRecords) {
        if (foundRecords[key].toLowerCase() === normalized &&
            key.endsWith(postRecentSubscriberSuffix)) {
            keysToUpdate[key] = '';
        }
    }
    if (Object.keys(keysToUpdate).length > 0) {
        await redis.hSet(subscriberGoalsKey, keysToUpdate);
    }
}
//# sourceMappingURL=subGoalData.js.map