import { context, reddit, redis } from '@devvit/web/server';
export type DevvitContext = typeof context;
export type RedditClient = typeof reddit;
export type RedisClient = typeof redis;
export type SettingsClient = {
    getAll<T>(): Promise<Partial<T>>;
};
