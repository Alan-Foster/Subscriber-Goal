import type { RedisClient } from '../types';
import type { BasicUserData } from './basicData';
export declare const subscriberStatsKey = "subscriber_stats";
export type SubscriberStats = {
    id: string;
    username: string;
    timestamp: number;
    subscribers: number;
};
export declare function isSubscriberStats(object: unknown): object is SubscriberStats;
export declare function getSubscriberStats(redis: RedisClient, userId: string): Promise<SubscriberStats | undefined>;
export declare function isTrackedSubscriber(redis: RedisClient, userId: string): Promise<boolean>;
export declare function setNewSubscriber(redis: RedisClient, postId: string, currentSubscribers: number, user: BasicUserData, shareUsername: boolean): Promise<boolean>;
export declare function untrackSubscriberById(redis: RedisClient, userId: string): Promise<void>;
export declare function untrackSubscriberByUsername(redis: RedisClient, username: string): Promise<void>;
