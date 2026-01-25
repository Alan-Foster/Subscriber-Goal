import type { RedditClient, RedisClient } from '../types';
import type { AppSettings } from '../settings';
export declare const subscriberGoalsKey = "subscriber_goals";
export declare const postGoalSuffix = "_goal";
export declare const postRecentSubscriberSuffix = "_recent_subscriber";
export declare const postCompletedTimeSuffix = "_completed_time";
export type SubGoalData = {
    goal: number;
    recentSubscriber: string | null;
    completedTime: number;
};
type RedditPost = Awaited<ReturnType<RedditClient['submitCustomPost']>>;
export declare function getSubGoalData(redis: RedisClient, postId: string): Promise<SubGoalData>;
export declare function setSubGoalData(redis: RedisClient, postId: string, data: SubGoalData): Promise<void>;
export declare function checkCompletionStatus(reddit: RedditClient, redis: RedisClient, postId: string): Promise<number>;
export declare function registerNewSubGoalPost(reddit: RedditClient, redis: RedisClient, appSettings: AppSettings, post: RedditPost, goal: number, crosspost: boolean): Promise<void>;
export declare function eraseFromRecentSubscribers(redis: RedisClient, username: string): Promise<void>;
export {};
