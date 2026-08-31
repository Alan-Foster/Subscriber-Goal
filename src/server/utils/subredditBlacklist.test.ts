import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheHelper } from "@devvit/web/server";
import {
  blacklistCacheTtlSeconds,
  isSubredditBlacklisted,
} from "./subredditBlacklist";

const passThroughCache: CacheHelper = async (loader) => await loader();

const createReddit = (content: unknown) => ({
  getWikiPage: vi.fn().mockResolvedValue(content),
});

describe("subreddit blacklist", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("matches names case-insensitively with whitespace and r/ normalization", async () => {
    const reddit = createReddit({
      content: JSON.stringify([{ name: " R/Rape " }, { name: "incest" }]),
    });

    await expect(
      isSubredditBlacklisted(reddit as never, "rape", {
        cacheHelper: passThroughCache,
      }),
    ).resolves.toBe(true);
    await expect(
      isSubredditBlacklisted(reddit as never, "r/INCEST", {
        cacheHelper: passThroughCache,
      }),
    ).resolves.toBe(true);
    await expect(
      isSubredditBlacklisted(reddit as never, "AllowedSub", {
        cacheHelper: passThroughCache,
      }),
    ).resolves.toBe(false);
  });

  it.each([
    ["malformed JSON", { content: "not-json" }],
    ["invalid root schema", { content: JSON.stringify({ name: "rape" }) }],
    ["invalid entry schema", { content: JSON.stringify([{ name: "" }]) }],
    ["missing content", undefined],
  ])("fails open for %s", async (_label, page) => {
    const reddit = createReddit(page);

    await expect(
      isSubredditBlacklisted(reddit as never, "rape", {
        cacheHelper: passThroughCache,
      }),
    ).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it("fails open when the wiki request rejects", async () => {
    const reddit = {
      getWikiPage: vi.fn().mockRejectedValue(new Error("unavailable")),
    };

    await expect(
      isSubredditBlacklisted(reddit as never, "rape", {
        cacheHelper: passThroughCache,
      }),
    ).resolves.toBe(false);
  });

  it("fails open when the wiki request times out", async () => {
    const reddit = { getWikiPage: vi.fn(() => new Promise(() => undefined)) };

    await expect(
      isSubredditBlacklisted(reddit as never, "rape", {
        cacheHelper: passThroughCache,
        timeoutMs: 1,
      }),
    ).resolves.toBe(false);
  });

  it("requests a five-minute cache and reuses the cached list", async () => {
    const values = new Map<string, unknown>();
    const cacheHelper: CacheHelper = async (loader, options) => {
      if (!values.has(options.key)) {
        values.set(options.key, await loader());
      }
      return values.get(options.key) as never;
    };
    const reddit = createReddit({
      content: JSON.stringify([{ name: "rape" }]),
    });

    await isSubredditBlacklisted(reddit as never, "rape", { cacheHelper });
    await isSubredditBlacklisted(reddit as never, "rape", { cacheHelper });

    expect(reddit.getWikiPage).toHaveBeenCalledTimes(1);
    expect(reddit.getWikiPage).toHaveBeenCalledWith("SubGoal", "blacklist");
    expect(blacklistCacheTtlSeconds).toBe(300);
  });

  it("fails open when the cache service rejects", async () => {
    const reddit = createReddit({
      content: JSON.stringify([{ name: "rape" }]),
    });
    const cacheHelper: CacheHelper = vi
      .fn()
      .mockRejectedValue(new Error("cache unavailable"));

    await expect(
      isSubredditBlacklisted(reddit as never, "rape", { cacheHelper }),
    ).resolves.toBe(false);
    expect(reddit.getWikiPage).not.toHaveBeenCalled();
  });
});
