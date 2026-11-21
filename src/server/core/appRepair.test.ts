import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  checkAppAccountHealth: vi.fn(),
  ensureSubscriberGoalPostFlair: vi.fn(),
  backfillSubscriberGoalPostFlair: vi.fn(),
  ensureCommunityPostActivityBackfill: vi.fn(),
  initializeLegacyAfterSubscribeActionMigration: vi.fn(),
  initializePostKindMigration: vi.fn(),
  getSubscriberGoalCandidatePostIds: vi.fn(),
  getTrackedPosts: vi.fn(),
  queueUpdates: vi.fn(),
  ensureExistingSubscriberGoalHighlighted: vi.fn(),
}));

vi.mock("./appAccountHealth", () => ({
  checkAppAccountHealth: hoisted.checkAppAccountHealth,
}));
vi.mock("./subscriberGoalPostFlair", () => ({
  ensureSubscriberGoalPostFlair: hoisted.ensureSubscriberGoalPostFlair,
  backfillSubscriberGoalPostFlair: hoisted.backfillSubscriberGoalPostFlair,
}));
vi.mock("../data/ctaActivity", () => ({
  ensureCommunityPostActivityBackfill:
    hoisted.ensureCommunityPostActivityBackfill,
}));
vi.mock("../data/legacyAfterSubscribeActionMigration", () => ({
  initializeLegacyAfterSubscribeActionMigration:
    hoisted.initializeLegacyAfterSubscribeActionMigration,
}));
vi.mock("../data/postKindMigration", () => ({
  initializePostKindMigration: hoisted.initializePostKindMigration,
}));
vi.mock("../data/subscriberGoalCandidates", () => ({
  getSubscriberGoalCandidatePostIds: hoisted.getSubscriberGoalCandidatePostIds,
}));
vi.mock("../data/updaterData", () => ({
  getTrackedPosts: hoisted.getTrackedPosts,
  queueUpdates: hoisted.queueUpdates,
}));
vi.mock("./onboardingSubscriberGoal", () => ({
  ensureExistingSubscriberGoalHighlighted:
    hoisted.ensureExistingSubscriberGoalHighlighted,
}));

import {
  appRepairLockKey,
  appRepairStateKey,
  processDueAppRepair,
  recurringHighlightRepairIntervalMs,
  scheduleAppRepair,
} from "./appRepair";
import { communityGoalMutationLockKey } from "./communityGoalMutation";
import { scheduleHighlightRepair } from "../data/highlightRepair";
import { watchTestHash } from "../utils/testHashWatch";

class TestRedis {
  values = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async set(
    key: string,
    value: string,
    options?: { nx?: boolean },
  ): Promise<void> {
    if (options?.nx && this.values.has(key)) return;
    this.values.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.values.delete(key);
    this.hashes.delete(key);
  }
  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }
  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }
  async hSet(key: string, fields: Record<string, string>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    Object.entries(fields).forEach(([field, value]) => hash.set(field, value));
    this.hashes.set(key, hash);
  }
  async hMGet(key: string, fields: string[]): Promise<(string | undefined)[]> {
    const hash = this.hashes.get(key);
    return fields.map((field) => hash?.get(field));
  }
  watch(key: string) {
    return watchTestHash(this, key);
  }
}

describe("scheduled app repair", () => {
  let redis: TestRedis;
  const reddit = {
    getCurrentSubreddit: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    redis = new TestRedis();
    reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      type: "public",
      nsfw: false,
    });
    hoisted.checkAppAccountHealth.mockResolvedValue({ status: "healthy" });
    hoisted.ensureSubscriberGoalPostFlair.mockResolvedValue({ id: "flair_1" });
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue([
      "t3_registered",
    ]);
    hoisted.getTrackedPosts.mockResolvedValue(["t3_tracked"]);
    hoisted.ensureExistingSubscriberGoalHighlighted.mockResolvedValue({
      status: "existing",
      reconciliationOutcome: "complete",
      eligiblePostIds: ["t3_registered"],
    });
  });

  it("discovers candidates and initializes the legacy after-subscribe migration in NSFW communities", async () => {
    reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      type: "public",
      nsfw: true,
    });
    await scheduleAppRepair(redis as never, 100, 0);

    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: 100,
      }),
    ).resolves.toBe("complete");

    expect(hoisted.initializePostKindMigration).toHaveBeenCalledWith(
      expect.anything(),
      ["t3_tracked"],
    );
    expect(
      hoisted.initializeLegacyAfterSubscribeActionMigration,
    ).toHaveBeenCalledWith(expect.anything(), ["t3_registered"], {
      name: "ExampleSub",
      type: "public",
    });
    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
      status: "complete",
      recurring: "true",
      nextRunAt: String(100 + recurringHighlightRepairIntervalMs),
      targetPostId: "",
    });
  });

  it("holds the community mutation lease only during highlight reconciliation", async () => {
    for (const phase of [
      hoisted.ensureCommunityPostActivityBackfill,
      hoisted.backfillSubscriberGoalPostFlair,
      hoisted.checkAppAccountHealth,
    ]) {
      phase.mockImplementation(async () =>
        expect(await redis.get(communityGoalMutationLockKey)).toBeUndefined(),
      );
    }
    hoisted.ensureSubscriberGoalPostFlair.mockImplementation(async () => {
      expect(await redis.get(communityGoalMutationLockKey)).toBeUndefined();
      return { id: "flair_1" };
    });
    hoisted.ensureExistingSubscriberGoalHighlighted.mockImplementation(
      async ({ mutationLease }) => {
        expect(await redis.get(communityGoalMutationLockKey)).toBe(
          mutationLease.token,
        );
        return {
          status: "existing",
          reconciliationOutcome: "complete",
          eligiblePostIds: ["t3_registered"],
        };
      },
    );
    await scheduleAppRepair(redis as never, 100, 0);
    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: 100,
      }),
    ).resolves.toBe("complete");
    expect(await redis.get(communityGoalMutationLockKey)).toBeUndefined();
    expect(hoisted.backfillSubscriberGoalPostFlair).toHaveBeenCalledOnce();
    expect(
      hoisted.ensureExistingSubscriberGoalHighlighted,
    ).toHaveBeenCalledOnce();
  });

  it("defers three busy highlight phases at the base delay without counting failures", async () => {
    await redis.set(communityGoalMutationLockKey, "manual-creation");
    await scheduleAppRepair(redis as never, 100, 0);

    for (const nowMs of [100, 300_100, 600_100]) {
      await expect(
        processDueAppRepair({
          reddit: reddit as never,
          redis: redis as never,
          nowMs,
        }),
      ).resolves.toBe("retry");
      expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
        status: "pending",
        attempts: "0",
        nextRunAt: String(nowMs + 300_000),
        lastError: "",
      });
    }
    expect(
      hoisted.ensureExistingSubscriberGoalHighlighted,
    ).not.toHaveBeenCalled();
    expect(hoisted.backfillSubscriberGoalPostFlair).toHaveBeenCalledTimes(3);
    expect(hoisted.checkAppAccountHealth).toHaveBeenCalledTimes(3);
    expect(await redis.get(communityGoalMutationLockKey)).toBe(
      "manual-creation",
    );
  });

  it("rechecks due state after acquiring the app repair lock", async () => {
    await scheduleAppRepair(redis as never, 100, 0);
    const set = redis.set.bind(redis);
    vi.spyOn(redis, "set").mockImplementationOnce(
      async (key, token, options) => {
        expect(key).toBe(appRepairLockKey);
        await redis.hSet(appRepairStateKey, {
          status: "complete",
          recurring: "false",
        });
        await set(key, token, options);
      },
    );

    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: 100,
      }),
    ).resolves.toBe("not_due");
    expect(hoisted.ensureCommunityPostActivityBackfill).not.toHaveBeenCalled();
    expect(await redis.get(appRepairLockKey)).toBeUndefined();
  });

  it.each(["success", "phase failure", "execution failure"] as const)(
    "keeps a forced target scheduled during %s",
    async (outcome) => {
      const nowMs = 100;
      const run = (at: number) =>
        processDueAppRepair({
          reddit: reddit as never,
          redis: redis as never,
          nowMs: at,
        });
      await scheduleAppRepair(redis as never, nowMs, 0);
      await redis.hSet(appRepairStateKey, { attempts: "2" });
      const scheduleDuringRun = async () => {
        expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
          status: "processing",
        });
        await scheduleHighlightRepair(redis as never, {
          nowMs,
          delayMs: (outcome === "execution failure" ? 60 : 5) * 60 * 1000,
          force: true,
          reason: "manual_creation_highlight_degraded",
          targetPostId: "t3_expected",
        });
        if (outcome !== "success") throw new Error("repair failure");
      };
      if (outcome === "execution failure") {
        reddit.getCurrentSubreddit.mockImplementationOnce(scheduleDuringRun);
      } else {
        hoisted.checkAppAccountHealth.mockImplementationOnce(scheduleDuringRun);
      }

      await expect(run(nowMs)).resolves.toBe("retry");
      const nextRunAt =
        nowMs + (outcome === "execution failure" ? 20 : 5) * 60 * 1000;
      expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
        status: "pending",
        nextRunAt: String(nextRunAt),
        scheduledAt: String(nowMs),
        targetPostId: "t3_expected",
        reason: "manual_creation_highlight_degraded",
        attempts: outcome === "success" ? "2" : "3",
      });
      await expect(run(nextRunAt - 1)).resolves.toBe("not_due");
      await expect(run(nextRunAt)).resolves.toBe("complete");
      expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
        status: "complete",
        targetPostId: "",
      });
    },
  );

  it("retries the completion write if a forced request lands after its read", async () => {
    await scheduleAppRepair(redis as never, 100, 0);
    hoisted.checkAppAccountHealth.mockImplementationOnce(async () => {
      const watch = redis.watch.bind(redis);
      vi.spyOn(redis, "watch").mockImplementationOnce(async (key) => {
        const transaction = await watch(key);
        return {
          ...transaction,
          exec: async () => {
            await scheduleHighlightRepair(redis as never, {
              nowMs: 101,
              delayMs: 300_000,
              force: true,
              reason: "manual_creation_highlight_degraded",
              targetPostId: "t3_expected",
            });
            return transaction.exec();
          },
        };
      });
    });

    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: 100,
      }),
    ).resolves.toBe("retry");
    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
      status: "pending",
      nextRunAt: "300101",
      scheduledAt: "101",
      targetPostId: "t3_expected",
    });
  });

  it("keeps a forced follow-up scheduled by highlight reconciliation", async () => {
    const nowMs = 100;
    const delayMs = 60 * 60 * 1000;
    await scheduleAppRepair(redis as never, nowMs, 0);
    await redis.hSet(appRepairStateKey, { attempts: "5" });
    hoisted.ensureExistingSubscriberGoalHighlighted.mockImplementationOnce(
      async () => {
        await scheduleHighlightRepair(redis as never, {
          nowMs,
          delayMs,
          force: true,
          reason: "contradictory_highlight_state",
        });
        return {
          status: "existing_not_highlighted",
          reconciliationOutcome: "degraded",
        };
      },
    );

    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs,
      }),
    ).resolves.toBe("retry");
    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
      status: "pending",
      nextRunAt: String(nowMs + delayMs),
      reason: "contradictory_highlight_state",
      attempts: "6",
    });
  });

  it("runs reconciliation again when the recurring active-surface check is due", async () => {
    await redis.hSet(appRepairStateKey, {
      version: "app_repair_community_highlights_v3",
      status: "complete",
      recurring: "true",
      nextRunAt: "200",
    });

    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: 199,
      }),
    ).resolves.toBe("not_due");
    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: 200,
      }),
    ).resolves.toBe("complete");

    expect(
      hoisted.ensureExistingSubscriberGoalHighlighted,
    ).toHaveBeenCalledOnce();
    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
      status: "complete",
      recurring: "true",
      nextRunAt: String(200 + recurringHighlightRepairIntervalMs),
    });
  });

  it("can schedule another lifecycle repair after completion", async () => {
    await redis.hSet(appRepairStateKey, {
      version: "app_repair_community_highlights_v3",
      status: "complete",
      completedAt: "90",
      attempts: "4",
      lastError: "old failure",
    });

    await scheduleAppRepair(redis as never, 100, 0);

    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
      status: "pending",
      nextRunAt: "100",
      attempts: "0",
      lastError: "",
      scheduledAt: "100",
    });
  });

  it("retries discovery failures without completing empty migrations", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    hoisted.getSubscriberGoalCandidatePostIds.mockRejectedValue(
      new Error("registry unavailable"),
    );
    await scheduleAppRepair(redis as never, 100, 0);

    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: 100,
      }),
    ).resolves.toBe("retry");

    expect(hoisted.initializePostKindMigration).not.toHaveBeenCalled();
    expect(
      hoisted.initializeLegacyAfterSubscribeActionMigration,
    ).not.toHaveBeenCalled();
    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
      status: "pending",
      attempts: "1",
    });
  });

  it.each(["only_removed", "live_unpinned", "live_degraded"])(
    "handles removal pauses without hiding live repair failures (%s)",
    async (scenario) => {
      hoisted.ensureExistingSubscriberGoalHighlighted.mockResolvedValue({
        status: "existing_not_highlighted",
        pausedByRemovedGoal: true,
        removedGoalBlockerPostIds: ["t3_removed"],
        eligiblePostIds: ["t3_removed", "t3_live"],
        unhighlightedEligiblePostIds:
          scenario === "live_unpinned"
            ? ["t3_removed", "t3_live"]
            : ["t3_removed"],
        ...(scenario === "live_degraded"
          ? { reconciliationOutcome: "degraded" }
          : {}),
      });
      await scheduleAppRepair(redis as never, 100, 0);
      const run = (nowMs: number) =>
        processDueAppRepair({
          reddit: reddit as never,
          redis: redis as never,
          nowMs,
        });
      await expect(run(100)).resolves.toBe(
        scenario === "only_removed" ? "complete" : "retry",
      );
      if (scenario === "only_removed") {
        expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
          status: "complete",
          recurring: "true",
          attempts: "0",
          nextRunAt: String(100 + recurringHighlightRepairIntervalMs),
        });
        await expect(
          run(100 + recurringHighlightRepairIntervalMs),
        ).resolves.toBe("complete");
        expect(
          hoisted.ensureExistingSubscriberGoalHighlighted,
        ).toHaveBeenCalledTimes(2);
      } else {
        expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
          status: "pending",
          attempts: "1",
        });
      }
    },
  );

  it("completes a capacity-only pass and schedules the normal recurring check", async () => {
    hoisted.ensureExistingSubscriberGoalHighlighted.mockResolvedValue({
      status: "existing_not_highlighted",
      capacityOnly: true,
      reconciliationOutcome: "failed",
      eligiblePostIds: ["t3_full"],
      unhighlightedEligiblePostIds: ["t3_full"],
    });
    await scheduleAppRepair(redis as never, 100, 0);
    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: 100,
      }),
    ).resolves.toBe("complete");
    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
      status: "complete",
      recurring: "true",
      attempts: "0",
      nextRunAt: String(100 + recurringHighlightRepairIntervalMs),
    });
  });

  it("retries when Community Highlight reconciliation cannot safely complete", async () => {
    hoisted.ensureExistingSubscriberGoalHighlighted.mockResolvedValue({
      status: "existing_not_highlighted",
      errorMessage: "All six Community Highlight slots are protected.",
    });
    await scheduleAppRepair(redis as never, 100, 0);

    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: 100,
      }),
    ).resolves.toBe("retry");

    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
      status: "pending",
      attempts: "1",
      lastError: expect.stringContaining("six Community Highlight slots"),
    });
  });

  it("completes after a successful discovery finds no eligible post", async () => {
    hoisted.ensureExistingSubscriberGoalHighlighted.mockResolvedValue({
      status: "missing",
    });
    await scheduleAppRepair(redis as never, 100, 0);

    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: 100,
      }),
    ).resolves.toBe("complete");

    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
      status: "complete",
      recurring: "false",
      lastError: "",
    });
  });

  it("retries when an expected repair target is still missing", async () => {
    hoisted.ensureExistingSubscriberGoalHighlighted.mockResolvedValue({
      status: "missing",
    });
    await scheduleAppRepair(redis as never, 100, 0);
    await redis.hSet(appRepairStateKey, { targetPostId: "t3_expected" });

    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: 100,
      }),
    ).resolves.toBe("retry");

    expect(await redis.hGetAll(appRepairStateKey)).toMatchObject({
      status: "pending",
      attempts: "1",
      lastError: expect.stringContaining("reconciliation failed"),
    });
  });

  it("does nothing until lifecycle initialization creates the repair marker", async () => {
    await expect(
      processDueAppRepair({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: 100,
      }),
    ).resolves.toBe("not_due");
    expect(reddit.getCurrentSubreddit).not.toHaveBeenCalled();
  });
});
