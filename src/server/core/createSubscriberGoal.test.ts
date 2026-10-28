import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  reddit: {
    getCurrentSubreddit: vi.fn(),
    getAppUser: vi.fn(),
    getPostById: vi.fn(),
  },
  getModPermissionsForSubreddit: vi.fn(),
  redisValues: new Map<string, string>(),
  redisHashes: new Map<string, Map<string, string>>(),
  highlightedIds: new Set<string>(),
  redis: {
    set: vi.fn(
      async (key: string, value: string, options?: { nx?: boolean }) => {
        if (options?.nx && hoisted.redisValues.has(key)) return;
        hoisted.redisValues.set(key, value);
      },
    ),
    get: vi.fn(async (key: string) => hoisted.redisValues.get(key)),
    del: vi.fn(async (key: string) => {
      hoisted.redisValues.delete(key);
      hoisted.redisHashes.delete(key);
    }),
    hGetAll: vi.fn(async (key: string) =>
      Object.fromEntries(hoisted.redisHashes.get(key) ?? []),
    ),
    hSet: vi.fn(async (key: string, fields: Record<string, string>) => {
      const hash = hoisted.redisHashes.get(key) ?? new Map<string, string>();
      Object.entries(fields).forEach(([field, value]) =>
        hash.set(field, value),
      );
      hoisted.redisHashes.set(key, hash);
    }),
    hMGet: vi.fn(async (key: string, fields: string[]) => {
      const hash = hoisted.redisHashes.get(key);
      return fields.map((field) => hash?.get(field));
    }),
  },
  createGoalPost: vi.fn(),
  registerNewSubGoalPost: vi.fn(),
  registerNewSubscribeOnlyPost: vi.fn(),
  registerNewCtaOnlyPost: vi.fn(),
  setSubredditDisplayNameForPost: vi.fn(),
  setSavedSubredditDisplayName: vi.fn(),
  cancelAllAutoCreateNextGoals: vi.fn(),
  cancelAutoCreateNextGoal: vi.fn(),
  getTrackedPosts: vi.fn(),
  getQueuedUpdates: vi.fn(),
  queueUpdate: vi.fn(),
  getSubscriberGoalCandidatePostIds: vi.fn(),
  ensureSubscriberGoalPostFlair: vi.fn(),
  checkAppAccountHealth: vi.fn(),
  applyGoalPostFrameStyle: vi.fn(),
  isSubredditBlacklisted: vi.fn(),
}));

vi.mock("./post", () => ({
  applyGoalPostFrameStyle: hoisted.applyGoalPostFrameStyle,
  createGoalPost: hoisted.createGoalPost,
}));

vi.mock("../data/subGoalData", () => ({
  autoCreateNextGoalSuccessorsKey: "auto_create_next_goal_v1_successors",
  subscriberGoalsKey: "subscriber_goals",
  postKindSuffix: "_post_kind",
  postHeightSuffix: "_post_height",
  cancelAllAutoCreateNextGoals: hoisted.cancelAllAutoCreateNextGoals,
  cancelAutoCreateNextGoal: hoisted.cancelAutoCreateNextGoal,
  registerNewSubGoalPost: hoisted.registerNewSubGoalPost,
  registerNewSubscribeOnlyPost: hoisted.registerNewSubscribeOnlyPost,
  registerNewCtaOnlyPost: hoisted.registerNewCtaOnlyPost,
  setSubredditDisplayNameForPost: hoisted.setSubredditDisplayNameForPost,
}));

vi.mock("../data/subredditDisplayNameData", () => ({
  setSavedSubredditDisplayName: hoisted.setSavedSubredditDisplayName,
}));

vi.mock("../data/updaterData", () => ({
  getQueuedUpdates: hoisted.getQueuedUpdates,
  getTrackedPosts: hoisted.getTrackedPosts,
  queueUpdate: hoisted.queueUpdate,
}));

vi.mock("../data/subscriberGoalCandidates", () => ({
  getSubscriberGoalCandidatePostIds: hoisted.getSubscriberGoalCandidatePostIds,
}));

vi.mock("./subscriberGoalPostFlair", () => ({
  ensureSubscriberGoalPostFlair: hoisted.ensureSubscriberGoalPostFlair,
}));

vi.mock("./appAccountHealth", () => ({
  checkAppAccountHealth: hoisted.checkAppAccountHealth,
}));

vi.mock("../utils/subredditBlacklist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/subredditBlacklist")>()),
  isSubredditBlacklisted: hoisted.isSubredditBlacklisted,
}));

import { createSubscriberGoal } from "./createSubscriberGoal";

const createPost = ({
  highlight,
  isHighlighted,
}: {
  highlight?: ReturnType<typeof vi.fn>;
  isHighlighted?: ReturnType<typeof vi.fn>;
} = {}) => ({
  id: "t3_newpost",
  title: "Welcome!",
  subredditId: "t5_example",
  subredditName: "ExampleSub",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  approve: vi.fn(),
  highlight:
    highlight ??
    vi.fn(async () => {
      hoisted.highlightedIds.add("t3_newpost");
    }),
  isHighlighted:
    isHighlighted ??
    vi.fn(async () => hoisted.highlightedIds.has("t3_newpost")),
});

const createGoal = (
  options: Partial<Parameters<typeof createSubscriberGoal>[0]["options"]> = {},
) =>
  createSubscriberGoal({
    reddit: hoisted.reddit as never,
    redis: hoisted.redis as never,
    appSettings: {
      promoSubreddit: "SubGoal",
      crosspostAuthoritySubreddit: "SubGoal",
    },
    options: {
      title: "Welcome!",
      goal: 200,
      subredditDisplayName: "ExampleSub",
      crosspost: false,
      colorTheme: "red",
      postHeight: "regular",
      autoCreateNextGoal: true,
      language: "en",
      cancelPendingAutoCreateGoals: true,
      ...options,
    },
  });

const noRetryHighlightVerification = {
  highlightVerification: { maxWaitMs: 0, intervalMs: 1 },
};

describe("createSubscriberGoal highlight handling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.redisValues.clear();
    hoisted.redisHashes.clear();
    hoisted.highlightedIds.clear();
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      nsfw: false,
      getHighlightedPosts: vi.fn(async () =>
        [...hoisted.highlightedIds].map((postId) => ({ postId })),
      ),
      reorderHighlightedPosts: vi.fn(async (postIds: string[]) => {
        hoisted.highlightedIds.clear();
        postIds.forEach((postId) => hoisted.highlightedIds.add(postId));
      }),
    });
    hoisted.isSubredditBlacklisted.mockResolvedValue(false);
    hoisted.reddit.getAppUser.mockResolvedValue({
      username: "subscriber-goal",
      getModPermissionsForSubreddit: hoisted.getModPermissionsForSubreddit,
    });
    hoisted.checkAppAccountHealth.mockImplementation(async () => {
      try {
        const appUser = await hoisted.reddit.getAppUser();
        const permissions =
          await appUser.getModPermissionsForSubreddit("ExampleSub");
        return {
          status:
            permissions.includes("all") || permissions.includes("posts")
              ? "healthy"
              : "unhealthy",
          healthy: permissions.includes("all") || permissions.includes("posts"),
          appUsername: appUser.username,
          permissions,
          notification: "not_needed",
        };
      } catch {
        return {
          status: "unknown",
          healthy: false,
          permissions: [],
          notification: "failed",
        };
      }
    });
    hoisted.getModPermissionsForSubreddit.mockResolvedValue(["all"]);
    hoisted.registerNewSubGoalPost.mockResolvedValue({ status: "skipped" });
    hoisted.registerNewSubscribeOnlyPost.mockResolvedValue({
      status: "skipped",
    });
    hoisted.registerNewCtaOnlyPost.mockResolvedValue({ status: "skipped" });
    hoisted.applyGoalPostFrameStyle.mockResolvedValue(undefined);
    hoisted.getTrackedPosts.mockResolvedValue([]);
    hoisted.getQueuedUpdates.mockResolvedValue([]);
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue([]);
    hoisted.ensureSubscriberGoalPostFlair.mockResolvedValue({
      id: "flair_subgoal",
    });
    hoisted.reddit.getPostById.mockResolvedValue(undefined);
  });

  it.each(["regular", "tiny"] as const)(
    "blocks blacklisted %s posts before creation side effects",
    async (postHeight) => {
      hoisted.isSubredditBlacklisted.mockResolvedValue(true);

      await expect(
        createGoal({
          postHeight,
          ...(postHeight === "tiny" ? { goal: undefined } : {}),
        }),
      ).rejects.toMatchObject({
        name: "ProhibitedSubredditError",
        message: "This content is prohibited",
      });

      expect(hoisted.reddit.getAppUser).not.toHaveBeenCalled();
      expect(hoisted.createGoalPost).not.toHaveBeenCalled();
      expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
      expect(hoisted.registerNewSubscribeOnlyPost).not.toHaveBeenCalled();
    },
  );

  it("returns highlighted when highlight succeeds and verification confirms the post is stickied", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal();

    expect(hoisted.createGoalPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: expect.stringContaining(
        "100 subscribers / 200 subscribers.",
      ),
      postHeight: "regular",
      flairId: "flair_subgoal",
    });
    expect(post.approve).toHaveBeenCalled();
    expect(hoisted.applyGoalPostFrameStyle).toHaveBeenCalledWith(
      post,
      "regular",
    );
    expect(post.highlight).toHaveBeenCalledTimes(1);
    expect(post.highlight).toHaveBeenCalledWith();
    expect(post.isHighlighted).toHaveBeenCalledWith();
    expect(result.post).toBe(post);
    expect(result.flairResult).toEqual({
      status: "applied",
      flairId: "flair_subgoal",
    });
    expect(result.highlightResult).toMatchObject({
      status: "highlighted",
      verifiedHighlighted: true,
    });
  });

  it("fails before creation side effects when the app lacks Manage Posts permission", async () => {
    hoisted.getModPermissionsForSubreddit.mockResolvedValue(["flair"]);

    await expect(createGoal()).rejects.toMatchObject({
      name: "SubscriberGoalModeratorPermissionError",
      message:
        "u/subscriber-goal must be a moderator of r/ExampleSub with Manage Posts permission. Restore the app account's moderator permissions or reinstall Subscriber Goal, then try again.",
    });

    expect(hoisted.ensureSubscriberGoalPostFlair).not.toHaveBeenCalled();
    expect(hoisted.getSubscriberGoalCandidatePostIds).not.toHaveBeenCalled();
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
  });

  it("creates and highlights without flair when the app has Posts but not Flair permission", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.getModPermissionsForSubreddit.mockResolvedValue(["posts"]);

    const result = await createGoal();

    expect(hoisted.ensureSubscriberGoalPostFlair).not.toHaveBeenCalled();
    expect(hoisted.createGoalPost).toHaveBeenCalledWith(
      expect.not.objectContaining({ flairId: expect.anything() }),
    );
    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalled();
    expect(post.approve).toHaveBeenCalled();
    expect(post.highlight).toHaveBeenCalled();
    expect(result.flairResult).toEqual({
      status: "omitted",
      reason: "missing_permission",
    });
  });

  it("creates without flair when flair preparation fails", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.ensureSubscriberGoalPostFlair.mockRejectedValue(
      new Error("flair service unavailable"),
    );

    const result = await createGoal();

    expect(hoisted.createGoalPost).toHaveBeenCalledWith(
      expect.not.objectContaining({ flairId: expect.anything() }),
    );
    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalled();
    expect(post.approve).toHaveBeenCalled();
    expect(post.highlight).toHaveBeenCalled();
    expect(result.flairResult).toEqual({
      status: "omitted",
      reason: "preparation_failed",
    });
  });

  it("fails before creation side effects when app permission lookup fails", async () => {
    hoisted.getModPermissionsForSubreddit.mockRejectedValue(
      new Error("403 Forbidden"),
    );

    await expect(createGoal()).rejects.toThrow("Please try again shortly");

    expect(hoisted.ensureSubscriberGoalPostFlair).not.toHaveBeenCalled();
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
  });

  it("recovers a submitted post instead of creating a duplicate after persistence fails", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.reddit.getPostById.mockResolvedValue(post);
    hoisted.registerNewSubGoalPost
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce({ status: "skipped" });

    await expect(createGoal({ operationId: "manual:test" })).rejects.toThrow(
      "redis unavailable",
    );
    await expect(
      createGoal({ operationId: "manual:test" }),
    ).resolves.toMatchObject({
      post: { id: "t3_newpost" },
    });

    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
    expect(hoisted.reddit.getPostById).toHaveBeenCalledWith("t3_newpost");
  });

  it("removes an authoritative old classic highlight only after the replacement is registered and approved", async () => {
    const post = createPost();
    const oldClassic = {
      id: "t3_tracked",
      subredditId: "t5_example",
      isHighlighted: vi.fn(async () =>
        hoisted.highlightedIds.has("t3_tracked"),
      ),
      unhighlight: vi.fn(async () => {
        hoisted.highlightedIds.delete("t3_tracked");
      }),
    };
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue([
      "t3_oldtiny",
      "t3_tracked",
    ]);
    hoisted.redisHashes.set(
      "subscriber_goals",
      new Map([
        ["t3_oldtiny_post_kind", "subscribe-only-v1"],
        ["t3_oldtiny_post_height", "tiny"],
        ["t3_tracked_post_kind", "subscriber-goal-v1"],
        ["t3_tracked_post_height", "regular"],
      ]),
    );
    hoisted.highlightedIds.add("t3_oldtiny");
    hoisted.highlightedIds.add("t3_tracked");
    hoisted.reddit.getPostById.mockResolvedValue(oldClassic);

    await createGoal();

    expect(oldClassic.unhighlight).toHaveBeenCalledOnce();
    expect(hoisted.highlightedIds).toEqual(
      new Set(["t3_newpost", "t3_oldtiny"]),
    );
    expect(
      hoisted.registerNewSubGoalPost.mock.invocationCallOrder[0],
    ).toBeLessThan(oldClassic.unhighlight.mock.invocationCallOrder[0]);
    expect(post.approve.mock.invocationCallOrder[0]).toBeLessThan(
      oldClassic.unhighlight.mock.invocationCallOrder[0],
    );
  });

  it("keeps a ready replacement unhighlighted when a full list cannot free the managed slot", async () => {
    const post = createPost();
    const oldClassic = {
      id: "t3_old",
      subredditId: "t5_example",
      isHighlighted: vi.fn(async () => true),
      unhighlight: vi.fn(async () => {
        throw new Error("moderator action required");
      }),
    };
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue(["t3_old"]);
    hoisted.redisHashes.set(
      "subscriber_goals",
      new Map([
        ["t3_old_post_kind", "subscriber-goal-v1"],
        ["t3_old_post_height", "regular"],
      ]),
    );
    ["t3_old", "t3_a", "t3_b", "t3_c", "t3_d", "t3_e"].forEach((id) =>
      hoisted.highlightedIds.add(id),
    );
    hoisted.reddit.getPostById.mockResolvedValue(oldClassic);

    const result = await createGoal();

    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalled();
    expect(post.approve).toHaveBeenCalled();
    expect(post.highlight).not.toHaveBeenCalled();
    expect(result.highlightResult).toMatchObject({
      status: "not_highlighted",
      errorMessage: "moderator action required",
      verifiedHighlighted: false,
      failureCategory: "cleanup",
    });
  });

  it.each([
    ["submission", "createGoalPost"],
    ["registration", "registerNewSubGoalPost"],
  ] as const)(
    "leaves existing Community Highlights untouched after a %s failure",
    async (_failureStage, mockName) => {
      const post = createPost();
      if (mockName === "createGoalPost") {
        hoisted.createGoalPost.mockRejectedValue(
          new Error("submission failed"),
        );
      } else {
        hoisted.createGoalPost.mockResolvedValue(post);
        hoisted.registerNewSubGoalPost.mockRejectedValue(
          new Error("registration failed"),
        );
      }

      await expect(createGoal()).rejects.toThrow(/failed/);

      expect(post.highlight).not.toHaveBeenCalled();
    },
  );

  it("leaves existing Community Highlights untouched when replacement approval fails", async () => {
    const post = createPost();
    post.approve.mockRejectedValue(new Error("approval failed"));
    hoisted.createGoalPost.mockResolvedValue(post);

    await expect(createGoal()).rejects.toThrow("approval failed");

    expect(post.highlight).not.toHaveBeenCalled();
  });

  it("passes runAs creation through with fallback text without post-creation fallback updates", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal({ submitAsUser: true });

    expect(hoisted.createGoalPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: expect.stringContaining(
        "100 subscribers / 200 subscribers.",
      ),
      postHeight: "regular",
      submitAsUser: true,
      flairId: "flair_subgoal",
    });
    expect(result.post).toBe(post);
    expect(result.highlightResult.status).toBe("highlighted");
  });

  it("applies short post frame styles after creating the post", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);

    await createGoal({ postHeight: "short" });

    expect(hoisted.applyGoalPostFrameStyle).toHaveBeenCalledWith(post, "short");
    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      post,
      200,
      false,
      "ExampleSub",
      "red",
      true,
      "en",
      undefined,
      "short",
      { type: "disabled" },
    );
  });

  it("applies tiny post frame styles after creating the post", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);

    await createGoal({ postHeight: "tiny", goal: undefined, crosspost: true });

    expect(hoisted.applyGoalPostFrameStyle).toHaveBeenCalledWith(post, "tiny");
    expect(hoisted.createGoalPost).toHaveBeenCalledWith(
      expect.objectContaining({
        textFallback: "Join r/ExampleSub",
      }),
    );
    expect(hoisted.registerNewSubscribeOnlyPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      post,
      "ExampleSub",
      "red",
      "en",
      { type: "disabled" },
    );
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
  });

  it("creates CTA-only posts without a goal and registers their action", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);
    const action = {
      type: "link" as const,
      buttonText: "Create a New Post",
      url: "https://www.reddit.com/r/ExampleSub/submit/",
      colorTheme: "blue" as const,
    };

    await createGoal({
      postHeight: "cta",
      goal: undefined,
      colorTheme: "blue",
      afterSubscribeAction: action,
    });

    expect(hoisted.createGoalPost).toHaveBeenCalledWith(
      expect.objectContaining({
        postHeight: "cta",
        textFallback: "Create a New Post",
      }),
    );
    expect(hoisted.registerNewCtaOnlyPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      post,
      "ExampleSub",
      "blue",
      "en",
      action,
    );
    expect(hoisted.registerNewSubscribeOnlyPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
  });

  it("rejects CTA-only posts without an actionable CTA", async () => {
    await expect(
      createGoal({ postHeight: "cta", goal: undefined }),
    ).rejects.toThrow("CTA-only posts require an actionable CTA.");
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
  });

  it("returns highlighted when delayed highlight verification later confirms the post", async () => {
    const isHighlighted = vi
      .fn()
      .mockResolvedValue(true)
      .mockResolvedValueOnce(false);
    const post = createPost({ isHighlighted });
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal({
      highlightVerification: { maxWaitMs: 5, intervalMs: 1 },
    });

    expect(post.highlight).toHaveBeenCalledTimes(1);
    expect(post.highlight).toHaveBeenCalledWith();
    expect(isHighlighted.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.post).toBe(post);
    expect(result.highlightResult).toMatchObject({
      status: "highlighted",
      verifiedHighlighted: true,
    });
  });

  it("requires list confirmation when highlight throws but post verification becomes true", async () => {
    const post = createPost({
      highlight: vi.fn(async () => {
        throw new Error("highlight slots full");
      }),
      isHighlighted: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal({
      highlightVerification: { maxWaitMs: 5, intervalMs: 1 },
    });

    expect(result.post).toBe(post);
    expect(result.highlightResult).toMatchObject({
      status: "not_highlighted",
      verifiedHighlighted: false,
    });
  });

  it("returns not_highlighted when highlight throws and verification never confirms success", async () => {
    const post = createPost({
      highlight: vi.fn(async () => {
        throw new Error("highlight slots full");
      }),
      isHighlighted: vi.fn(() => false),
    });
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal(noRetryHighlightVerification);

    expect(post.highlight).toHaveBeenCalledTimes(1);
    expect(post.highlight).toHaveBeenCalledWith();
    expect(post.isHighlighted).toHaveBeenCalled();
    expect(result.post).toBe(post);
    expect(result.highlightResult).toMatchObject({
      status: "not_highlighted",
      errorMessage: "highlight slots full",
      verifiedHighlighted: false,
    });
  });

  it("reports an unverified highlight when the list and post state disagree", async () => {
    const post = createPost({
      isHighlighted: vi.fn(() => false),
    });
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal(noRetryHighlightVerification);

    expect(result.post).toBe(post);
    expect(result.highlightResult).toMatchObject({
      status: "highlighted",
      verifiedHighlighted: false,
    });
  });

  it("reports an unverified highlight when post verification throws", async () => {
    const post = createPost({
      isHighlighted: vi.fn(() => {
        throw new Error("verification unavailable");
      }),
    });
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal(noRetryHighlightVerification);

    expect(result.post).toBe(post);
    expect(result.highlightResult).toMatchObject({
      status: "highlighted",
      errorMessage: "verification unavailable",
    });
  });

  it("verifies highlight state on the created post", async () => {
    const post = createPost({
      isHighlighted: vi.fn(() => true),
    });
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal();

    expect(post.isHighlighted).toHaveBeenCalled();
    expect(result.post).toBe(post);
    expect(result.highlightResult).toMatchObject({
      status: "highlighted",
      verifiedHighlighted: true,
    });
  });
});
