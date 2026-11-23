import { reddit, redis } from "@devvit/web/server";

export type RedditClient = typeof reddit;
export type RedisClient = typeof redis;

export type LinkId = `t3_${string}`;
export type SubredditId = `t5_${string}`;

export const isLinkId = (id: string): id is LinkId => /^t3_[\w\d]+$/.test(id);
export const isSubredditId = (id: string): id is SubredditId =>
  /^t5_[\w\d]+$/.test(id);
