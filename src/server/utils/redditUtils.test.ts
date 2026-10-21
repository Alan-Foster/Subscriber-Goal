import { describe, expect, it, vi } from "vitest";
import { getSubredditIcon, safeGetWikiPageRevisions } from "./redditUtils";
import * as crosspostLogs from "./crosspostLogs";

const passthroughCache = vi.fn(async (loader: () => Promise<unknown>) =>
  loader(),
);

describe("getSubredditIcon", () => {
  it("returns subreddit settings community icon when available", async () => {
    const reddit = {
      getSubredditStyles: vi.fn(),
    };

    const icon = await getSubredditIcon(
      reddit as unknown as Parameters<typeof getSubredditIcon>[0],
      "t5_abc123",
      { communityIcon: "https://example.com/settings-community-icon.png" },
    );

    expect(icon).toBe("https://example.com/settings-community-icon.png");
    expect(reddit.getSubredditStyles).not.toHaveBeenCalled();
  });

  it("returns subreddit style icon when available", async () => {
    const reddit = {
      getSubredditStyles: vi.fn(async () => ({
        icon: "https://example.com/icon.png",
      })),
    };

    const icon = await getSubredditIcon(
      reddit as unknown as Parameters<typeof getSubredditIcon>[0],
      "t5_abc123",
      undefined,
      "/reddit_temp_logo.jpg",
      passthroughCache as Parameters<typeof getSubredditIcon>[4],
    );

    expect(icon).toBe("https://example.com/icon.png");
    expect(reddit.getSubredditStyles).toHaveBeenCalledWith("t5_abc123");
  });

  it("returns local fallback when style icon is missing", async () => {
    const reddit = {
      getSubredditStyles: vi.fn(async () => ({
        icon: undefined,
      })),
    };

    const icon = await getSubredditIcon(
      reddit as unknown as Parameters<typeof getSubredditIcon>[0],
      "t5_abc123",
      undefined,
      "/reddit_temp_logo.jpg",
      passthroughCache as Parameters<typeof getSubredditIcon>[4],
    );

    expect(icon).toBe("/reddit_temp_logo.jpg");
    expect(reddit.getSubredditStyles).toHaveBeenCalledWith("t5_abc123");
  });

  it("returns local fallback for invalid subreddit id", async () => {
    const reddit = {
      getSubredditStyles: vi.fn(),
    };

    const icon = await getSubredditIcon(
      reddit as unknown as Parameters<typeof getSubredditIcon>[0],
      "not_a_subreddit_id",
    );

    expect(icon).toBe("/reddit_temp_logo.jpg");
    expect(reddit.getSubredditStyles).not.toHaveBeenCalled();
  });

  it("caches style lookups for one hour with a subreddit-specific key", async () => {
    const reddit = {
      getSubredditStyles: vi.fn(async () => ({
        icon: "https://example.com/cached-icon.png",
      })),
    };
    const values = new Map<string, unknown>();
    const cacheHelper = vi.fn(
      async (
        loader: () => Promise<unknown>,
        options: { key: string; ttl: number },
      ) => {
        if (!values.has(options.key)) values.set(options.key, await loader());
        return values.get(options.key);
      },
    );

    const args = [
      reddit as unknown as Parameters<typeof getSubredditIcon>[0],
      "t5_abc123",
      undefined,
      "/reddit_temp_logo.jpg",
      cacheHelper as Parameters<typeof getSubredditIcon>[4],
    ] as const;
    await getSubredditIcon(...args);
    await getSubredditIcon(...args);
    await getSubredditIcon(
      reddit as unknown as Parameters<typeof getSubredditIcon>[0],
      "t5_other",
      undefined,
      "/reddit_temp_logo.jpg",
      cacheHelper as Parameters<typeof getSubredditIcon>[4],
    );

    expect(reddit.getSubredditStyles).toHaveBeenCalledTimes(2);
    expect(cacheHelper).toHaveBeenCalledWith(expect.any(Function), {
      key: "subgoal:subreddit-icon:v1:t5_abc123",
      ttl: 3600,
    });
    expect(cacheHelper).toHaveBeenCalledWith(expect.any(Function), {
      key: "subgoal:subreddit-icon:v1:t5_other",
      ttl: 3600,
    });
  });
});

describe("safeGetWikiPageRevisions", () => {
  it("does not emit routine start or success crosspost logs on successful fetch", async () => {
    const logSpy = vi.spyOn(crosspostLogs, "logCrosspostEvent");
    const listing = {
      get: vi.fn(async () => [
        {
          id: "rev_1",
          reason: "Post t3_abc123 with goal 69",
          date: 1_776_433_730,
        },
      ]),
    };
    const reddit = {
      getWikiPageRevisions: vi.fn(() => listing),
    };

    const result = await safeGetWikiPageRevisions(
      reddit as unknown as Parameters<typeof safeGetWikiPageRevisions>[0],
      "PythiaSpeaks",
      "post",
    );

    expect(result.ok).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("normalizes numeric revision dates expressed in seconds to milliseconds", async () => {
    const listing = {
      get: vi.fn(async () => [
        {
          id: "rev_1",
          reason: "Post t3_abc123 with goal 69",
          date: 1_776_433_730,
        },
      ]),
    };
    const reddit = {
      getWikiPageRevisions: vi.fn(() => listing),
    };

    const result = await safeGetWikiPageRevisions(
      reddit as unknown as Parameters<typeof safeGetWikiPageRevisions>[0],
      "PythiaSpeaks",
      "post",
    );

    expect(result.ok).toBe(true);
    expect(result.revisions).toEqual([
      {
        id: "rev_1",
        reason: "Post t3_abc123 with goal 69",
        dateMs: 1_776_433_730_000,
      },
    ]);
  });

  it("emits an error crosspost log when wiki fetch fails", async () => {
    const logSpy = vi.spyOn(crosspostLogs, "logCrosspostEvent");
    const listing = {
      get: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const reddit = {
      getWikiPageRevisions: vi.fn(() => listing),
    };

    const result = await safeGetWikiPageRevisions(
      reddit as unknown as Parameters<typeof safeGetWikiPageRevisions>[0],
      "PythiaSpeaks",
      "post",
    );

    expect(result.ok).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "wiki_fetch_failed",
        targetSubreddit: "PythiaSpeaks",
        page: "post",
        reason: "fetch_wiki_revisions",
        errorMessage: "boom",
      }),
      "error",
    );
    logSpy.mockRestore();
  });
});
