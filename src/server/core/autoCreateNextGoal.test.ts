import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAppSettings } from "../settings";
import { processDueAutoCreateNextGoals } from "./autoCreateNextGoal";

const baseSettings: ServerAppSettings = {
  promoSubreddit: "SubGoal",
  crosspostAuthoritySubreddit: "SubGoal",
  crosspostMaxSourcePostAgeMinutes: 10,
  crosspostIngestionEnabled: true,
  crosspostMaxRevisionAgeMinutes: 10,
  maxCrosspostsPerRun: 2,
  maxCrosspostsPerHour: 10,
  crosspostRetryWindowMinutes: 1440,
  crosspostRetryBaseDelaySeconds: 60,
  crosspostRetryMaxDelayMinutes: 30,
  crosspostPendingBatchSize: 25,
};

const successfulHighlightResult = {
  status: "highlighted" as const,
  selectedPostId: "t3_next" as const,
  verifiedHighlighted: true,
  issues: [],
  capacityOutcome: "slot_available" as const,
  cleanupOutcome: "not_needed" as const,
  removedManagedHighlightIds: [],
  preservedHighlightIds: [],
  rollbackOutcome: "not_needed" as const,
  reorderOutcome: "reordered" as const,
};

const hoisted = vi.hoisted(() => ({
  cancelAllAutoCreateNextGoals: vi.fn(),
  cancelAutoCreateNextGoal: vi.fn(),
  checkCompletionStatus: vi.fn(),
  getAutoCreateNextGoalRunAt: vi.fn(),
  getDueAutoCreateNextGoalPostIds: vi.fn(),
  getSubGoalData: vi.fn(),
  markAutoCreateNextGoalExhausted: vi.fn(),
  recordAutoCreateNextGoalFailure: vi.fn(),
  createSubscriberGoal: vi.fn(),
  notifyHighlightFailure: vi.fn(),
  retireSubscriberGoalPost: vi.fn(),
  getSubscriberGoalCandidatePostIds: vi.fn(),
  checkAppAccountHealth: vi.fn(),
  findLiveHighlightedSubscriberGoalCandidates: vi.fn(),
  reddit: {
    getPostById: vi.fn(),
    getCurrentSubreddit: vi.fn(),
  },
  redisValues: new Map<string, string>(),
  redisHashes: new Map<string, Map<string, string>>(),
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
    }),
    hGet: vi.fn(async (key: string, field: string) =>
      hoisted.redisHashes.get(key)?.get(field),
    ),
    hSet: vi.fn(async (key: string, fields: Record<string, string>) => {
      const hash = hoisted.redisHashes.get(key) ?? new Map<string, string>();
      Object.entries(fields).forEach(([field, value]) =>
        hash.set(field, value),
      );
      hoisted.redisHashes.set(key, hash);
    }),
    hMGet: vi.fn(async (key: string, fields: string[]) =>
      fields.map((field) => hoisted.redisHashes.get(key)?.get(field)),
    ),
  },
}));

vi.mock("../data/subGoalData", () => ({
  autoCreateNextGoalSuccessorsKey: "auto_create_next_goal_v1_successors",
  subscriberGoalsKey: "subscriber_goals",
  postKindSuffix: "_post_kind",
  postHeightSuffix: "_post_height",
  cancelAllAutoCreateNextGoals: hoisted.cancelAllAutoCreateNextGoals,
  cancelAutoCreateNextGoal: hoisted.cancelAutoCreateNextGoal,
  checkCompletionStatus: hoisted.checkCompletionStatus,
  getAutoCreateNextGoalRunAt: hoisted.getAutoCreateNextGoalRunAt,
  getDueAutoCreateNextGoalPostIds: hoisted.getDueAutoCreateNextGoalPostIds,
  getSubGoalData: hoisted.getSubGoalData,
  markAutoCreateNextGoalExhausted: hoisted.markAutoCreateNextGoalExhausted,
  recordAutoCreateNextGoalFailure: hoisted.recordAutoCreateNextGoalFailure,
}));

vi.mock("../data/subscriberGoalCandidates", () => ({
  getSubscriberGoalCandidatePostIds: hoisted.getSubscriberGoalCandidatePostIds,
}));

vi.mock("./postRetirement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./postRetirement")>()),
  retireSubscriberGoalPost: hoisted.retireSubscriberGoalPost,
}));

vi.mock("./createSubscriberGoal", () => ({
  createSubscriberGoal: hoisted.createSubscriberGoal,
}));

vi.mock("./appAccountHealth", () => ({
  checkAppAccountHealth: hoisted.checkAppAccountHealth,
}));

vi.mock("../data/liveSubscriberGoalHighlights", () => ({
  findLiveHighlightedSubscriberGoalCandidates:
    hoisted.findLiveHighlightedSubscriberGoalCandidates,
}));

vi.mock("../utils/highlightFailureNotifications", () => ({
  getPostUrl: vi.fn((post: { permalink?: string; url?: string }) =>
    post.permalink ? `https://reddit.com${post.permalink}` : post.url,
  ),
  notifyHighlightFailure: hoisted.notifyHighlightFailure,
}));

describe("processDueAutoCreateNextGoals", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.redisValues.clear();
    hoisted.redisHashes.clear();
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue([]);
    hoisted.getAutoCreateNextGoalRunAt.mockResolvedValue(0);
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue([]);
    hoisted.findLiveHighlightedSubscriberGoalCandidates.mockResolvedValue([]);
    hoisted.checkCompletionStatus.mockResolvedValue(undefined);
    hoisted.checkAppAccountHealth.mockResolvedValue({
      status: "healthy",
      healthy: true,
      permissions: ["posts"],
      notification: "not_needed",
    });
    hoisted.recordAutoCreateNextGoalFailure.mockResolvedValue({
      failureCount: 1,
      retryAt: 301_000,
    });
    hoisted.markAutoCreateNextGoalExhausted.mockResolvedValue(undefined);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 5,
      recentSubscriber: "",
      completedTime: 1_000,
      subredditDisplayName: "ExampleSub",
      colorTheme: "purple",
      postHeight: "short",
      autoCreateNextGoal: true,
      language: "en",
      afterSubscribeAction: {
        type: "link",
        buttonText: "Join the Discord",
        url: "https://discord.com/invite/example",
        colorTheme: "pink",
      },
      afterSubscribePreset: "discord",
    });
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "examplesub",
      numberOfSubscribers: 12,
      type: "public",
      nsfw: false,
    });
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_source",
      removedByCategory: undefined,
    });
    hoisted.createSubscriberGoal.mockResolvedValue({
      post: {
        id: "t3_next",
        title: "Welcome to r/ExampleSub!",
        permalink: "/r/examplesub/comments/next",
      },
      crosspostDispatchResult: { status: "success" },
      highlightResult: successfulHighlightResult,
    });
  });

  it("does not create a goal before any job is due", async () => {
    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["reddit"],
        redis: hoisted.redis as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["redis"],
        appSettings: baseSettings,
        nowMs: 10,
      }),
    ).resolves.toEqual({
      due: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("skips a stale due snapshot after another worker moves the source into retry backoff", async () => {
    const queueState = { score: 301_000, failureCount: 2 };
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.getAutoCreateNextGoalRunAt.mockImplementation(
      async () => queueState.score,
    );

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
        nowMs: 10_000,
      }),
    ).resolves.toMatchObject({
      due: 1,
      created: 0,
      skipped: 1,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    expect(queueState).toEqual({ score: 301_000, failureCount: 2 });
    expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
    expect(hoisted.reddit.getPostById).not.toHaveBeenCalled();
    expect(hoisted.reddit.getCurrentSubreddit).not.toHaveBeenCalled();
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.redis.set).not.toHaveBeenCalledWith(
      "auto_create_next_goal_v1_lock:t3_source",
      expect.anything(),
      expect.anything(),
    );
  });

  it("skips a stale due snapshot after another worker removes the source", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.getAutoCreateNextGoalRunAt.mockResolvedValue(undefined);

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
        nowMs: 10_000,
      }),
    ).resolves.toMatchObject({
      due: 1,
      created: 0,
      skipped: 1,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
  });

  it("suppresses a due successor while orphaned-goal onboarding owns it", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.redisHashes.set(
      "onboarding_subscriber_goal_v4_state",
      new Map([
        ["intent", "orphaned_completed_goal"],
        ["replacementSourcePostId", "t3_source"],
        ["status", "awaiting_warning"],
      ]),
    );

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
      }),
    ).resolves.toMatchObject({ due: 1, created: 0, skipped: 1 });
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_source",
    );
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("lets a valid Tiny primary suppress a due milestone successor", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue(["t3_tiny"]);
    hoisted.redisHashes.set(
      "subscriber_goals",
      new Map([
        ["t3_tiny_post_kind", "subscribe-only-v1"],
        ["t3_tiny_post_height", "tiny"],
      ]),
    );
    hoisted.reddit.getPostById.mockImplementation(async (postId: string) => ({
      id: postId,
      createdAt: new Date(),
      removedByCategory: undefined,
    }));

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
      }),
    ).resolves.toMatchObject({ due: 1, created: 0, skipped: 1 });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("adopts a newer completed classic instead of creating from an older source", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue([
      "t3_source",
      "t3_newer_completed",
    ]);
    hoisted.redisHashes.set(
      "subscriber_goals",
      new Map([
        ["t3_source_post_kind", "subscriber-goal-v1"],
        ["t3_source_post_height", "regular"],
        ["t3_newer_completed_post_kind", "subscriber-goal-v1"],
        ["t3_newer_completed_post_height", "short"],
      ]),
    );
    hoisted.reddit.getPostById.mockImplementation(async (postId: string) => ({
      id: postId,
      createdAt: new Date(
        postId === "t3_source"
          ? "2026-09-01T00:00:00Z"
          : "2026-09-02T00:00:00Z",
      ),
      removedByCategory: undefined,
    }));

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
      }),
    ).resolves.toMatchObject({ due: 1, created: 0, skipped: 1 });
    expect(
      hoisted.redisHashes
        .get("auto_create_next_goal_v1_successors")
        ?.get("t3_source"),
    ).toBe("t3_newer_completed");
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_source",
    );
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it("creates the next milestone below the onboarding minimum and carries display settings forward", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["reddit"],
        redis: hoisted.redis as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["redis"],
        appSettings: baseSettings,
        nowMs: 86_401_000,
      }),
    ).resolves.toEqual({
      due: 1,
      created: 1,
      skipped: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    expect(hoisted.createSubscriberGoal).toHaveBeenCalledWith({
      reddit: hoisted.reddit,
      redis: hoisted.redis,
      appSettings: baseSettings,
      options: {
        title: "Welcome to r/\u200BExampleSub!",
        goal: 15,
        subredditDisplayName: "ExampleSub",
        crosspost: true,
        colorTheme: "purple",
        postHeight: "short",
        autoCreateNextGoal: true,
        language: "en",
        afterSubscribeAction: {
          type: "link",
          buttonText: "Join the Discord",
          url: "https://discord.com/invite/example",
          colorTheme: "pink",
        },
        afterSubscribePreset: "discord",
        cancelPendingAutoCreateGoals: false,
        operationId: "auto-next:t3_source",
        reconciliationContext: "automatic_successor",
        mutationLease: expect.objectContaining({
          key: "subscriber_goal_community_mutation_v1_lock",
        }),
      },
    });
    expect(hoisted.cancelAllAutoCreateNextGoals).toHaveBeenCalledWith(
      hoisted.redis,
    );
  });

  it("does not map or cancel follow-up work for a superseded creation retry", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.createSubscriberGoal.mockResolvedValue({
      outcome: "superseded",
      post: { id: "t3_stale" },
      supersedingPostId: "t3_newer",
      crosspostDispatchResult: { status: "skipped" },
      highlightResult: successfulHighlightResult,
    });
    hoisted.redisHashes.set(
      "auto_create_next_goal_v1_successors",
      new Map([["t3_unrelated", "t3_newer"]]),
    );

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
        nowMs: 86_401_000,
      }),
    ).resolves.toMatchObject({ created: 0, skipped: 1, failed: 0 });

    expect(
      hoisted.redisHashes.get("auto_create_next_goal_v1_successors"),
    ).toEqual(new Map([["t3_unrelated", "t3_newer"]]));
    expect(hoisted.cancelAllAutoCreateNextGoals).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
  });

  it("adopts an untracked incomplete highlighted classic as the live successor", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.findLiveHighlightedSubscriberGoalCandidates.mockResolvedValue([
      {
        postId: "t3_live",
        post: { id: "t3_live", postData: { goal: 20 } },
        source: "highlighted",
        createdAtMs: 2_000,
        classification: "classic",
        classificationConfidence: "explicit",
        discoveryOrder: 0,
      },
    ]);
    hoisted.getSubGoalData.mockImplementation(async (_redis, postId) =>
      postId === "t3_live"
        ? { goal: 20, completedTime: 0 }
        : {
            goal: 5,
            completedTime: 1_000,
            autoCreateNextGoal: true,
            language: "en",
          },
    );

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
      }),
    ).resolves.toMatchObject({ created: 0, skipped: 1, failed: 0 });

    expect(
      hoisted.redisHashes
        .get("auto_create_next_goal_v1_successors")
        ?.get("t3_source"),
    ).toBe("t3_live");
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_source",
    );
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
  });

  it.each([
    ["tiny", "explicit"],
    ["cta", "explicit"],
    ["ambiguous", "ambiguous"],
  ] as const)(
    "preserves a highlighted %s app-owned experience without mapping a classic successor",
    async (classification, classificationConfidence) => {
      hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
      hoisted.findLiveHighlightedSubscriberGoalCandidates.mockResolvedValue([
        {
          postId: "t3_live",
          post: { id: "t3_live" },
          source: "highlighted",
          classification,
          classificationConfidence,
          discoveryOrder: 0,
        },
      ]);

      await expect(
        processDueAutoCreateNextGoals({
          reddit: hoisted.reddit as never,
          redis: hoisted.redis as never,
          appSettings: baseSettings,
        }),
      ).resolves.toMatchObject({ created: 0, skipped: 1, failed: 0 });

      expect(
        hoisted.redisHashes.get("auto_create_next_goal_v1_successors"),
      ).toBeUndefined();
      expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    },
  );

  it("allows creation when the live highlighted classic is complete", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.findLiveHighlightedSubscriberGoalCandidates.mockResolvedValue([
      {
        postId: "t3_completed",
        post: { id: "t3_completed" },
        source: "highlighted",
        classification: "classic",
        classificationConfidence: "explicit",
        discoveryOrder: 0,
      },
    ]);
    hoisted.getSubGoalData.mockImplementation(async (_redis, postId) =>
      postId === "t3_completed"
        ? { goal: 10, completedTime: 2_000 }
        : {
            goal: 5,
            completedTime: 1_000,
            autoCreateNextGoal: true,
            language: "en",
          },
    );

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
      }),
    ).resolves.toMatchObject({ created: 1, skipped: 0, failed: 0 });
  });

  it("reconciles a stale highlighted goal as complete before allowing creation", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.findLiveHighlightedSubscriberGoalCandidates.mockResolvedValue([
      {
        postId: "t3_reached",
        post: { id: "t3_reached" },
        source: "highlighted",
        classification: "classic",
        classificationConfidence: "explicit",
        discoveryOrder: 0,
      },
    ]);
    hoisted.getSubGoalData.mockImplementation(async (_redis, postId) =>
      postId === "t3_reached"
        ? { goal: 10, completedTime: 0 }
        : {
            goal: 5,
            completedTime: 1_000,
            autoCreateNextGoal: true,
            language: "en",
          },
    );
    hoisted.checkCompletionStatus.mockResolvedValue(3_000);

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
      }),
    ).resolves.toMatchObject({ created: 1, skipped: 0, failed: 0 });

    expect(hoisted.checkCompletionStatus).toHaveBeenCalledWith(
      hoisted.reddit,
      hoisted.redis,
      "t3_reached",
      expect.objectContaining({
        scheduleAutomaticSuccessor: false,
        automaticSuccessorSuppression: "auto_goal_reconciliation",
      }),
    );
  });

  it("reschedules when the live Highlights check fails", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.findLiveHighlightedSubscriberGoalCandidates.mockRejectedValue(
      new Error("highlights unavailable"),
    );

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
      }),
    ).resolves.toMatchObject({
      created: 0,
      failed: 1,
      rescheduled: 1,
    });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.recordAutoCreateNextGoalFailure).toHaveBeenCalled();
  });

  it("inherits the source goal language instead of re-detecting the subreddit language", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 5,
      recentSubscriber: "",
      completedTime: 1_000,
      subredditDisplayName: "ExampleSub",
      colorTheme: "purple",
      postHeight: "short",
      autoCreateNextGoal: true,
      language: "pt",
      afterSubscribeAction: { type: "disabled" },
      afterSubscribePreset: null,
    });
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "examplesub",
      numberOfSubscribers: 12,
      type: "public",
      nsfw: false,
      language: "de",
    });

    await processDueAutoCreateNextGoals({
      reddit: hoisted.reddit as Parameters<
        typeof processDueAutoCreateNextGoals
      >[0]["reddit"],
      redis: hoisted.redis as Parameters<
        typeof processDueAutoCreateNextGoals
      >[0]["redis"],
      appSettings: baseSettings,
    });

    expect(hoisted.createSubscriberGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          title: "Bem-vindo ao r/\u200BExampleSub!",
          language: "pt",
        }),
      }),
    );
  });

  it("suppresses automatic replacement in an NSFW subreddit", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "examplesub",
      numberOfSubscribers: 12,
      type: "public",
      nsfw: true,
    });

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["reddit"],
        redis: hoisted.redis as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["redis"],
        appSettings: baseSettings,
      }),
    ).resolves.toEqual({
      due: 1,
      created: 0,
      skipped: 1,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
  });

  it.each(["restricted", "private"])(
    "suppresses automatic replacement in a %s subreddit",
    async (type) => {
      hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
      hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "examplesub",
        numberOfSubscribers: 12,
        type,
        nsfw: false,
      });

      await expect(
        processDueAutoCreateNextGoals({
          reddit: hoisted.reddit as Parameters<
            typeof processDueAutoCreateNextGoals
          >[0]["reddit"],
          redis: hoisted.redis as Parameters<
            typeof processDueAutoCreateNextGoals
          >[0]["redis"],
          appSettings: baseSettings,
        }),
      ).resolves.toMatchObject({
        due: 1,
        created: 0,
        skipped: 1,
        failed: 0,
        rescheduled: 0,
      });

      expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
      expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
    },
  );

  it("suppresses automatic replacement when safety metadata is missing", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "examplesub",
      numberOfSubscribers: 12,
      type: "public",
    });

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["reddit"],
        redis: hoisted.redis as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["redis"],
        appSettings: baseSettings,
      }),
    ).resolves.toMatchObject({ created: 0, skipped: 1, failed: 0 });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
  });

  it("reschedules when subreddit eligibility cannot be fetched", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.reddit.getCurrentSubreddit.mockRejectedValue(
      new Error("subreddit unavailable"),
    );

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["reddit"],
        redis: hoisted.redis as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["redis"],
        appSettings: baseSettings,
      }),
    ).resolves.toMatchObject({
      due: 1,
      created: 0,
      failed: 1,
      rescheduled: 1,
    });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.recordAutoCreateNextGoalFailure).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_source",
      expect.any(Number),
    );
  });

  it("inherits Spanish and uses the localized default title", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 5,
      recentSubscriber: "",
      completedTime: 1_000,
      subredditDisplayName: "ExampleSub",
      colorTheme: "blue",
      postHeight: "regular",
      autoCreateNextGoal: true,
      language: "es",
    });

    await processDueAutoCreateNextGoals({
      reddit: hoisted.reddit as Parameters<
        typeof processDueAutoCreateNextGoals
      >[0]["reddit"],
      redis: hoisted.redis as Parameters<
        typeof processDueAutoCreateNextGoals
      >[0]["redis"],
      appSettings: baseSettings,
    });

    expect(hoisted.createSubscriberGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          title: "¡Bienvenido a r/\u200BExampleSub!",
          language: "es",
        }),
      }),
    );
  });

  it("skips stale due jobs whose source goal is not completed", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 5,
      recentSubscriber: "",
      completedTime: 0,
      subredditDisplayName: "ExampleSub",
      colorTheme: "purple",
      postHeight: "regular",
      autoCreateNextGoal: true,
      language: "en",
    });

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["reddit"],
        redis: hoisted.redis as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["redis"],
        appSettings: baseSettings,
      }),
    ).resolves.toEqual({
      due: 1,
      created: 0,
      skipped: 1,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_source",
    );
  });

  it("skips due jobs whose source post has been removed", async () => {
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_source",
      removedByCategory: "moderator",
    });

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["reddit"],
        redis: hoisted.redis as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["redis"],
        appSettings: baseSettings,
      }),
    ).resolves.toEqual({
      due: 1,
      created: 0,
      skipped: 1,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.retireSubscriberGoalPost).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_source",
      "removedByCategory:moderator",
      expect.any(Number),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[autoCreateNextGoal] skipping inactive source post: sourcePostId=t3_source reason=removedByCategory:moderator",
    );
  });

  it("skips due jobs whose source post is missing", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.reddit.getPostById.mockRejectedValue(
      Object.assign(new Error("post has been deleted"), { status: 404 }),
    );

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["reddit"],
        redis: hoisted.redis as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["redis"],
        appSettings: baseSettings,
      }),
    ).resolves.toEqual({
      due: 1,
      created: 0,
      skipped: 1,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(hoisted.retireSubscriberGoalPost).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_source",
      "confirmed_missing_auto_successor_source",
      expect.any(Number),
    );
  });

  it("reschedules a failed automatic creation", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.createSubscriberGoal.mockRejectedValue(new Error("post failed"));

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["reddit"],
        redis: hoisted.redis as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["redis"],
        appSettings: baseSettings,
      }),
    ).resolves.toEqual({
      due: 1,
      created: 0,
      skipped: 0,
      failed: 1,
      rescheduled: 1,
      exhausted: 0,
    });

    expect(hoisted.recordAutoCreateNextGoalFailure).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_source",
      expect.any(Number),
    );
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
  });

  it("marks a failed automatic creation after retries are exhausted", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.createSubscriberGoal.mockRejectedValue(new Error("post failed"));
    hoisted.recordAutoCreateNextGoalFailure.mockResolvedValue({
      failureCount: 6,
      retryAt: null,
    });

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["reddit"],
        redis: hoisted.redis as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["redis"],
        appSettings: baseSettings,
      }),
    ).resolves.toEqual({
      due: 1,
      created: 0,
      skipped: 0,
      failed: 1,
      rescheduled: 0,
      exhausted: 1,
    });

    expect(hoisted.markAutoCreateNextGoalExhausted).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_source",
      6,
    );
  });

  it("notifies moderators when an auto-created goal cannot be highlighted", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.createSubscriberGoal.mockResolvedValue({
      post: {
        id: "t3_next",
        title: "Welcome to r/ExampleSub!",
        permalink: "/r/examplesub/comments/next",
      },
      crosspostDispatchResult: { status: "success" },
      highlightResult: {
        status: "not_highlighted",
        selectedPostId: "t3_next",
        errorMessage: "highlight slots full",
        verifiedHighlighted: false,
        failureCategory: "capacity",
        issues: [{ category: "capacity", message: "highlight slots full" }],
        capacityOutcome: "blocked",
        cleanupOutcome: "not_needed",
        removedManagedHighlightIds: [],
        preservedHighlightIds: [],
        rollbackOutcome: "not_needed",
        reorderOutcome: "not_attempted",
      },
    });

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["reddit"],
        redis: hoisted.redis as Parameters<
          typeof processDueAutoCreateNextGoals
        >[0]["redis"],
        appSettings: baseSettings,
      }),
    ).resolves.toEqual({
      due: 1,
      created: 1,
      skipped: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    expect(hoisted.notifyHighlightFailure).toHaveBeenCalledWith({
      reddit: hoisted.reddit,
      subredditId: "t5_example",
      subredditName: "examplesub",
      postTitle: "Welcome to r/ExampleSub!",
      postUrl: "https://reddit.com/r/examplesub/comments/next",
      errorMessage: "highlight slots full",
      language: "en",
      highlightResult: expect.objectContaining({
        status: "not_highlighted",
        failureCategory: "capacity",
      }),
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"auto_create_goal_degraded"'),
    );
    warnSpy.mockRestore();
  });

  it("allows only one overlapping successor creation", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    let finishCreation!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    hoisted.createSubscriberGoal.mockImplementation(
      () =>
        new Promise((resolve) => {
          markStarted();
          finishCreation = () =>
            resolve({
              post: { id: "t3_next", title: "Next goal" },
              crosspostDispatchResult: { status: "skipped" },
              highlightResult: successfulHighlightResult,
              flairResult: { status: "omitted", reason: "missing_permission" },
            });
        }),
    );

    const first = processDueAutoCreateNextGoals({
      reddit: hoisted.reddit as never,
      redis: hoisted.redis as never,
      appSettings: baseSettings,
    });
    await started;
    const second = await processDueAutoCreateNextGoals({
      reddit: hoisted.reddit as never,
      redis: hoisted.redis as never,
      appSettings: baseSettings,
    });
    finishCreation();
    await first;

    expect(second).toMatchObject({ created: 0, skipped: 1 });
    expect(hoisted.createSubscriberGoal).toHaveBeenCalledOnce();
  });
});
