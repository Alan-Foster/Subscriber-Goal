import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  findExistingSubscriberGoal: vi.fn(),
  getOnboardingSubscriberGoalState: vi.fn(),
  initializeOnboardingSubscriberGoal: vi.fn(),
  markOnboardingSubscriberGoalExisting: vi.fn(),
  markOnboardingSubscriberGoalIneligible: vi.fn(),
  scheduleOnboardingSubscriberGoalAfterWarning: vi.fn(),
}));

vi.mock("./onboardingSubscriberGoal", () => ({
  findExistingSubscriberGoal: hoisted.findExistingSubscriberGoal,
  getOnboardingSubscriberGoalState: hoisted.getOnboardingSubscriberGoalState,
  getDetectionDiagnosticsFromError: () => undefined,
  initializeOnboardingSubscriberGoal:
    hoisted.initializeOnboardingSubscriberGoal,
  markOnboardingSubscriberGoalExisting:
    hoisted.markOnboardingSubscriberGoalExisting,
  markOnboardingSubscriberGoalIneligible:
    hoisted.markOnboardingSubscriberGoalIneligible,
  onboardingMinimumSubscriberCount: 50,
  scheduleOnboardingSubscriberGoalAfterWarning:
    hoisted.scheduleOnboardingSubscriberGoalAfterWarning,
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
    }),
    modMail: { createModNotification: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("onboarding reminder", () => {
  let redis: InMemoryRedis;
  let reddit: ReturnType<typeof createReddit>;

  beforeEach(() => {
    redis = new InMemoryRedis();
    reddit = createReddit();
    vi.spyOn(Math, "random").mockReturnValue(0);
    hoisted.getOnboardingSubscriberGoalState.mockReset();
    hoisted.getOnboardingSubscriberGoalState.mockResolvedValue(undefined);
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
  });

  it("builds an accurate staggered upgrade warning", () => {
    const message = buildOnboardingReminderMessage("ExampleSub", "upgrade");

    expect(message.bodyMarkdown).toContain(
      "24-hour countdown begins when this message is sent",
    );
    expect(message.bodyMarkdown).toContain("following 1,000 minutes");
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

  it.each([0, 3, 49])(
    "sends no warning and cancels automatic creation at %i subscribers",
    async (numberOfSubscribers) => {
      reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers,
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

  it("keeps a community with exactly 50 subscribers eligible", async () => {
    reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 50,
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

  it("builds the requested moderator-facing introduction", () => {
    const message = buildOnboardingReminderMessage("ExampleSub");

    expect(message.subject).toContain("r/ExampleSub");
    expect(message.bodyMarkdown).toContain(
      "https://developers.reddit.com/apps/subscriber-goal",
    );
    expect(message.bodyMarkdown).toContain("u/Alan-Foster");
    expect(message.bodyMarkdown).toContain(
      "24-hour countdown begins when this message is sent",
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

  it("schedules a retry when modmail cannot be sent", async () => {
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
      status: "failed",
      errorMessage: "Error: modmail unavailable",
    });
    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({
      status: "pending",
      result: "failed",
      attempts: "1",
    });
  });
});
