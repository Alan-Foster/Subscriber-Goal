import { beforeEach, describe, expect, it, vi } from "vitest";
import { findLiveHighlightedSubscriberGoalCandidates } from "./liveSubscriberGoalHighlights";

const hoisted = vi.hoisted(() => ({
  isSubscriberGoalPostRetired: vi.fn(),
  registerSubscriberGoalPost: vi.fn(),
}));

vi.mock("../core/postRetirement", () => ({
  isSubscriberGoalPostRetired: hoisted.isSubscriberGoalPostRetired,
}));

vi.mock("./subscriberGoalPostRegistry", () => ({
  registerSubscriberGoalPost: hoisted.registerSubscriberGoalPost,
}));

describe("live Subscriber Goal highlight discovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.isSubscriberGoalPostRetired.mockResolvedValue(false);
  });

  const discover = async ({
    post,
    persisted = [undefined, undefined, undefined],
  }: {
    post: Record<string, unknown>;
    persisted?: Array<string | undefined>;
  }) => {
    const subreddit = {
      id: "t5_example",
      name: "ExampleSub",
      getHighlightedPosts: vi.fn(async () => [{ postId: "t3_live" }]),
    };
    const reddit = {
      getAppUser: vi.fn(async () => ({ username: "subscriber-goal" })),
      getPostById: vi.fn(async () => post),
    };
    const redis = {
      get: vi.fn(async () => undefined),
      hMGet: vi.fn(async () => persisted),
      zAdd: vi.fn(),
    };
    return findLiveHighlightedSubscriberGoalCandidates({
      reddit: reddit as never,
      redis: redis as never,
      subreddit: subreddit as never,
      nowMs: 5_000,
    });
  };

  it("discovers and registers an untracked inline classic goal", async () => {
    const candidates = await discover({
      post: {
        id: "t3_live",
        authorName: "Subscriber-Goal",
        subredditId: "t5_example",
        subredditName: "ExampleSub",
        createdAt: new Date(2_000),
        postData: {
          postKind: "subscriber-goal-v1",
          postHeight: "regular",
        },
      },
    });

    expect(candidates).toMatchObject([
      {
        postId: "t3_live",
        classification: "classic",
        classificationConfidence: "explicit",
        createdAtMs: 2_000,
      },
    ]);
    expect(hoisted.registerSubscriberGoalPost).toHaveBeenCalledWith(
      expect.anything(),
      "t3_live",
      2_000,
    );
  });

  it.each([
    ["subscribe-only-v1", "tiny", "tiny"],
    ["cta-only-v1", "cta", "cta"],
  ] as const)(
    "classifies an inline %s highlight as %s protection",
    async (postKind, postHeight, classification) => {
      const candidates = await discover({
        post: {
          id: "t3_live",
          authorName: "subscriber-goal",
          subredditName: "examplesub",
          createdAt: new Date(2_000),
          postData: { postKind, postHeight },
        },
      });
      expect(candidates[0]?.classification).toBe(classification);
    },
  );

  it("preserves conflicting app-owned metadata as ambiguous", async () => {
    const candidates = await discover({
      post: {
        id: "t3_live",
        authorName: "subscriber-goal",
        subredditId: "t5_example",
        createdAt: new Date(2_000),
        postData: {
          postKind: "subscriber-goal-v1",
          postHeight: "regular",
        },
      },
      persisted: ["subscribe-only-v1", undefined, "tiny"],
    });
    expect(candidates[0]).toMatchObject({
      classification: "ambiguous",
      classificationConfidence: "ambiguous",
    });
  });

  it("ignores a highlighted post that is not owned by the app", async () => {
    await expect(
      discover({
        post: {
          id: "t3_live",
          authorName: "someone-else",
          subredditId: "t5_example",
          createdAt: new Date(2_000),
          postData: {
            postKind: "subscriber-goal-v1",
            postHeight: "regular",
          },
        },
      }),
    ).resolves.toEqual([]);
    expect(hoisted.registerSubscriberGoalPost).not.toHaveBeenCalled();
  });
});
