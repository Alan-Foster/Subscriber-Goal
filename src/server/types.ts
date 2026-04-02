import { context, reddit, redis } from '@devvit/web/server';

export type DevvitContext = typeof context;
export type RedditClient = typeof reddit;
export type RedisClient = typeof redis;

export type CommentId = `t1_${string}`;
export type LinkId = `t3_${string}`;
export type SubredditId = `t5_${string}`;
export type ThingId = CommentId | LinkId;

export const isLinkId = (id: string): id is LinkId => /^t3_[\w\d]+$/.test(id);
export const isCommentId = (id: string): id is CommentId => /^t1_[\w\d]+$/.test(id);
export const isThingId = (id: string): id is ThingId => isLinkId(id) || isCommentId(id);
export const isSubredditId = (id: string): id is SubredditId => /^t5_[\w\d]+$/.test(id);

export type SettingsClient = {
  getAll<T>(): Promise<Partial<T>>;
};
