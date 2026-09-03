import { describe, expect, it, vi } from "vitest";
import {
  clearSubscriberGoalStickies,
  clearUserStickies,
  getSubredditIcon,
  reconcileSubscriberGoalStickies,
  safeGetWikiPageRevisions,
  SubscriberGoalStickyCleanupError,
} from "./redditUtils";
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

const createPost = ({
  id = "t3_post",
  subredditId = "t5_abc123",
  authorName = "subscriber-goal",
  stickied = true,
  isStickied = vi.fn(() => stickied),
}: {
  id?: string;
  subredditId?: string;
  authorName?: string;
  stickied?: boolean;
  isStickied?: ReturnType<typeof vi.fn>;
} = {}) => ({
  id,
  subredditId,
  authorName,
  stickied,
  isStickied,
  unsticky: vi.fn(),
});

describe("clearUserStickies", () => {
  it("unstickies a known tracked app-owned post even when it is absent from hot posts", async () => {
    const knownPost = createPost({ id: "t3_known" });
    const reddit = {
      getPostById: vi.fn(async () => knownPost),
      getHotPosts: vi.fn(() => ({
        get: vi.fn(async () => []),
      })),
    };

    await clearUserStickies(
      reddit as unknown as Parameters<typeof clearUserStickies>[0],
      "subscriber-goal",
      {
        knownPostIds: ["t3_known"],
        subreddit: { id: "t5_abc123", name: "ExampleSub" },
      },
    );

    expect(reddit.getPostById).toHaveBeenCalledWith("t3_known");
    expect(knownPost.unsticky).toHaveBeenCalledOnce();
  });

  it("does not unsticky known posts owned by another author", async () => {
    const knownPost = createPost({ authorName: "other-mod" });
    const reddit = {
      getPostById: vi.fn(async () => knownPost),
      getHotPosts: vi.fn(() => ({
        get: vi.fn(async () => []),
      })),
    };

    await clearUserStickies(
      reddit as unknown as Parameters<typeof clearUserStickies>[0],
      "subscriber-goal",
      {
        knownPostIds: ["t3_known"],
        subreddit: { id: "t5_abc123", name: "ExampleSub" },
      },
    );

    expect(knownPost.unsticky).not.toHaveBeenCalled();
  });

  it("does not unsticky known posts from another subreddit", async () => {
    const knownPost = createPost({ subredditId: "t5_other" });
    const reddit = {
      getPostById: vi.fn(async () => knownPost),
      getHotPosts: vi.fn(() => ({
        get: vi.fn(async () => []),
      })),
    };

    await clearUserStickies(
      reddit as unknown as Parameters<typeof clearUserStickies>[0],
      "subscriber-goal",
      {
        knownPostIds: ["t3_known"],
        subreddit: { id: "t5_abc123", name: "ExampleSub" },
      },
    );

    expect(knownPost.unsticky).not.toHaveBeenCalled();
  });

  it("logs known-post refetch failures without blocking sticky cleanup", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const hotPost = createPost({ id: "t3_hot" });
    const reddit = {
      getPostById: vi.fn(async () => {
        throw new Error("missing");
      }),
      getHotPosts: vi.fn(() => ({
        get: vi.fn(async () => [hotPost]),
      })),
    };

    await clearUserStickies(
      reddit as unknown as Parameters<typeof clearUserStickies>[0],
      "subscriber-goal",
      {
        knownPostIds: ["t3_known"],
        subreddit: { id: "t5_abc123", name: "ExampleSub" },
      },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[sticky] failed to fetch known app-owned sticky candidate:",
      ),
    );
    expect(hotPost.unsticky).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

describe("Subscriber Goal sticky enforcement", () => {
  it("unstickies a trusted moderator-authored tiny goal and verifies removal", async () => {
    let pinned = true;
    const post = {
      id: "t3_tiny",
      subredditId: "t5_abc123",
      authorName: "community-mod",
      stickied: false,
      isStickied: vi.fn(() => pinned),
      unsticky: vi.fn(async () => {
        pinned = false;
      }),
    };
    const reddit = {
      getPostById: vi.fn(async () => post),
      getHotPosts: vi.fn(() => ({ get: vi.fn(async () => []) })),
    };

    const result = await clearSubscriberGoalStickies(reddit as never, {
      knownPostIds: ["t3_tiny"],
      subreddit: { id: "t5_abc123", name: "ExampleSub" },
    });

    expect(post.unsticky).toHaveBeenCalledOnce();
    expect(result.unstickied).toEqual(["t3_tiny"]);
  });

  it("never unsticks unrelated or cross-subreddit posts", async () => {
    const crossSubreddit = createPost({ subredditId: "t5_other" });
    const unrelated = createPost({ id: "t3_unrelated" });
    const reddit = {
      getPostById: vi.fn(async () => crossSubreddit),
      getHotPosts: vi.fn(() => ({ get: vi.fn(async () => [unrelated]) })),
    };

    await clearSubscriberGoalStickies(reddit as never, {
      knownPostIds: ["t3_known"],
      subreddit: { id: "t5_abc123", name: "ExampleSub" },
    });

    expect(crossSubreddit.unsticky).not.toHaveBeenCalled();
    expect(unrelated.unsticky).not.toHaveBeenCalled();
  });

  it("throws a typed blocking error when an old goal remains pinned", async () => {
    const post = createPost();
    const reddit = {
      getPostById: vi.fn(async () => post),
      getHotPosts: vi.fn(() => ({ get: vi.fn(async () => []) })),
    };

    await expect(
      clearSubscriberGoalStickies(reddit as never, {
        knownPostIds: ["t3_known"],
        subreddit: { id: "t5_abc123", name: "ExampleSub" },
      }),
    ).rejects.toBeInstanceOf(SubscriberGoalStickyCleanupError);
  });

  it("keeps the newest pinned goal during lifecycle reconciliation", async () => {
    const pinned = new Map([
      ["t3_old", true],
      ["t3_new", true],
    ]);
    const posts = new Map(
      [
        ["t3_old", new Date("2026-01-01")],
        ["t3_new", new Date("2026-02-01")],
      ].map(([id, createdAt]) => [
        id,
        {
          id,
          createdAt,
          subredditId: "t5_abc123",
          stickied: false,
          isStickied: vi.fn(() => pinned.get(id as string)),
          unsticky: vi.fn(async () => pinned.set(id as string, false)),
        },
      ]),
    );
    const reddit = {
      getPostById: vi.fn(async (id: string) => posts.get(id)),
    };

    const result = await reconcileSubscriberGoalStickies(reddit as never, {
      knownPostIds: ["t3_old", "t3_new"],
      subreddit: { id: "t5_abc123", name: "ExampleSub" },
    });

    expect(result.keptPostId).toBe("t3_new");
    expect(result.unstickied).toEqual(["t3_old"]);
    expect(posts.get("t3_new")?.unsticky).not.toHaveBeenCalled();
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
