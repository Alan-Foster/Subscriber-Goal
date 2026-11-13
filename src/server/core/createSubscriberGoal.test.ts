import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  reddit: {
    getCurrentSubreddit: vi.fn(),
    getAppUser: vi.fn(),
    getPostById: vi.fn(),
    getNewPosts: vi.fn(),
    getPostData: vi.fn(),
    getCurrentUser: vi.fn(),
    getModerators: vi.fn(),
  },
  getModPermissionsForSubreddit: vi.fn(),
  redisValues: new Map<string, string>(),
  redisHashes: new Map<string, Map<string, string>>(),
  state: {
    failCompleteWrite: false,
    failPostSubmittedWrite: false,
    commitPostSubmittedBeforeThrow: false,
    failSubmissionUnknownWrites: 0,
    failReservationWrites: 0,
    failSubmittingWrite: false,
  },
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
      const commit = () => {
        const hash = hoisted.redisHashes.get(key) ?? new Map<string, string>();
        Object.entries(fields).forEach(([field, value]) =>
          hash.set(field, value),
        );
        hoisted.redisHashes.set(key, hash);
      };
      if (fields.status === "submitting" && hoisted.state.failSubmittingWrite) {
        hoisted.state.failSubmittingWrite = false;
        throw new Error("submitting write failed");
      }
      if (
        fields.status === "submission_unknown" &&
        hoisted.state.failSubmissionUnknownWrites > 0
      ) {
        hoisted.state.failSubmissionUnknownWrites -= 1;
        throw new Error("ambiguity write failed");
      }
      if (
        fields.status === undefined &&
        fields.reconciliationAttempts !== undefined &&
        hoisted.state.failReservationWrites > 0
      ) {
        hoisted.state.failReservationWrites -= 1;
        throw new Error("reservation write failed");
      }
      if (
        fields.status === "post_submitted" &&
        hoisted.state.failPostSubmittedWrite
      ) {
        hoisted.state.failPostSubmittedWrite = false;
        if (hoisted.state.commitPostSubmittedBeforeThrow) commit();
        throw new Error("post ID write failed");
      }
      if (fields.status === "complete" && hoisted.state.failCompleteWrite) {
        hoisted.state.failCompleteWrite = false;
        throw new Error("final operation write failed");
      }
      commit();
    }),
    hGet: vi.fn(async (key: string, field: string) =>
      hoisted.redisHashes.get(key)?.get(field),
    ),
    expire: vi.fn(),
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
  postCompletedTimeSuffix: "_completed_time",
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

import {
  createSubscriberGoal,
  recoverSubscriberGoalCreation,
} from "./createSubscriberGoal";

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
    hoisted.state.failCompleteWrite = false;
    hoisted.state.failPostSubmittedWrite = false;
    hoisted.state.commitPostSubmittedBeforeThrow = false;
    hoisted.state.failSubmissionUnknownWrites = 0;
    hoisted.state.failReservationWrites = 0;
    hoisted.state.failSubmittingWrite = false;
    hoisted.highlightedIds.clear();
    hoisted.redis.expire.mockResolvedValue(undefined);
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
    hoisted.reddit.getCurrentUser.mockResolvedValue({
      id: "t2_mod",
      username: "ExampleMod",
    });
    hoisted.reddit.getModerators.mockReturnValue({
      all: vi.fn(async () => [
        {
          id: "t2_mod",
          username: "ExampleMod",
          moderatorInfo: { modPermissions: ["all"] },
        },
      ]),
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
    hoisted.reddit.getNewPosts.mockReturnValue({
      all: vi.fn(async () => []),
    });
    hoisted.reddit.getPostData.mockResolvedValue(undefined);
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
      language: "en",
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

  it("revalidates a manual actor after acquiring the operation lock", async () => {
    const order: string[] = [];
    hoisted.redis.set.mockImplementation(async (key: string, value: string) => {
      order.push(key.endsWith(":lock") ? "operation-lock" : "community-lock");
      hoisted.redisValues.set(key, value);
    });
    hoisted.reddit.getModerators.mockReturnValue({
      all: vi.fn(async () => {
        order.push("actor-lookup");
        return [];
      }),
    });

    await expect(
      createGoal({
        operationId: "manual-v2:t5_example:t2_mod:revoked",
        manualActorUserId: "t2_mod",
      }),
    ).rejects.toMatchObject({ name: "SubscriberGoalActorAuthorizationError" });

    expect(order.indexOf("actor-lookup")).toBeGreaterThan(
      order.indexOf("operation-lock"),
    );
    expect(hoisted.redisHashes.size).toBe(0);
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
  });

  it("preserves an incomplete manual operation on transient lookup failure and resumes once", async () => {
    const operationId = "manual-v2:t5_example:t2_mod:resume";
    const operationKey = `subscriber_goal_creation_v1:${operationId}`;
    const post = createPost();
    hoisted.redisHashes.set(
      operationKey,
      new Map([
        ["status", "post_submitted"],
        ["postId", post.id],
        ["actorUserId", "t2_mod"],
        ["subredditId", "t5_example"],
        ["subredditName", "ExampleSub"],
        ["submissionMarker", "marker"],
      ]),
    );
    hoisted.reddit.getPostById.mockResolvedValue(post);
    hoisted.reddit.getModerators
      .mockReturnValueOnce({
        all: vi.fn().mockRejectedValue(new Error("temporary")),
      })
      .mockReturnValueOnce({
        all: vi.fn(async () => [
          {
            id: "t2_mod",
            username: "ExampleMod",
            moderatorInfo: { modPermissions: ["posts"] },
          },
        ]),
      });

    await expect(
      createGoal({ operationId, manualActorUserId: "t2_mod" }),
    ).rejects.toThrow("try again shortly");
    expect(hoisted.redisHashes.get(operationKey)?.get("status")).toBe(
      "post_submitted",
    );
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();

    await expect(
      createGoal({ operationId, manualActorUserId: "t2_mod" }),
    ).resolves.toMatchObject({ post: { id: post.id } });
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledOnce();
  });

  it("returns completed recovery only to its original actor and subreddit without writes", async () => {
    const operationId = "manual-v2:t5_example:t2_mod:completed";
    const operationKey = `subscriber_goal_creation_v1:${operationId}`;
    const post = createPost();
    hoisted.redisHashes.set(
      operationKey,
      new Map([
        ["status", "complete"],
        ["postId", post.id],
        ["actorUserId", "t2_mod"],
        ["subredditId", "t5_example"],
        ["subredditName", "ExampleSub"],
        ["crosspostDispatchResult", JSON.stringify({ status: "skipped" })],
        [
          "highlightResult",
          JSON.stringify({
            status: "highlighted",
            verifiedHighlighted: true,
            issues: [],
          }),
        ],
        ["flairResult", JSON.stringify({ status: "applied", flairId: "f" })],
      ]),
    );
    hoisted.reddit.getPostById.mockResolvedValue(post);
    const writesBefore = hoisted.redis.hSet.mock.calls.length;

    await expect(
      recoverSubscriberGoalCreation({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        operationId,
        actorUserId: "t2_mod",
        subredditId: "t5_example",
        subredditName: "ExampleSub",
      }),
    ).resolves.toMatchObject({ status: "complete", result: { post } });
    await expect(
      recoverSubscriberGoalCreation({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        operationId,
        actorUserId: "t2_other",
        subredditId: "t5_example",
        subredditName: "ExampleSub",
      }),
    ).resolves.toEqual({ status: "missing" });
    await expect(
      recoverSubscriberGoalCreation({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        operationId,
        actorUserId: "t2_mod",
        subredditId: "t5_other",
        subredditName: "OtherSub",
      }),
    ).resolves.toEqual({ status: "missing" });
    expect(hoisted.redis.hSet).toHaveBeenCalledTimes(writesBefore);
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

  it("returns superseded without replaying community-wide writes after a newer goal replaces the recovered post", async () => {
    const postA = createPost();
    const postB = {
      ...createPost(),
      id: "t3_newer",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    postA.approve.mockRejectedValueOnce(new Error("approval failed"));
    hoisted.createGoalPost.mockResolvedValue(postA);
    hoisted.reddit.getPostById.mockImplementation(async (postId: string) =>
      postId === postB.id ? postB : postA,
    );

    await expect(createGoal({ operationId: "manual:late-a" })).rejects.toThrow(
      "approval failed",
    );
    const successorMap =
      hoisted.redisHashes.get("auto_create_next_goal_v1_successors") ??
      new Map<string, string>();
    successorMap.set(postA.id, postB.id);
    hoisted.redisHashes.set(
      "auto_create_next_goal_v1_successors",
      successorMap,
    );
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue([
      postA.id,
      postB.id,
    ]);

    await expect(
      createGoal({ operationId: "manual:late-a" }),
    ).resolves.toMatchObject({
      outcome: "superseded",
      post: { id: postA.id },
      supersedingPostId: postB.id,
    });

    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
    expect(successorMap.get(postA.id)).toBe(postB.id);
    expect(successorMap.get(postB.id)).toBeUndefined();
    expect(hoisted.cancelAllAutoCreateNextGoals).not.toHaveBeenCalled();
    expect(hoisted.setSavedSubredditDisplayName).toHaveBeenCalledOnce();
    expect(postA.approve).toHaveBeenCalledOnce();
  });

  it("recovers the same Reddit post when the final operation write fails", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.reddit.getPostById.mockResolvedValue(post);
    hoisted.state.failCompleteWrite = true;

    await expect(
      createGoal({ operationId: "manual:final-write" }),
    ).rejects.toThrow("final operation write failed");
    await expect(
      createGoal({ operationId: "manual:final-write" }),
    ).resolves.toMatchObject({
      outcome: "created",
      post: { id: post.id },
    });

    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
    expect(hoisted.reddit.getPostById).toHaveBeenCalledWith(post.id);
  });

  it("returns superseded when a recovered goal completed before retry", async () => {
    const post = createPost();
    post.approve.mockRejectedValueOnce(new Error("approval failed"));
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.reddit.getPostById.mockResolvedValue(post);

    await expect(
      createGoal({ operationId: "manual:completed-a" }),
    ).rejects.toThrow("approval failed");
    const goals =
      hoisted.redisHashes.get("subscriber_goals") ?? new Map<string, string>();
    goals.set(`${post.id}_completed_time`, "1234");
    goals.set(
      `${post.id}_automatic_successor_suppression`,
      "auto_goal_reconciliation",
    );
    hoisted.redisHashes.set("subscriber_goals", goals);

    await expect(
      createGoal({ operationId: "manual:completed-a" }),
    ).resolves.toMatchObject({
      outcome: "superseded",
      post: { id: post.id },
    });
    expect(
      hoisted.redisHashes
        .get("subscriber_goals")
        ?.get(`${post.id}_automatic_successor_suppression`),
    ).toBe("auto_goal_reconciliation");
    expect(post.approve).toHaveBeenCalledOnce();
  });

  it("makes zero Reddit submissions when the atomic operation claim fails", async () => {
    hoisted.redisValues.set(
      "subscriber_goal_creation_v1:manual:test:lock",
      "another-request",
    );

    await expect(
      createGoal({ operationId: "manual:test" }),
    ).rejects.toMatchObject({ name: "SubscriberGoalCreationInProgressError" });

    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
  });

  it("blocks retries when a Reddit submission outcome is unknown", async () => {
    hoisted.createGoalPost.mockRejectedValue(new Error("connection reset"));

    await expect(
      createGoal({ operationId: "manual:unknown" }),
    ).rejects.toMatchObject({
      name: "SubscriberGoalCreationOutcomeUnknownError",
    });
    await expect(
      createGoal({ operationId: "manual:unknown" }),
    ).rejects.toMatchObject({
      name: "SubscriberGoalCreationOutcomeUnknownError",
    });

    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
    expect(
      hoisted.redisHashes
        .get("subscriber_goal_creation_v1:manual:unknown")
        ?.get("status"),
    ).toBe("submission_unknown");
  });

  it("recovers the exact post created before a lost submission response", async () => {
    const post = createPost();
    let marker = "";
    hoisted.createGoalPost.mockImplementationOnce(async (options) => {
      marker = options.submissionMarker;
      throw new Error("connection reset after create");
    });

    await expect(
      createGoal({
        operationId: "manual:lost-response",
        reconciliationNowMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "SubscriberGoalCreationOutcomeUnknownError",
    });
    hoisted.reddit.getNewPosts.mockReturnValue({
      all: vi.fn(async () => [post]),
    });
    hoisted.reddit.getPostData.mockResolvedValue({ submissionMarker: marker });

    await expect(
      createGoal({
        operationId: "manual:lost-response",
        reconciliationNowMs: 61_000,
      }),
    ).resolves.toMatchObject({ post: { id: post.id } });

    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledOnce();
  });

  it("recovers when saving the returned post ID fails", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.state.failPostSubmittedWrite = true;

    await expect(
      createGoal({
        operationId: "manual:id-write",
        reconciliationNowMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "SubscriberGoalCreationOutcomeUnknownError",
    });
    const marker = hoisted.redisHashes
      .get("subscriber_goal_creation_v1:manual:id-write")
      ?.get("submissionMarker");
    hoisted.reddit.getNewPosts.mockReturnValue({
      all: vi.fn(async () => [post]),
    });
    hoisted.reddit.getPostData.mockResolvedValue({ submissionMarker: marker });

    await expect(
      createGoal({
        operationId: "manual:id-write",
        reconciliationNowMs: 61_000,
      }),
    ).resolves.toMatchObject({ post: { id: post.id } });
    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
  });

  it("keeps a missing marker match blocked until it becomes visible", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockRejectedValueOnce(new Error("timeout"));
    await expect(
      createGoal({
        operationId: "manual:eventual",
        reconciliationNowMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "SubscriberGoalCreationOutcomeUnknownError",
    });
    await expect(
      createGoal({
        operationId: "manual:eventual",
        reconciliationNowMs: 61_000,
      }),
    ).rejects.toMatchObject({
      name: "SubscriberGoalCreationOutcomeUnknownError",
    });

    const marker = hoisted.redisHashes
      .get("subscriber_goal_creation_v1:manual:eventual")
      ?.get("submissionMarker");
    hoisted.reddit.getNewPosts.mockReturnValue({
      all: vi.fn(async () => [post]),
    });
    hoisted.reddit.getPostData.mockResolvedValue({ submissionMarker: marker });
    await expect(
      createGoal({
        operationId: "manual:eventual",
        reconciliationNowMs: 361_000,
      }),
    ).resolves.toMatchObject({ post: { id: post.id } });
    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
  });

  it("does not scan before the persisted reconciliation due time", async () => {
    hoisted.createGoalPost.mockRejectedValueOnce(new Error("timeout"));
    await expect(
      createGoal({
        operationId: "manual:not-due",
        reconciliationNowMs: 1_000,
      }),
    ).rejects.toMatchObject({
      reconciliationStatus: "pending",
      reconciliationNextAt: 61_000,
    });

    await expect(
      createGoal({
        operationId: "manual:not-due",
        reconciliationNowMs: 60_999,
      }),
    ).rejects.toMatchObject({
      reconciliationStatus: "pending",
      reconciliationNextAt: 61_000,
    });

    expect(hoisted.reddit.getNewPosts).not.toHaveBeenCalled();
    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
  });

  it("makes a failed scan reservation lookup-free and does not reuse a reserved slot", async () => {
    const operationKey =
      "subscriber_goal_creation_v1:auto-next:t3_reservation-failure";
    hoisted.redisHashes.set(
      operationKey,
      new Map([
        ["status", "submission_unknown"],
        ["subredditName", "ExampleSub"],
        ["subredditId", "t5_example"],
        ["submissionMarker", "marker-reservation"],
        ["reconciliationStatus", "pending"],
        ["reconciliationAttempts", "0"],
        ["reconciliationNextAt", "1000"],
      ]),
    );
    hoisted.state.failReservationWrites = 1;

    await expect(
      createGoal({
        operationId: "auto-next:t3_reservation-failure",
        reconciliationNowMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "SubscriberGoalCreationOutcomeUnknownError",
      reconciliationStatus: "pending",
      reconciliationAttempts: 1,
      reconciliationNextAt: 301_000,
    });
    expect(hoisted.reddit.getNewPosts).not.toHaveBeenCalled();
    expect(
      hoisted.redisHashes.get(operationKey)?.get("reconciliationAttempts"),
    ).toBe("0");

    hoisted.reddit.getNewPosts.mockReturnValue({
      all: vi.fn(async () => {
        throw new Error("scan interrupted");
      }),
    });
    await expect(
      createGoal({
        operationId: "auto-next:t3_reservation-failure",
        reconciliationNowMs: 301_000,
      }),
    ).rejects.toMatchObject({
      reconciliationAttempts: 1,
      reconciliationNextAt: 601_000,
    });
    await expect(
      createGoal({
        operationId: "auto-next:t3_reservation-failure",
        reconciliationNowMs: 301_000,
      }),
    ).rejects.toMatchObject({
      reconciliationAttempts: 1,
      reconciliationNextAt: 601_000,
    });

    expect(hoisted.reddit.getNewPosts).toHaveBeenCalledOnce();
    expect(
      hoisted.redisHashes.get(operationKey)?.get("reconciliationAttempts"),
    ).toBe("1");
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
  });

  it("keeps submission ambiguity typed when its bookkeeping write fails", async () => {
    hoisted.createGoalPost.mockRejectedValue(new Error("timeout after create"));
    hoisted.state.failSubmissionUnknownWrites = 1;

    await expect(
      createGoal({
        operationId: "auto-next:t3_submit-fallback",
        reconciliationNowMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "SubscriberGoalCreationOutcomeUnknownError",
      reconciliationNextAt: 61_000,
    });

    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
    expect(
      hoisted.redisHashes
        .get("subscriber_goal_creation_v1:auto-next:t3_submit-fallback")
        ?.get("status"),
    ).toBe("submitting");

    await expect(
      createGoal({
        operationId: "auto-next:t3_submit-fallback",
        reconciliationNowMs: 61_000,
      }),
    ).rejects.toMatchObject({
      name: "SubscriberGoalCreationOutcomeUnknownError",
      reconciliationAttempts: 1,
    });
    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
  });

  it("keeps returned-ID ambiguity typed when both persistence writes fail", async () => {
    hoisted.createGoalPost.mockResolvedValue(createPost());
    hoisted.state.failPostSubmittedWrite = true;
    hoisted.state.failSubmissionUnknownWrites = 1;

    await expect(
      createGoal({
        operationId: "onboarding:returned-id-fallback",
        reconciliationNowMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "SubscriberGoalCreationOutcomeUnknownError",
      reconciliationNextAt: 61_000,
    });

    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
    expect(
      hoisted.redisHashes
        .get("subscriber_goal_creation_v1:onboarding:returned-id-fallback")
        ?.get("status"),
    ).toBe("submitting");
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();

    await expect(
      createGoal({
        operationId: "onboarding:returned-id-fallback",
        reconciliationNowMs: 61_000,
      }),
    ).rejects.toMatchObject({
      name: "SubscriberGoalCreationOutcomeUnknownError",
      reconciliationAttempts: 1,
    });
    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
  });

  it("does not submit when the pre-submit submitting write fails", async () => {
    hoisted.state.failSubmittingWrite = true;

    await expect(
      createGoal({ operationId: "auto-next:t3_pre-submit-write" }),
    ).rejects.toThrow("submitting write failed");

    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
  });

  it("stops scanning after the sixth inconclusive reconciliation", async () => {
    const operationKey =
      "subscriber_goal_creation_v1:auto-next:t3_reconciliation-cutoff";
    hoisted.redisHashes.set(
      operationKey,
      new Map([
        ["status", "submission_unknown"],
        ["subredditName", "ExampleSub"],
        ["subredditId", "t5_example"],
        ["submissionMarker", "marker-cutoff"],
        ["reconciliationStatus", "pending"],
        ["reconciliationAttempts", "5"],
        ["reconciliationNextAt", "1000"],
      ]),
    );

    await expect(
      createGoal({
        operationId: "auto-next:t3_reconciliation-cutoff",
        reconciliationNowMs: 1_000,
      }),
    ).rejects.toMatchObject({
      reconciliationStatus: "exhausted",
      reconciliationAttempts: 6,
    });
    await expect(
      createGoal({
        operationId: "auto-next:t3_reconciliation-cutoff",
        reconciliationNowMs: 9_999_999,
      }),
    ).rejects.toMatchObject({ reconciliationStatus: "exhausted" });

    expect(hoisted.reddit.getNewPosts).toHaveBeenCalledOnce();
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(
      hoisted.redisHashes.get(operationKey)?.get("reconciliationStatus"),
    ).toBe("exhausted");
  });

  it("lets the reserved sixth scan recover an exact marker match", async () => {
    const post = createPost();
    const operationKey = "subscriber_goal_creation_v1:auto-next:t3_sixth-match";
    hoisted.redisHashes.set(
      operationKey,
      new Map([
        ["status", "submission_unknown"],
        ["subredditName", "ExampleSub"],
        ["subredditId", "t5_example"],
        ["submissionMarker", "marker-sixth"],
        ["reconciliationStatus", "pending"],
        ["reconciliationAttempts", "5"],
        ["reconciliationNextAt", "1000"],
      ]),
    );
    hoisted.reddit.getNewPosts.mockReturnValue({
      all: vi.fn(async () => [post]),
    });
    hoisted.reddit.getPostData.mockResolvedValue({
      submissionMarker: "marker-sixth",
    });

    await expect(
      createGoal({
        operationId: "auto-next:t3_sixth-match",
        reconciliationNowMs: 1_000,
      }),
    ).resolves.toMatchObject({ post: { id: post.id } });

    expect(hoisted.reddit.getNewPosts).toHaveBeenCalledOnce();
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledOnce();
    expect(hoisted.redisHashes.get(operationKey)?.get("postId")).toBe(post.id);
  });

  it("never scans again after an interrupted reserved sixth scan", async () => {
    const operationKey =
      "subscriber_goal_creation_v1:auto-next:t3_sixth-interrupted";
    hoisted.redisHashes.set(
      operationKey,
      new Map([
        ["status", "submission_unknown"],
        ["subredditName", "ExampleSub"],
        ["subredditId", "t5_example"],
        ["submissionMarker", "marker-sixth-interrupted"],
        ["reconciliationStatus", "pending"],
        ["reconciliationAttempts", "5"],
        ["reconciliationNextAt", "1000"],
      ]),
    );
    hoisted.reddit.getNewPosts.mockReturnValue({
      all: vi.fn(async () => {
        throw new Error("worker interrupted");
      }),
    });

    await expect(
      createGoal({
        operationId: "auto-next:t3_sixth-interrupted",
        reconciliationNowMs: 1_000,
      }),
    ).rejects.toMatchObject({ reconciliationStatus: "exhausted" });
    await expect(
      createGoal({
        operationId: "auto-next:t3_sixth-interrupted",
        reconciliationNowMs: 99_999_999,
      }),
    ).rejects.toMatchObject({ reconciliationStatus: "exhausted" });

    expect(hoisted.reddit.getNewPosts).toHaveBeenCalledOnce();
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
  });

  it.each(["multiple", "lookup-failure", "unrelated", "legacy"] as const)(
    "does not adopt or resubmit an unresolved %s operation",
    async (scenario) => {
      const post = createPost();
      const otherPost = { ...createPost(), id: "t3_other" };
      const operationKey = `subscriber_goal_creation_v1:manual:${scenario}`;
      hoisted.redisHashes.set(
        operationKey,
        new Map([
          ["status", "submission_unknown"],
          ["subredditName", "ExampleSub"],
          ["subredditId", "t5_example"],
          ...(scenario === "legacy"
            ? []
            : [
                ["submissionMarker", "marker-1"] as [string, string],
                ["reconciliationStatus", "pending"] as [string, string],
                ["reconciliationAttempts", "0"] as [string, string],
                ["reconciliationNextAt", "1000"] as [string, string],
              ]),
        ]),
      );
      hoisted.reddit.getNewPosts.mockReturnValue({
        all: vi.fn(async () =>
          scenario === "multiple" ? [post, otherPost] : [post],
        ),
      });
      if (scenario === "lookup-failure") {
        hoisted.reddit.getPostData.mockRejectedValue(new Error("lookup down"));
      } else {
        hoisted.reddit.getPostData.mockResolvedValue({
          submissionMarker:
            scenario === "unrelated" ? "other-marker" : "marker-1",
        });
      }

      await expect(
        createGoal({
          operationId: `manual:${scenario}`,
          reconciliationNowMs: 1_000,
        }),
      ).rejects.toMatchObject({
        name: "SubscriberGoalCreationOutcomeUnknownError",
      });
      expect(hoisted.createGoalPost).not.toHaveBeenCalled();
      expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
    },
  );

  it("serializes concurrent reconciliation and registers the recovered post once", async () => {
    const post = createPost();
    hoisted.redisHashes.set(
      "subscriber_goal_creation_v1:manual:concurrent",
      new Map([
        ["status", "submission_unknown"],
        ["subredditName", "ExampleSub"],
        ["subredditId", "t5_example"],
        ["submissionMarker", "marker-concurrent"],
        ["reconciliationStatus", "pending"],
        ["reconciliationAttempts", "0"],
        ["reconciliationNextAt", "1000"],
      ]),
    );
    hoisted.reddit.getNewPosts.mockReturnValue({
      all: vi.fn(async () => [post]),
    });
    hoisted.reddit.getPostData.mockResolvedValue({
      submissionMarker: "marker-concurrent",
    });

    const results = await Promise.allSettled([
      createGoal({
        operationId: "manual:concurrent",
        reconciliationNowMs: 1_000,
      }),
      createGoal({
        operationId: "manual:concurrent",
        reconciliationNowMs: 1_000,
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledOnce();
  });

  it("waits for the next reserved slot when a recovered ID write does not commit", async () => {
    const post = createPost();
    const unrelated = { ...createPost(), id: "t3_unrelated" };
    const operationKey =
      "subscriber_goal_creation_v1:auto-next:t3_recovered-id-no-commit";
    hoisted.redisHashes.set(
      operationKey,
      new Map([
        ["status", "submission_unknown"],
        ["subredditName", "ExampleSub"],
        ["subredditId", "t5_example"],
        ["submissionMarker", "marker-recovered-id"],
        ["reconciliationStatus", "pending"],
        ["reconciliationAttempts", "0"],
        ["reconciliationNextAt", "1000"],
      ]),
    );
    hoisted.reddit.getNewPosts.mockReturnValue({
      all: vi.fn(async () => [unrelated, post]),
    });
    hoisted.reddit.getPostData.mockImplementation(async (postId: string) => ({
      submissionMarker:
        postId === post.id ? "marker-recovered-id" : "unrelated-marker",
    }));
    hoisted.state.failPostSubmittedWrite = true;

    await expect(
      createGoal({
        operationId: "auto-next:t3_recovered-id-no-commit",
        reconciliationNowMs: 1_000,
      }),
    ).rejects.toMatchObject({
      reconciliationStatus: "pending",
      reconciliationNextAt: 301_000,
    });
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
    expect(
      hoisted.redisHashes.get(operationKey)?.get("postId"),
    ).toBeUndefined();

    await expect(
      createGoal({
        operationId: "auto-next:t3_recovered-id-no-commit",
        reconciliationNowMs: 300_999,
      }),
    ).rejects.toMatchObject({ reconciliationNextAt: 301_000 });
    expect(hoisted.reddit.getNewPosts).toHaveBeenCalledOnce();

    await expect(
      createGoal({
        operationId: "auto-next:t3_recovered-id-no-commit",
        reconciliationNowMs: 301_000,
      }),
    ).resolves.toMatchObject({ post: { id: post.id } });
    expect(hoisted.reddit.getNewPosts).toHaveBeenCalledTimes(2);
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledOnce();
  });

  it("uses the known-post path when a recovered ID write commits before throwing", async () => {
    const post = createPost();
    const operationKey =
      "subscriber_goal_creation_v1:onboarding:recovered-id-committed";
    hoisted.redisHashes.set(
      operationKey,
      new Map([
        ["status", "submission_unknown"],
        ["subredditName", "ExampleSub"],
        ["subredditId", "t5_example"],
        ["submissionMarker", "marker-committed-id"],
        ["reconciliationStatus", "pending"],
        ["reconciliationAttempts", "0"],
        ["reconciliationNextAt", "1000"],
      ]),
    );
    hoisted.reddit.getNewPosts.mockReturnValue({
      all: vi.fn(async () => [post]),
    });
    hoisted.reddit.getPostData.mockResolvedValue({
      submissionMarker: "marker-committed-id",
    });
    hoisted.reddit.getPostById.mockResolvedValue(post);
    hoisted.state.failPostSubmittedWrite = true;
    hoisted.state.commitPostSubmittedBeforeThrow = true;

    await expect(
      createGoal({
        operationId: "onboarding:recovered-id-committed",
        reconciliationNowMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: "SubscriberGoalCreationOutcomeUnknownError",
    });
    expect(hoisted.redisHashes.get(operationKey)?.get("status")).toBe(
      "post_submitted",
    );
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();

    await expect(
      createGoal({
        operationId: "onboarding:recovered-id-committed",
        reconciliationNowMs: 301_000,
      }),
    ).resolves.toMatchObject({ post: { id: post.id } });
    expect(hoisted.reddit.getNewPosts).toHaveBeenCalledOnce();
    expect(hoisted.reddit.getPostById).toHaveBeenCalledWith(post.id);
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledOnce();
  });

  it("does not fail successful creation when operation expiration fails", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.redis.expire.mockRejectedValue(new Error("quota unavailable"));

    await expect(
      createGoal({ operationId: "manual-v2:ttl-warning" }),
    ).resolves.toMatchObject({ post: { id: "t3_newpost" } });

    expect(hoisted.redis.expire).toHaveBeenCalledWith(
      "subscriber_goal_creation_v1:manual-v2:ttl-warning",
      86_400,
    );
  });

  it("creates distinct posts for separate attempts with identical settings", async () => {
    const firstPost = { ...createPost(), id: "t3_first" };
    const secondPost = { ...createPost(), id: "t3_second" };
    hoisted.createGoalPost
      .mockResolvedValueOnce(firstPost)
      .mockResolvedValueOnce(secondPost);

    const first = await createGoal({
      operationId: "manual-v2:attempt-one",
      ...noRetryHighlightVerification,
    });
    const second = await createGoal({
      operationId: "manual-v2:attempt-two",
      ...noRetryHighlightVerification,
    });

    expect(first.post.id).toBe("t3_first");
    expect(second.post.id).toBe("t3_second");
    expect(hoisted.createGoalPost).toHaveBeenCalledTimes(2);
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
      language: "en",
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
