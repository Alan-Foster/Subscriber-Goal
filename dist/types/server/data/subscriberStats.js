import { postRecentSubscriberSuffix, subscriberGoalsKey } from './subGoalData';
export const subscriberStatsKey = 'subscriber_stats';
export function isSubscriberStats(object) {
    if (!object || typeof object !== 'object') {
        return false;
    }
    const subStats = object;
    return (typeof subStats.id === 'string' &&
        typeof subStats.username === 'string' &&
        typeof subStats.timestamp === 'number' &&
        typeof subStats.subscribers === 'number');
}
const getMatchingSubscribers = async (redis, match) => {
    const allSubscribers = await redis.zRange(subscriberStatsKey, 0, -1);
    return allSubscribers.filter((record) => match(record.member));
};
export async function getSubscriberStats(redis, userId) {
    const foundSubscribers = await getMatchingSubscribers(redis, (member) => member.startsWith(`${userId}:`));
    if (foundSubscribers.length === 0) {
        return;
    }
    if (foundSubscribers.length > 1) {
        console.warn('Found multiple entries for user, this should not happen: ', JSON.stringify(foundSubscribers));
    }
    const [id, username, subscribers] = foundSubscribers[0].member.split(':');
    const subStats = {
        id,
        username,
        timestamp: foundSubscribers[0].score,
        subscribers: parseInt(subscribers),
    };
    if (!isSubscriberStats(subStats)) {
        console.error('Found invalid subscriber stats: ', JSON.stringify(foundSubscribers));
        return;
    }
    return subStats;
}
export async function isTrackedSubscriber(redis, userId) {
    const subscriberStats = await getSubscriberStats(redis, userId);
    return subscriberStats !== undefined;
}
export async function setNewSubscriber(redis, postId, currentSubscribers, user, shareUsername) {
    const alreadySubscribed = await isTrackedSubscriber(redis, user.id);
    if (alreadySubscribed) {
        return false;
    }
    await redis.hSet(subscriberGoalsKey, {
        [`${postId}${postRecentSubscriberSuffix}`]: shareUsername ? user.username : '',
    });
    await redis.zAdd(subscriberStatsKey, {
        member: `${user.id}:${user.username}:${currentSubscribers}`,
        score: Date.now(),
    });
    return true;
}
export async function untrackSubscriberById(redis, userId) {
    const foundRecords = await getMatchingSubscribers(redis, (member) => member.startsWith(`${userId}:`));
    if (foundRecords.length > 0) {
        await redis.zRem(subscriberStatsKey, foundRecords.map((record) => record.member));
    }
}
export async function untrackSubscriberByUsername(redis, username) {
    const matchToken = `:${username}:`;
    const foundRecords = await getMatchingSubscribers(redis, (member) => member.includes(matchToken));
    if (foundRecords.length > 0) {
        await redis.zRem(subscriberStatsKey, foundRecords.map((record) => record.member));
    }
}
//# sourceMappingURL=subscriberStats.js.map