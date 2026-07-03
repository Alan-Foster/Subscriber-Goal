import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  reddit: {
    getCurrentSubreddit: vi.fn(),
    getAppUser: vi.fn(),
    getPostById: vi.fn(),
  },
  redis: {},
  createGoalPost: vi.fn(),
  registerNewSubGoalPost: vi.fn(),
  setSubredditDisplayNameForPost: vi.fn(),
  setSavedSubredditDisplayName: vi.fn(),
  cancelAllAutoCreateNextGoals: vi.fn(),
  getTrackedPosts: vi.fn(),
  getQueuedUpdates: vi.fn(),
  queueUpdate: vi.fn(),
  clearUserStickies: vi.fn(),
  applyGoalPostFrameStyle: vi.fn(),
}));

vi.mock("./post", () => ({
  applyGoalPostFrameStyle: hoisted.applyGoalPostFrameStyle,
  createGoalPost: hoisted.createGoalPost,
}));

vi.mock("../data/subGoalData", () => ({
  cancelAllAutoCreateNextGoals: hoisted.cancelAllAutoCreateNextGoals,
  registerNewSubGoalPost: hoisted.registerNewSubGoalPost,
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

vi.mock("../utils/redditUtils", () => ({
  clearUserStickies: hoisted.clearUserStickies,
}));

import { createSubscriberGoal } from "./createSubscriberGoal";

const createPost = ({
  sticky = vi.fn(),
  isStickied = vi.fn(() => true),
}: {
  sticky?: ReturnType<typeof vi.fn>;
  isStickied?: ReturnType<typeof vi.fn>;
} = {}) => ({
  id: "t3_newpost",
  title: "Welcome!",
  subredditId: "t5_example",
  subredditName: "ExampleSub",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  approve: vi.fn(),
  sticky,
  isStickied,
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

const noRetryStickyVerification = {
  stickyVerification: { maxWaitMs: 0, intervalMs: 1 },
};

describe("createSubscriberGoal sticky handling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      isNsfw: false,
    });
    hoisted.reddit.getAppUser.mockResolvedValue({
      username: "subscriber-goal",
    });
    hoisted.registerNewSubGoalPost.mockResolvedValue({ status: "skipped" });
    hoisted.applyGoalPostFrameStyle.mockResolvedValue(undefined);
    hoisted.getTrackedPosts.mockResolvedValue([]);
    hoisted.getQueuedUpdates.mockResolvedValue([]);
    hoisted.reddit.getPostById.mockResolvedValue(undefined);
  });

  it("returns pinned when sticky succeeds and verification confirms the post is stickied", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal();

    expect(hoisted.createGoalPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: expect.stringContaining("100 / 200 subscribers."),
      postHeight: "regular",
    });
    expect(post.approve).toHaveBeenCalled();
    expect(hoisted.applyGoalPostFrameStyle).toHaveBeenCalledWith(
      post,
      "regular",
    );
    expect(post.sticky).toHaveBeenCalledWith(1);
    expect(post.isStickied).toHaveBeenCalledWith();
    expect(result.post).toBe(post);
    expect(result.stickyResult).toEqual({
      status: "pinned",
      verifiedStickied: true,
    });
  });

  it("passes existing tracked and queued post ids to sticky cleanup before creating the new post", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.getTrackedPosts.mockResolvedValue(["t3_tracked", "invalid"]);
    hoisted.getQueuedUpdates.mockResolvedValue(["t3_queued", "t3_tracked"]);
    hoisted.reddit.getPostById.mockImplementation(async (postId) => ({
      id: postId,
      subredditId: "t5_example",
      isStickied: vi.fn(() => true),
    }));

    await createGoal();

    expect(hoisted.clearUserStickies).toHaveBeenCalledWith(
      hoisted.reddit,
      "subscriber-goal",
      {
        knownPostIds: ["t3_tracked", "invalid", "t3_queued"],
        subreddit: {
          id: "t5_example",
          name: "ExampleSub",
          numberOfSubscribers: 100,
          isNsfw: false,
        },
      },
    );
    expect(hoisted.clearUserStickies.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.createGoalPost.mock.invocationCallOrder[0],
    );
  });

  it("passes runAs creation through with fallback text without post-creation fallback updates", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal({ submitAsUser: true });

    expect(hoisted.createGoalPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: expect.stringContaining("100 / 200 subscribers."),
      postHeight: "regular",
      submitAsUser: true,
    });
    expect(result.post).toBe(post);
    expect(result.stickyResult.status).toBe("pinned");
  });

  it("applies short post frame styles after creating the post", async () => {
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);

    await createGoal({ postHeight: "short" });

    expect(hoisted.applyGoalPostFrameStyle).toHaveBeenCalledWith(
      post,
      "short",
    );
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
    );
  });

  it("returns pinned when delayed sticky verification later confirms the post is stickied", async () => {
    const refetchedBeforePropagation = createPost({
      isStickied: vi.fn(() => false),
    });
    const refetchedAfterPropagation = createPost({
      isStickied: vi.fn(() => true),
    });
    const post = createPost();
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.reddit.getPostById
      .mockResolvedValueOnce(refetchedBeforePropagation)
      .mockResolvedValueOnce(refetchedAfterPropagation);

    const result = await createGoal({
      stickyVerification: { maxWaitMs: 5, intervalMs: 1 },
    });

    expect(refetchedBeforePropagation.isStickied).toHaveBeenCalled();
    expect(refetchedAfterPropagation.isStickied).toHaveBeenCalled();
    expect(result.post).toBe(post);
    expect(result.stickyResult).toEqual({
      status: "pinned",
      verifiedStickied: true,
    });
  });

  it("returns pinned when sticky throws but delayed verification confirms the post is stickied", async () => {
    const refetchedBeforePropagation = createPost({
      isStickied: vi.fn(() => false),
    });
    const refetchedAfterPropagation = createPost({
      isStickied: vi.fn(() => true),
    });
    const post = createPost({
      sticky: vi.fn(async () => {
        throw new Error("sticky slots full");
      }),
    });
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.reddit.getPostById
      .mockResolvedValueOnce(refetchedBeforePropagation)
      .mockResolvedValueOnce(refetchedAfterPropagation);

    const result = await createGoal({
      stickyVerification: { maxWaitMs: 5, intervalMs: 1 },
    });

    expect(result.post).toBe(post);
    expect(result.stickyResult).toEqual({
      status: "pinned",
      verifiedStickied: true,
    });
  });

  it("returns not_pinned when sticky throws and verification never confirms success", async () => {
    const post = createPost({
      sticky: vi.fn(async () => {
        throw new Error("sticky slots full");
      }),
      isStickied: vi.fn(() => false),
    });
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal(noRetryStickyVerification);

    expect(post.isStickied).toHaveBeenCalled();
    expect(result.post).toBe(post);
    expect(result.stickyResult).toEqual({
      status: "not_pinned",
      errorMessage: "sticky slots full",
      verifiedStickied: false,
    });
  });

  it("returns not_pinned when sticky does not throw but verification returns false", async () => {
    const post = createPost({
      isStickied: vi.fn(() => false),
    });
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal(noRetryStickyVerification);

    expect(result.post).toBe(post);
    expect(result.stickyResult).toEqual({
      status: "not_pinned",
      verifiedStickied: false,
    });
  });

  it("returns not_pinned when sticky verification throws", async () => {
    const post = createPost({
      isStickied: vi.fn(() => {
        throw new Error("verification unavailable");
      }),
    });
    hoisted.createGoalPost.mockResolvedValue(post);

    const result = await createGoal(noRetryStickyVerification);

    expect(result.post).toBe(post);
    expect(result.stickyResult).toEqual({
      status: "not_pinned",
      errorMessage: "verification unavailable",
    });
  });

  it("falls back to the original post when verification refetch fails", async () => {
    const post = createPost({
      isStickied: vi.fn(() => true),
    });
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.reddit.getPostById.mockRejectedValue(new Error("not ready"));

    const result = await createGoal();

    expect(post.isStickied).toHaveBeenCalled();
    expect(result.post).toBe(post);
    expect(result.stickyResult).toEqual({
      status: "pinned",
      verifiedStickied: true,
    });
  });
});
