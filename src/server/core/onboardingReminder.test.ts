import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  findExistingSubscriberGoal: vi.fn(),
  getOnboardingSubscriberGoalState: vi.fn(),
  initializeOnboardingSubscriberGoal: vi.fn(),
  markOnboardingSubscriberGoalExisting: vi.fn(),
  markOnboardingSubscriberGoalIneligible: vi.fn(),
  markOnboardingSubscriberGoalCancelled: vi.fn(),
  scheduleOnboardingSubscriberGoalAfterWarning: vi.fn(),
  checkAppAccountHealth: vi.fn(),
}));

vi.mock("./onboardingSubscriberGoal", () => ({
  AUTOMATIC_ONBOARDING_ENABLED: true,
  findExistingSubscriberGoal: hoisted.findExistingSubscriberGoal,
  getOnboardingEligibility: (subreddit: {
    numberOfSubscribers: number;
    type?: unknown;
  }) => ({
    eligible:
      subreddit.numberOfSubscribers >= 40 && subreddit.type === "public",
    subscriberCount: subreddit.numberOfSubscribers,
    subredditType:
      typeof subreddit.type === "string" ? subreddit.type : "unknown",
    ...(subreddit.numberOfSubscribers < 40
      ? { reason: "subscriber_count" }
      : subreddit.type !== "public"
        ? { reason: "subreddit_not_public" }
        : {}),
  }),
  getOnboardingSubscriberGoalState: hoisted.getOnboardingSubscriberGoalState,
  getDetectionDiagnosticsFromError: () => undefined,
  initializeOnboardingSubscriberGoal:
    hoisted.initializeOnboardingSubscriberGoal,
  markOnboardingSubscriberGoalExisting:
    hoisted.markOnboardingSubscriberGoalExisting,
  markOnboardingSubscriberGoalIneligible:
    hoisted.markOnboardingSubscriberGoalIneligible,
  markOnboardingSubscriberGoalCancelled:
    hoisted.markOnboardingSubscriberGoalCancelled,
  onboardingMinimumSubscriberCount: 40,
  onboardingMaxAttempts: 3,
  selectOnboardingRetryDelayMs: () => 5 * 60 * 1000,
  scheduleOnboardingSubscriberGoalAfterWarning:
    hoisted.scheduleOnboardingSubscriberGoalAfterWarning,
}));

vi.mock("./appAccountHealth", () => ({
  checkAppAccountHealth: hoisted.checkAppAccountHealth,
}));

import {
  buildOnboardingReminderMessage,
  onboardingReminderDelayMs,
  onboardingReminderLockKey,
  onboardingReminderStaggerMaxMinutes,
  onboardingReminderStaggerMinMinutes,
  onboardingReminderStateKey,
  processDueOnboardingReminder,
  scheduleOnboardingReminder,
  selectOnboardingReminderStaggerMinutes,
} from "./onboardingReminder";
import {
  onboardingGoalBaseDelayMs,
  onboardingGoalStaggerMaxMinutes,
} from "./onboardingConfig";

class InMemoryRedis {
  hashes = new Map<string, Map<string, string>>();
  values = new Map<string, string>();

  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hSet(key: string, values: Record<string, string>): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(values)) hash.set(field, value);
    this.hashes.set(key, hash);
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: boolean },
  ): Promise<void> {
    if (options?.nx && this.values.has(key)) return;
    this.values.set(key, value);
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const nowMs = Date.parse("2026-08-29T12:00:00.000Z");

function createReddit() {
  return {
    getCurrentSubreddit: vi.fn().mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 91,
      type: "public",
    }),
    modMail: { createModNotification: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("onboarding reminder", () => {
  let redis: InMemoryRedis;
  let reddit: ReturnType<typeof createReddit>;

  beforeEach(() => {
    vi.restoreAllMocks();
    redis = new InMemoryRedis();
    reddit = createReddit();
    vi.spyOn(Math, "random").mockReturnValue(0);
    hoisted.getOnboardingSubscriberGoalState.mockReset();
    hoisted.getOnboardingSubscriberGoalState.mockResolvedValue({
      version: 4,
      status: "awaiting_warning",
      lifecycleSource: "upgrade",
      armedAt: nowMs,
      creationStaggerMinutes: 1,
      attemptCount: 0,
      lastAttemptAt: "",
      lastRetryDelayMs: 0,
      completedAt: "",
      result: "",
      createdPostId: "",
      errorMessage: "",
    });
    hoisted.initializeOnboardingSubscriberGoal.mockReset();
    hoisted.initializeOnboardingSubscriberGoal.mockResolvedValue(undefined);
    hoisted.markOnboardingSubscriberGoalExisting.mockReset();
    hoisted.markOnboardingSubscriberGoalExisting.mockResolvedValue(undefined);
    hoisted.scheduleOnboardingSubscriberGoalAfterWarning.mockReset();
    hoisted.scheduleOnboardingSubscriberGoalAfterWarning.mockResolvedValue(
      undefined,
    );
    hoisted.findExistingSubscriberGoal.mockReset();
    hoisted.markOnboardingSubscriberGoalIneligible.mockReset();
    hoisted.markOnboardingSubscriberGoalIneligible.mockResolvedValue(undefined);
    hoisted.findExistingSubscriberGoal.mockResolvedValue({
      trackedInspected: 0,
      pinnedInspected: 0,
      recentInspected: 0,
    });
    hoisted.markOnboardingSubscriberGoalCancelled.mockReset();
    hoisted.markOnboardingSubscriberGoalCancelled.mockResolvedValue(undefined);
    hoisted.checkAppAccountHealth.mockReset();
    hoisted.checkAppAccountHealth.mockResolvedValue({
      status: "healthy",
      healthy: true,
      appUsername: "subscriber-goal",
      permissions: ["posts"],
      notification: "not_needed",
    });
  });

  it("builds an accurate staggered upgrade warning", () => {
    const message = buildOnboardingReminderMessage("ExampleSub", "upgrade");
    const baseDelayMinutes = onboardingGoalBaseDelayMs / (60 * 1000);
    const baseDelayLabel = Number.isInteger(baseDelayMinutes / 60)
      ? `${(baseDelayMinutes / 60).toLocaleString("en-US")}-hour`
      : `${baseDelayMinutes.toLocaleString("en-US")}-minute`;

    expect(message.bodyMarkdown).toContain(
      `${baseDelayLabel} countdown begins when this message is sent`,
    );
    expect(message.bodyMarkdown).toContain(
      `following ${onboardingGoalStaggerMaxMinutes.toLocaleString("en-US")} minutes`,
    );
    expect(message.bodyMarkdown).not.toContain("23 hours and 59 minutes");
  });

  it("selects inclusive reminder stagger boundaries", () => {
    expect(selectOnboardingReminderStaggerMinutes(0)).toBe(
      onboardingReminderStaggerMinMinutes,
    );
    expect(selectOnboardingReminderStaggerMinutes(1)).toBe(
      onboardingReminderStaggerMaxMinutes,
    );
  });

  it("persists the configured maximum reminder delay", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    await scheduleOnboardingReminder(redis as never, {
      lifecycleSource: "install",
      nowMs,
    });

    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({
      reminderStaggerMinutes: String(onboardingReminderStaggerMaxMinutes),
      nextRunAt: String(
        nowMs + onboardingReminderStaggerMaxMinutes * 60 * 1000,
      ),
    });
  });

  it("keeps one reminder offset under concurrent NX initialization", async () => {
    await Promise.all([
      scheduleOnboardingReminder(redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
      scheduleOnboardingReminder(redis as never, {
        lifecycleSource: "upgrade",
        nowMs: nowMs + 1,
      }),
    ]);
    const first = await redis.hGetAll(onboardingReminderStateKey);
    await scheduleOnboardingReminder(redis as never, {
      lifecycleSource: "upgrade",
      nowMs: nowMs + 2,
    });
    await expect(redis.hGetAll(onboardingReminderStateKey)).resolves.toEqual(
      first,
    );
  });

  it.each([0, 3, 39])(
    "sends no warning and cancels automatic creation at %i subscribers",
    async (numberOfSubscribers) => {
      reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers,
        type: "public",
      });
      await scheduleOnboardingReminder(redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      });

      await expect(
        processDueOnboardingReminder({
          reddit: reddit as never,
          redis: redis as never,
          nowMs: nowMs + onboardingReminderDelayMs,
        }),
      ).resolves.toMatchObject({
        status: "ineligible",
        eligibilitySubscriberCount: numberOfSubscribers,
      });
      expect(
        hoisted.markOnboardingSubscriberGoalIneligible,
      ).toHaveBeenCalledWith(
        expect.anything(),
        numberOfSubscribers,
        nowMs + onboardingReminderDelayMs,
      );
      expect(hoisted.findExistingSubscriberGoal).not.toHaveBeenCalled();
      expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
    },
  );

  it("keeps a community with exactly 40 subscribers eligible", async () => {
    reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 40,
      type: "public",
    });
    await scheduleOnboardingReminder(redis as never, { nowMs });

    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + onboardingReminderDelayMs,
      }),
    ).resolves.toMatchObject({ status: "sent" });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
  });

  it.each(["restricted", "private", undefined])(
    "sends no warning for a %s subreddit with enough subscribers",
    async (type) => {
      reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers: 40,
        type,
      });
      await scheduleOnboardingReminder(redis as never, { nowMs });

      await expect(
        processDueOnboardingReminder({
          reddit: reddit as never,
          redis: redis as never,
          nowMs: nowMs + onboardingReminderDelayMs,
        }),
      ).resolves.toMatchObject({
        status: "ineligible",
        eligibilitySubscriberCount: 40,
      });
      expect(hoisted.findExistingSubscriberGoal).not.toHaveBeenCalled();
      expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
    },
  );

  it("builds the requested moderator-facing introduction", () => {
    const message = buildOnboardingReminderMessage("ExampleSub");

    expect(message.subject).toContain("r/ExampleSub");
    expect(message.bodyMarkdown).toContain(
      "https://developers.reddit.com/apps/subscriber-goal",
    );
    expect(message.bodyMarkdown).toContain("u/Alan-Foster");
    expect(message.bodyMarkdown).toContain(
      "countdown begins when this message is sent",
    );
    expect(message.bodyMarkdown).not.toContain("or update");
  });

  it("waits one minute, then sends one modmail when no goal exists", async () => {
    await scheduleOnboardingReminder(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });

    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + onboardingReminderDelayMs - 1,
      }),
    ).resolves.toMatchObject({ status: "not_due" });
    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + onboardingReminderDelayMs,
      }),
    ).resolves.toMatchObject({ status: "sent" });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledTimes(1);
    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + onboardingReminderDelayMs + 60_000,
      }),
    ).resolves.toMatchObject({ status: "complete" });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledTimes(1);
  });

  it.each([
    "registered",
    "tracked",
    "queued",
    "persisted",
    "pinned",
    "recent",
  ] as const)(
    "suppresses modmail when the detector finds an existing %s goal",
    async (source) => {
      await scheduleOnboardingReminder(redis as never, {
        lifecycleSource: "install",
        nowMs,
      });
      hoisted.findExistingSubscriberGoal.mockResolvedValue({
        postId: "t3_existing",
        source,
        trackedInspected: source === "tracked" ? 1 : 0,
        pinnedInspected: source === "pinned" ? 3 : 0,
        recentInspected: source === "recent" ? 2 : 0,
      });

      await expect(
        processDueOnboardingReminder({
          reddit: reddit as never,
          redis: redis as never,
          nowMs: nowMs + onboardingReminderDelayMs,
        }),
      ).resolves.toMatchObject({
        status: "existing",
        postId: "t3_existing",
        existingSource: source,
      });
      expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
      await expect(
        redis.hGetAll(onboardingReminderStateKey),
      ).resolves.toMatchObject({
        status: "complete",
        result: "existing",
      });
    },
  );

  it("does not send duplicate modmail while another scheduler run holds the lock", async () => {
    await scheduleOnboardingReminder(redis as never, { nowMs });
    await redis.set(onboardingReminderLockKey, "other-run");

    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + onboardingReminderDelayMs,
      }),
    ).resolves.toMatchObject({ status: "not_due" });
    expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
  });

  it("cancels without modmail when Manage Posts cannot be verified", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await scheduleOnboardingReminder(redis as never, { nowMs });
    hoisted.checkAppAccountHealth.mockResolvedValue({
      status: "unknown",
      healthy: false,
      permissions: [],
      notification: "not_needed",
    });

    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + onboardingReminderDelayMs,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(hoisted.checkAppAccountHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        notify: false,
        scheduleUnknownRetry: false,
      }),
    );
    expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      result: "cancelled_permission",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"onboarding_reminder_cancelled"'),
    );
  });

  it("pauses an armed reminder and re-randomizes it when re-enabled", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await scheduleOnboardingReminder(redis as never, { nowMs });
    const dueAt = nowMs + onboardingReminderDelayMs;

    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: dueAt,
        automationEnabled: false,
      }),
    ).resolves.toMatchObject({ status: "paused" });
    expect(reddit.getCurrentSubreddit).not.toHaveBeenCalled();

    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: dueAt + 1,
        automationEnabled: true,
      }),
    ).resolves.toMatchObject({ status: "not_due" });
    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({
      status: "pending",
      nextRunAt: String(dueAt + 1 + 60_000),
      pausedAt: "",
    });
    expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
  });

  it("stops pre-dispatch failures after three total attempts", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await scheduleOnboardingReminder(redis as never, { nowMs });
    hoisted.findExistingSubscriberGoal.mockRejectedValue(
      new Error("lookup unavailable"),
    );

    let runAt = nowMs + onboardingReminderDelayMs;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: runAt,
      });
      const state = await redis.hGetAll(onboardingReminderStateKey);
      expect(state.attempts).toBe(String(attempt));
      if (attempt < 3) runAt = Number(state.nextRunAt);
    }

    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      result: "retry_exhausted",
      attempts: "3",
    });
    expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
  });

  it("cancels a stale dispatching state without resending", async () => {
    await scheduleOnboardingReminder(redis as never, { nowMs });
    await redis.hSet(onboardingReminderStateKey, {
      status: "dispatching",
      dispatchToken: "legacy-dispatch",
    });

    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + onboardingReminderDelayMs,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
    expect(hoisted.markOnboardingSubscriberGoalCancelled).toHaveBeenCalledWith(
      expect.anything(),
      "delivery_unknown",
      nowMs + onboardingReminderDelayMs,
      expect.any(String),
    );
  });

  it("cancels when a started modmail dispatch cannot be confirmed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await scheduleOnboardingReminder(redis as never, { nowMs });
    reddit.modMail.createModNotification.mockRejectedValue(
      new Error("modmail unavailable"),
    );

    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + onboardingReminderDelayMs,
      }),
    ).resolves.toMatchObject({
      status: "cancelled",
      errorMessage: "Error: modmail unavailable",
    });
    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      result: "delivery_unknown",
    });
    expect(hoisted.markOnboardingSubscriberGoalCancelled).toHaveBeenCalledWith(
      expect.anything(),
      "delivery_unknown",
      nowMs + onboardingReminderDelayMs,
      "Error: modmail unavailable",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"onboarding_modmail_delivery_unknown"'),
    );
  });

  it("cancels when sent-modmail confirmation cannot be persisted", async () => {
    await scheduleOnboardingReminder(redis as never, { nowMs });
    const originalHSet = redis.hSet.bind(redis);
    reddit.modMail.createModNotification.mockImplementation(async () => {
      vi.spyOn(redis, "hSet").mockImplementation(async (key, fields) => {
        if (key === onboardingReminderStateKey && fields.result === "sent") {
          throw new Error("confirmation unavailable");
        }
        return originalHSet(key, fields);
      });
    });

    await expect(
      processDueOnboardingReminder({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + onboardingReminderDelayMs,
      }),
    ).resolves.toMatchObject({
      status: "cancelled",
      errorMessage: "Error: confirmation unavailable",
    });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({
      status: "complete",
      result: "delivery_unknown",
    });
    expect(
      hoisted.scheduleOnboardingSubscriberGoalAfterWarning,
    ).not.toHaveBeenCalled();
  });
});
