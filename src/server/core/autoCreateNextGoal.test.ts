import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAppSettings } from "../settings";
import { processDueAutoCreateNextGoals } from "./autoCreateNextGoal";
import { SubscriberGoalCreationOutcomeUnknownError } from "./createSubscriberGoal";

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
};

const hoisted = vi.hoisted(() => ({
  cancelAllAutoCreateNextGoals: vi.fn(),
  cancelAutoCreateNextGoal: vi.fn(),
  checkCompletionStatus: vi.fn(),
  getAutoCreateNextGoalRunAt: vi.fn(),
  getDueAutoCreateNextGoalPostIds: vi.fn(),
  getSubGoalData: vi.fn(),
  markAutoCreateNextGoalExhausted: vi.fn(),
  markAutoCreateNextGoalReconciliationExhausted: vi.fn(),
  recordAutoCreateNextGoalFailure: vi.fn(),
  scheduleAutoCreateNextGoalReconciliation: vi.fn(),
  createSubscriberGoal: vi.fn(),
  notifyHighlightFailure: vi.fn(),
  retireSubscriberGoalPost: vi.fn(),
  getSubscriberGoalCandidatePostIds: vi.fn(),
  checkAppAccountHealth: vi.fn(),
  findLiveHighlightedSubscriberGoalCandidates: vi.fn(),
  ensureExistingSubscriberGoalHighlighted: vi.fn(),
  reddit: {
    getPostById: vi.fn(),
    getCurrentSubreddit: vi.fn(),
    modMail: { createModNotification: vi.fn() },
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
    hDel: vi.fn(async (key: string, fields: string[]) => {
      for (const field of fields) hoisted.redisHashes.get(key)?.delete(field);
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
  markAutoCreateNextGoalReconciliationExhausted:
    hoisted.markAutoCreateNextGoalReconciliationExhausted,
  recordAutoCreateNextGoalFailure: hoisted.recordAutoCreateNextGoalFailure,
  scheduleAutoCreateNextGoalReconciliation:
    hoisted.scheduleAutoCreateNextGoalReconciliation,
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
  SubscriberGoalCreationOutcomeUnknownError: class extends Error {
    reconciliationStatus: "pending" | "exhausted";
    reconciliationAttempts: number;
    reconciliationNextAt?: number;

    constructor(
      _language?: unknown,
      reconciliation = {
        status: "pending" as const,
        attempts: 0,
        nextAt: 86_461_000,
      },
    ) {
      super("submission unresolved");
      this.reconciliationStatus = reconciliation.status;
      this.reconciliationAttempts = reconciliation.attempts;
      this.reconciliationNextAt = reconciliation.nextAt;
    }
  },
}));

vi.mock("./appAccountHealth", () => ({
  checkAppAccountHealth: hoisted.checkAppAccountHealth,
}));

vi.mock("../data/liveSubscriberGoalHighlights", () => ({
  findLiveHighlightedSubscriberGoalCandidates:
    hoisted.findLiveHighlightedSubscriberGoalCandidates,
}));

vi.mock("./onboardingSubscriberGoal", () => ({
  ensureExistingSubscriberGoalHighlighted:
    hoisted.ensureExistingSubscriberGoalHighlighted,
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
    hoisted.ensureExistingSubscriberGoalHighlighted.mockResolvedValue({
      status: "missing",
      eligiblePostIds: [],
    });
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
    hoisted.ensureExistingSubscriberGoalHighlighted.mockResolvedValue({
      status: "existing",
      postId: "t3_tiny",
      classification: "tiny",
      eligiblePostIds: ["t3_tiny"],
    });
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
    expect(
      hoisted.scheduleAutoCreateNextGoalReconciliation,
    ).toHaveBeenCalledWith(hoisted.redis, "t3_source", expect.any(Number));
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
  });

  it("resumes the deferred successor after a Tiny blocker is retired", async () => {
    let runAt = 0;
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.getAutoCreateNextGoalRunAt.mockImplementation(async () => runAt);
    hoisted.scheduleAutoCreateNextGoalReconciliation.mockImplementation(
      async (_redis, _postId, nextRunAt: number) => {
        runAt = nextRunAt;
      },
    );
    hoisted.ensureExistingSubscriberGoalHighlighted
      .mockResolvedValueOnce({
        status: "existing",
        postId: "t3_tiny",
        classification: "tiny",
        eligiblePostIds: ["t3_tiny"],
      })
      .mockResolvedValueOnce({ status: "missing", eligiblePostIds: [] });

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
        nowMs: 1_000,
      }),
    ).resolves.toMatchObject({ created: 0, skipped: 1, rescheduled: 1 });
    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
        nowMs: runAt,
      }),
    ).resolves.toMatchObject({ created: 1, skipped: 0 });
    expect(hoisted.createSubscriberGoal).toHaveBeenCalledOnce();
  });

  it("does not let a newer completed classic suppress required creation", async () => {
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
    ).resolves.toMatchObject({ due: 1, created: 1, skipped: 0 });
    expect(
      hoisted.redisHashes
        .get("auto_create_next_goal_v1_successors")
        ?.get("t3_source"),
    ).toBe("t3_next");
    expect(hoisted.createSubscriberGoal).toHaveBeenCalledOnce();
  });

  it("reuses an older unpinned 75/100 goal when the 75/75 source completes", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_goal_75"]);
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 75,
      completedTime: 1_000,
      autoCreateNextGoal: true,
      language: "en",
    });
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_goal_75",
      createdAt: new Date("2026-09-02T00:00:00Z"),
    });
    hoisted.ensureExistingSubscriberGoalHighlighted.mockImplementation(
      async () => {
        await hoisted.redis.hSet("auto_create_next_goal_v1_successors", {
          t3_goal_75: "t3_goal_100",
        });
        return {
          status: "existing",
          postId: "t3_goal_100",
          classification: "classic",
          eligiblePostIds: ["t3_goal_100"],
          unhighlightedEligiblePostIds: [],
        };
      },
    );

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
      }),
    ).resolves.toMatchObject({ created: 0, skipped: 1, failed: 0 });

    expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
    expect(
      hoisted.redisHashes
        .get("auto_create_next_goal_v1_successors")
        ?.get("t3_goal_75"),
    ).toBe("t3_goal_100");
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_goal_75",
    );
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
        automaticPermissionCheck: true,
        operationId: "auto-next:t3_source",
        reconciliationContext: "automatic_successor",
        reconciliationNowMs: 86_401_000,
        mutationLease: expect.objectContaining({
          key: "subscriber_goal_community_mutation_v1_lock",
        }),
      },
    });
    expect(hoisted.cancelAutoCreateNextGoal).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_source",
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

  it("reports an unresolved submission without spending the ordinary retry budget", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.createSubscriberGoal.mockRejectedValue(
      new SubscriberGoalCreationOutcomeUnknownError(),
    );

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
        nowMs: 86_401_000,
      }),
    ).resolves.toMatchObject({
      due: 1,
      created: 0,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
      unresolved: 1,
      reconciliationRescheduled: 1,
    });

    expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
    expect(hoisted.markAutoCreateNextGoalExhausted).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
    expect(
      hoisted.scheduleAutoCreateNextGoalReconciliation,
    ).toHaveBeenCalledWith(hoisted.redis, "t3_source", 86_461_000);
  });

  it("honors the reconciliation score on a stale scheduler tick", async () => {
    let runAt = 0;
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.getAutoCreateNextGoalRunAt.mockImplementation(async () => runAt);
    hoisted.scheduleAutoCreateNextGoalReconciliation.mockImplementation(
      async (_redis, _postId, nextRunAt: number) => {
        runAt = nextRunAt;
      },
    );
    hoisted.createSubscriberGoal.mockRejectedValue(
      new SubscriberGoalCreationOutcomeUnknownError(undefined, {
        status: "pending",
        attempts: 1,
        nextAt: 90_000,
      }),
    );

    await processDueAutoCreateNextGoals({
      reddit: hoisted.reddit as never,
      redis: hoisted.redis as never,
      appSettings: baseSettings,
      nowMs: 10_000,
    });
    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
        nowMs: 89_999,
      }),
    ).resolves.toMatchObject({ skipped: 1, failed: 0 });

    expect(hoisted.createSubscriberGoal).toHaveBeenCalledOnce();
    expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
  });

  it("removes an exhausted reconciliation without changing ordinary retries", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.createSubscriberGoal.mockRejectedValue(
      new SubscriberGoalCreationOutcomeUnknownError(undefined, {
        status: "exhausted",
        attempts: 6,
      }),
    );

    await expect(
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
        nowMs: 86_401_000,
      }),
    ).resolves.toMatchObject({
      unresolved: 1,
      reconciliationExhausted: 1,
      failed: 0,
      rescheduled: 0,
      exhausted: 0,
    });

    expect(
      hoisted.markAutoCreateNextGoalReconciliationExhausted,
    ).toHaveBeenCalledWith(hoisted.redis, "t3_source", "auto-next:t3_source");
    expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
  });

  it("adopts an untracked incomplete highlighted classic as the live successor", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.ensureExistingSubscriberGoalHighlighted.mockImplementation(
      async () => {
        await hoisted.redis.hSet("auto_create_next_goal_v1_successors", {
          t3_source: "t3_live",
        });
        return {
          status: "existing",
          postId: "t3_live",
          classification: "classic",
          eligiblePostIds: ["t3_live"],
        };
      },
    );
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
      hoisted.ensureExistingSubscriberGoalHighlighted.mockResolvedValue({
        status: "existing",
        postId: "t3_live",
        classification,
        eligiblePostIds: classification === "ambiguous" ? [] : ["t3_live"],
      });
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

    expect(
      hoisted.ensureExistingSubscriberGoalHighlighted,
    ).toHaveBeenCalledOnce();
  });

  it("reschedules when the live Highlights check fails", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.ensureExistingSubscriberGoalHighlighted.mockRejectedValue(
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
    expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
    expect(
      hoisted.scheduleAutoCreateNextGoalReconciliation,
    ).toHaveBeenCalledWith(hoisted.redis, "t3_source", expect.any(Number));
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

  it.each([true, undefined])(
    "creates a public successor without crossposting when nsfw=%s",
    async (nsfw) => {
      hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
      hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "examplesub",
        numberOfSubscribers: 12,
        type: "public",
        nsfw,
      });
      const action = {
        type: "top-post-day",
        buttonText: "Top today",
        colorTheme: "blue",
      };
      hoisted.getSubGoalData.mockResolvedValue({
        ...(await hoisted.getSubGoalData()),
        afterSubscribeAction: action,
        afterSubscribePreset: "top-post-day",
      });
      await expect(
        processDueAutoCreateNextGoals({
          reddit: hoisted.reddit as never,
          redis: hoisted.redis as never,
          appSettings: baseSettings,
        }),
      ).resolves.toMatchObject({ created: 1, failed: 0, rescheduled: 0 });
      expect(hoisted.createSubscriberGoal).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          options: expect.objectContaining({
            crosspost: false,
            afterSubscribeAction: action,
            afterSubscribePreset: "top-post-day",
          }),
        }),
      );
    },
  );

  it.each(["restricted", "private"])(
    "suppresses automatic replacement in a %s subreddit",
    async (type) => {
      hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
      hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "examplesub",
        numberOfSubscribers: 12,
        type,
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
    expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
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

  it.each([
    "moderator",
    "automod_filtered",
    "reddit",
    "community_ops",
    "unrecognized",
  ])(
    "keeps a %s-removed source queued past 48 hours and resumes after approval",
    async (category) => {
      const { temporarilyRemovedPostRecheckDelayMs } =
        await import("../utils/postStatus");
      const source = {
        id: "t3_source",
        removedByCategory: category as string | undefined,
      };
      let runAt = 86_401_000;
      hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
      hoisted.getAutoCreateNextGoalRunAt.mockImplementation(async () => runAt);
      hoisted.scheduleAutoCreateNextGoalReconciliation.mockImplementation(
        async (_redis, _post, next: number) => {
          runAt = next;
        },
      );
      hoisted.reddit.getPostById.mockResolvedValue(source);
      const run = (nowMs: number) =>
        processDueAutoCreateNextGoals({
          reddit: hoisted.reddit as never,
          redis: hoisted.redis as never,
          appSettings: baseSettings,
          nowMs,
        });
      for (const nowMs of [86_401_000, 86_401_000 + 72 * 3_600_000]) {
        await expect(run(nowMs)).resolves.toMatchObject({
          created: 0,
          skipped: 1,
          rescheduled: 1,
          failed: 0,
          exhausted: 0,
        });
        expect(runAt).toBe(nowMs + temporarilyRemovedPostRecheckDelayMs);
      }
      expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
      expect(hoisted.markAutoCreateNextGoalExhausted).not.toHaveBeenCalled();
      expect(hoisted.retireSubscriberGoalPost).not.toHaveBeenCalled();
      expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
      expect(
        hoisted.ensureExistingSubscriberGoalHighlighted,
      ).not.toHaveBeenCalled();
      source.removedByCategory = undefined;
      await expect(run(runAt)).resolves.toMatchObject({ created: 1 });
      expect(hoisted.createSubscriberGoal).toHaveBeenCalledOnce();
      expect(
        hoisted.createSubscriberGoal.mock.calls[0]?.[0]?.options.operationId,
      ).toBe("auto-next:t3_source");
    },
  );

  it.each(["deleted", "author"])(
    "still retires a terminal %s source",
    async (category) => {
      hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
      hoisted.reddit.getPostById.mockResolvedValue({
        id: "t3_source",
        removedByCategory: category,
      });
      await processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
        nowMs: 86_401_000,
      });
      expect(hoisted.retireSubscriberGoalPost).toHaveBeenCalledWith(
        hoisted.redis,
        "t3_source",
        "removedByCategory:" + category,
        86_401_000,
      );
      expect(hoisted.createSubscriberGoal).not.toHaveBeenCalled();
      expect(
        hoisted.scheduleAutoCreateNextGoalReconciliation,
      ).not.toHaveBeenCalled();
    },
  );

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

  it.each(["unknown", "unhealthy"] as const)(
    "defers %s worker preflight before inventory and honors its backoff",
    async (status) => {
      let runAt = 1_000;
      hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
      hoisted.getAutoCreateNextGoalRunAt.mockImplementation(async () => runAt);
      hoisted.scheduleAutoCreateNextGoalReconciliation.mockImplementation(
        async (_redis, _post, at: number) => {
          runAt = at;
        },
      );
      hoisted.checkAppAccountHealth.mockResolvedValue({
        status,
        healthy: false,
      });
      const run = (nowMs: number) =>
        processDueAutoCreateNextGoals({
          reddit: hoisted.reddit as never,
          redis: hoisted.redis as never,
          appSettings: baseSettings,
          nowMs,
        });
      await expect(run(1_000)).resolves.toMatchObject({
        rescheduled: 1,
        exhausted: 0,
      });
      expect(runAt).toBe(301_000);
      await run(61_000);
      expect(hoisted.checkAppAccountHealth).toHaveBeenCalledOnce();
      expect(
        hoisted.ensureExistingSubscriberGoalHighlighted,
      ).not.toHaveBeenCalled();
      expect(hoisted.reddit.getPostById).not.toHaveBeenCalled();
      await run(runAt);
      expect(runAt).toBe(901_000);
      expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
      hoisted.checkAppAccountHealth.mockResolvedValue({
        status: "healthy",
        healthy: true,
      });
      await expect(run(runAt)).resolves.toMatchObject({ created: 1 });
      expect(
        hoisted.checkAppAccountHealth.mock.invocationCallOrder.at(-1),
      ).toBeLessThan(
        hoisted.ensureExistingSubscriberGoalHighlighted.mock
          .invocationCallOrder[0]!,
      );
    },
  );

  it("defers unknown subreddit type and resumes the same successor when public", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.reddit.getCurrentSubreddit.mockResolvedValueOnce({
      nsfw: false,
      name: "ExampleSub",
    });
    const run = (nowMs: number) =>
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
        nowMs,
      });
    await expect(run(1_000)).resolves.toMatchObject({ rescheduled: 1 });
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
    expect(
      hoisted.ensureExistingSubscriberGoalHighlighted,
    ).not.toHaveBeenCalled();
    expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
    await expect(run(301_000)).resolves.toMatchObject({ created: 1 });
    expect(
      hoisted.createSubscriberGoal.mock.calls[0]?.[0]?.options.operationId,
    ).toBe("auto-next:t3_source");
  });

  it.each(["source", "inventory", "redis"])(
    "keeps %s uncertainty outside creation attempts across repeated failures",
    async (failure) => {
      hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
      const mock =
        failure === "source"
          ? hoisted.reddit.getPostById
          : failure === "inventory"
            ? hoisted.ensureExistingSubscriberGoalHighlighted
            : hoisted.getSubGoalData;
      const original = await mock();
      mock.mockRejectedValue(new Error("temporarily unavailable"));
      let nowMs = 1_000;
      for (let attempt = 0; attempt < 8; attempt++) {
        await processDueAutoCreateNextGoals({
          reddit: hoisted.reddit as never,
          redis: hoisted.redis as never,
          appSettings: baseSettings,
          nowMs,
        });
        const nextAt =
          hoisted.scheduleAutoCreateNextGoalReconciliation.mock.calls.at(
            -1,
          )?.[2] as number;
        expect(nextAt - nowMs).toBeLessThanOrEqual(3_600_000);
        expect(nextAt).toBeGreaterThan(nowMs);
        nowMs = nextAt;
      }
      expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
      expect(hoisted.markAutoCreateNextGoalExhausted).not.toHaveBeenCalled();
      mock.mockResolvedValue(original);
      await expect(
        processDueAutoCreateNextGoals({
          reddit: hoisted.reddit as never,
          redis: hoisted.redis as never,
          appSettings: baseSettings,
          nowMs,
        }),
      ).resolves.toMatchObject({ created: 1 });
    },
  );

  it.each([false, true])(
    "deduplicates terminal successor notices (unresolved=%s)",
    async (unresolved) => {
      hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
      hoisted.recordAutoCreateNextGoalFailure.mockResolvedValue({
        failureCount: 6,
        retryAt: null,
      });
      hoisted.createSubscriberGoal.mockRejectedValue(
        unresolved
          ? new SubscriberGoalCreationOutcomeUnknownError(undefined, {
              status: "exhausted",
              attempts: 6,
            } as never)
          : new Error("confirmed failure"),
      );
      for (let tick = 0; tick < 2; tick++)
        await processDueAutoCreateNextGoals({
          reddit: hoisted.reddit as never,
          redis: hoisted.redis as never,
          appSettings: baseSettings,
          nowMs: 1_000 + tick,
        });
      expect(
        hoisted.reddit.modMail.createModNotification,
      ).toHaveBeenCalledOnce();
      expect(
        hoisted.reddit.modMail.createModNotification.mock.calls[0]?.[0]
          ?.bodyMarkdown,
      ).toContain("auto-next:t3_source");
    },
  );

  it("retries an unknown subreddit type even when NSFW is confirmed", async () => {
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      name: "ExampleSub",
      nsfw: true,
    });
    await processDueAutoCreateNextGoals({
      reddit: hoisted.reddit as never,
      redis: hoisted.redis as never,
      appSettings: baseSettings,
      nowMs: 1_000,
    });
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
    expect(
      hoisted.scheduleAutoCreateNextGoalReconciliation,
    ).toHaveBeenCalledOnce();
    expect(
      hoisted.ensureExistingSubscriberGoalHighlighted,
    ).not.toHaveBeenCalled();
  });

  it("exhausts prerequisite uncertainty after 48 hours and sends one notice", async () => {
    const {
      automaticGoalPrerequisiteMaxAgeMs,
      automaticGoalPrerequisiteRetriesKey,
    } = await import("./automaticGoalRetry");
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.checkAppAccountHealth.mockResolvedValue({
      status: "unknown",
      healthy: false,
    });
    const run = (nowMs: number) =>
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
        nowMs,
      });
    await expect(run(1_000)).resolves.toMatchObject({
      rescheduled: 1,
      exhausted: 0,
    });
    hoisted.markAutoCreateNextGoalExhausted.mockImplementation(async () => {
      hoisted.getAutoCreateNextGoalRunAt.mockResolvedValue(undefined);
    });
    await expect(
      run(1_000 + automaticGoalPrerequisiteMaxAgeMs),
    ).resolves.toMatchObject({ rescheduled: 0, exhausted: 1 });
    await run(2_000 + automaticGoalPrerequisiteMaxAgeMs);
    expect(hoisted.reddit.modMail.createModNotification).toHaveBeenCalledOnce();
    expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
    expect(
      hoisted.redisHashes.get(automaticGoalPrerequisiteRetriesKey)?.size,
    ).toBe(0);
  });

  it("clears prerequisite fields when a successor recovers before the ceiling", async () => {
    const { automaticGoalPrerequisiteRetriesKey } =
      await import("./automaticGoalRetry");
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.checkAppAccountHealth.mockResolvedValueOnce({
      status: "unhealthy",
      healthy: false,
    });
    const run = (nowMs: number) =>
      processDueAutoCreateNextGoals({
        reddit: hoisted.reddit as never,
        redis: hoisted.redis as never,
        appSettings: baseSettings,
        nowMs,
      });
    await run(1_000);
    expect(
      hoisted.redisHashes.get(automaticGoalPrerequisiteRetriesKey)?.size,
    ).toBe(2);
    await expect(run(301_000)).resolves.toMatchObject({ created: 1 });
    expect(
      hoisted.redisHashes.get(automaticGoalPrerequisiteRetriesKey)?.size,
    ).toBe(0);
  });

  it("keeps recovery of a removed successor pending without charging creation attempts", async () => {
    const {
      PostTemporarilyUnavailableError,
      temporarilyRemovedPostRecheckDelayMs: hour,
    } = await import("../utils/postStatus");
    hoisted.getDueAutoCreateNextGoalPostIds.mockResolvedValue(["t3_source"]);
    hoisted.createSubscriberGoal.mockRejectedValue(
      new PostTemporarilyUnavailableError("t3_recovered", "automod_filtered"),
    );
    for (const nowMs of [86_401_000, 86_401_000 + 72 * hour]) {
      await expect(
        processDueAutoCreateNextGoals({
          reddit: hoisted.reddit as never,
          redis: hoisted.redis as never,
          appSettings: baseSettings,
          nowMs,
        }),
      ).resolves.toMatchObject({
        created: 0,
        skipped: 1,
        rescheduled: 1,
        exhausted: 0,
        failed: 0,
      });
      expect(
        hoisted.scheduleAutoCreateNextGoalReconciliation,
      ).toHaveBeenLastCalledWith(hoisted.redis, "t3_source", nowMs + hour);
    }
    expect(hoisted.recordAutoCreateNextGoalFailure).not.toHaveBeenCalled();
    expect(hoisted.markAutoCreateNextGoalExhausted).not.toHaveBeenCalled();
    expect(hoisted.cancelAutoCreateNextGoal).not.toHaveBeenCalled();
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

    expect(hoisted.notifyHighlightFailure).toHaveBeenCalledExactlyOnceWith({
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
