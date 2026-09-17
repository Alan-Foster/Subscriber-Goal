import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  onboardingSubscriberGoalLockKey,
  onboardingSubscriberGoalStateKey,
} from "./onboardingSubscriberGoal";
import {
  onboardingReminderLockKey,
  onboardingReminderStateKey,
} from "./onboardingReminder";
import { rearmPreviouslyIneligibleOnboarding } from "./onboardingLifecycle";

class InMemoryRedis {
  hashes = new Map<string, Map<string, string>>();
  values = new Map<string, string>();
  failReminderWrite = false;

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

  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hSet(key: string, values: Record<string, string>): Promise<void> {
    if (key === onboardingReminderStateKey && this.failReminderWrite) {
      throw new Error("reminder write failed");
    }
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(values)) hash.set(field, value);
    this.hashes.set(key, hash);
  }
}

const oldArmedAt = Date.parse("2026-09-16T12:00:00.000Z");
const nowMs = Date.parse("2026-09-17T12:00:00.000Z");

async function seedCompletedIneligible(redis: InMemoryRedis): Promise<void> {
  await redis.hSet(onboardingSubscriberGoalStateKey, {
    version: "onboarding_subscriber_goal_v4",
    status: "complete",
    nextRunAt: "",
    armedAt: String(oldArmedAt),
    lifecycleSource: "upgrade",
    creationStaggerMinutes: "4",
    reminderSentAt: "",
    operationId: `onboarding:onboarding_subscriber_goal_v4:${oldArmedAt}`,
    eligibilitySubscriberCount: "44",
    completedAt: String(oldArmedAt + 60_000),
    resultStatus: "ineligible",
  });
  await redis.hSet(onboardingReminderStateKey, {
    version: "onboarding_reminder_v3",
    status: "complete",
    nextRunAt: String(oldArmedAt + 60_000),
    armedAt: String(oldArmedAt),
    lifecycleSource: "upgrade",
    reminderStaggerMinutes: "1",
    eligibilitySubscriberCount: "44",
    completedAt: String(oldArmedAt + 60_000),
    result: "ineligible",
  });
}

describe("onboarding lifecycle reconciliation", () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    vi.restoreAllMocks();
    redis = new InMemoryRedis();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("re-arms a previously ineligible 44-subscriber workflow", async () => {
    await seedCompletedIneligible(redis);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      rearmPreviouslyIneligibleOnboarding(redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).resolves.toEqual({
      status: "rearmed",
      operationId: `onboarding:onboarding_subscriber_goal_v4:${nowMs}`,
      previousSubscriberCount: 44,
    });

    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toMatchObject({
      status: "awaiting_warning",
      armedAt: String(nowMs),
      lifecycleSource: "upgrade",
      creationStaggerMinutes: "1",
      operationId: `onboarding:onboarding_subscriber_goal_v4:${nowMs}`,
      resultStatus: "",
      eligibilitySubscriberCount: "",
    });
    await expect(
      redis.hGetAll(onboardingReminderStateKey),
    ).resolves.toMatchObject({
      status: "pending",
      armedAt: String(nowMs),
      nextRunAt: String(nowMs + 60_000),
      lifecycleSource: "upgrade",
      reminderStaggerMinutes: "1",
      result: "",
      eligibilitySubscriberCount: "",
    });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '"event":"onboarding_rearmed_after_eligibility_change"',
      ),
    );
  });

  it("does not redraw an already re-armed workflow", async () => {
    await seedCompletedIneligible(redis);
    await rearmPreviouslyIneligibleOnboarding(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    const goal = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    const reminder = await redis.hGetAll(onboardingReminderStateKey);

    await expect(
      rearmPreviouslyIneligibleOnboarding(redis as never, {
        lifecycleSource: "upgrade",
        nowMs: nowMs + 1,
      }),
    ).resolves.toEqual({ status: "unchanged" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toEqual(goal);
    await expect(redis.hGetAll(onboardingReminderStateKey)).resolves.toEqual(
      reminder,
    );
  });

  it("does not contend with a locked active workflow", async () => {
    await seedCompletedIneligible(redis);
    await rearmPreviouslyIneligibleOnboarding(redis as never, {
      lifecycleSource: "upgrade",
      nowMs,
    });
    await redis.set(onboardingSubscriberGoalLockKey, "active-processing");

    await expect(
      rearmPreviouslyIneligibleOnboarding(redis as never, {
        lifecycleSource: "upgrade",
        nowMs: nowMs + 1,
      }),
    ).resolves.toEqual({ status: "unchanged" });
    await expect(redis.get(onboardingSubscriberGoalLockKey)).resolves.toBe(
      "active-processing",
    );
  });

  it.each([
    "created",
    "existing",
    "failed",
    "cancelled_permission",
    "delivery_unknown",
    "retry_exhausted",
    "created_not_pinned",
  ])("keeps a terminal %s goal unchanged", async (resultStatus) => {
    await seedCompletedIneligible(redis);
    await redis.hSet(onboardingSubscriberGoalStateKey, { resultStatus });
    const goal = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    const reminder = await redis.hGetAll(onboardingReminderStateKey);

    await expect(
      rearmPreviouslyIneligibleOnboarding(redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).resolves.toEqual({ status: "unchanged" });
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toEqual(goal);
    await expect(redis.hGetAll(onboardingReminderStateKey)).resolves.toEqual(
      reminder,
    );
  });

  it("does not reopen an ineligible goal with an uncertain reminder", async () => {
    await seedCompletedIneligible(redis);
    await redis.hSet(onboardingReminderStateKey, {
      result: "delivery_unknown",
    });

    await expect(
      rearmPreviouslyIneligibleOnboarding(redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).resolves.toEqual({ status: "unchanged" });
  });

  it("releases the goal lock without changing state when the reminder is locked", async () => {
    await seedCompletedIneligible(redis);
    await redis.set(onboardingReminderLockKey, "busy");
    const goal = await redis.hGetAll(onboardingSubscriberGoalStateKey);

    await expect(
      rearmPreviouslyIneligibleOnboarding(redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).rejects.toThrow("Onboarding lifecycle state is currently locked");
    await expect(
      redis.get(onboardingSubscriberGoalLockKey),
    ).resolves.toBeUndefined();
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toEqual(goal);
  });

  it("rolls the goal state back when the paired reminder write fails", async () => {
    await seedCompletedIneligible(redis);
    const goal = await redis.hGetAll(onboardingSubscriberGoalStateKey);
    redis.failReminderWrite = true;

    await expect(
      rearmPreviouslyIneligibleOnboarding(redis as never, {
        lifecycleSource: "upgrade",
        nowMs,
      }),
    ).rejects.toThrow("reminder write failed");
    await expect(
      redis.hGetAll(onboardingSubscriberGoalStateKey),
    ).resolves.toEqual(expect.objectContaining(goal));
  });
});
