import { cache, type CacheHelper } from "@devvit/web/server";
import { prohibitedContentMessage } from "../../shared/contentPolicy";
import type { RedditClient } from "../types";

export const blacklistSubredditName = "SubGoal";
export const blacklistWikiPage = "blacklist";
export const blacklistCacheTtlSeconds = 5 * 60;
export const blacklistFetchTimeoutMs = 10_000;

const blacklistCacheKey = "subgoal:central-subreddit-blacklist:v1";

type BlacklistOptions = {
  cacheHelper?: CacheHelper;
  timeoutMs?: number;
};

export class ProhibitedSubredditError extends Error {
  constructor() {
    super(prohibitedContentMessage);
    this.name = "ProhibitedSubredditError";
  }
}

export function normalizeSubredditName(value: string): string {
  return value.trim().replace(/^r\//i, "").toLowerCase();
}

export async function isSubredditBlacklisted(
  reddit: RedditClient,
  subredditName: string,
  options: BlacklistOptions = {},
): Promise<boolean> {
  const cacheHelper = options.cacheHelper ?? cache;
  try {
    const names = await cacheHelper(
      async () =>
        await fetchBlacklistNames(
          reddit,
          options.timeoutMs ?? blacklistFetchTimeoutMs,
        ),
      {
        key: blacklistCacheKey,
        ttl: blacklistCacheTtlSeconds,
      },
    );
    return names.includes(normalizeSubredditName(subredditName));
  } catch (error) {
    console.warn(
      `[blacklist] allowing content because the blacklist cache could not be read: ${String(error)}`,
    );
    return false;
  }
}

async function fetchBlacklistNames(
  reddit: RedditClient,
  timeoutMs: number,
): Promise<string[]> {
  try {
    const page = await withTimeout(
      reddit.getWikiPage(blacklistSubredditName, blacklistWikiPage),
      timeoutMs,
    );
    const content = page?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("Wiki page returned no content.");
    }

    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed) || !parsed.every(isBlacklistEntry)) {
      throw new Error("Wiki page JSON does not match the blacklist schema.");
    }

    return [...new Set(parsed.map(({ name }) => normalizeSubredditName(name)))];
  } catch (error) {
    console.warn(
      `[blacklist] allowing content because r/${blacklistSubredditName}/wiki/${blacklistWikiPage} could not be read: ${String(error)}`,
    );
    return [];
  }
}

function isBlacklistEntry(value: unknown): value is { name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "name" in value &&
    typeof value.name === "string" &&
    normalizeSubredditName(value.name).length > 0
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`Blacklist request timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
