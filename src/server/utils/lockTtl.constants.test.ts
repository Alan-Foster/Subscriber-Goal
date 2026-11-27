import { describe, expect, it, vi } from "vitest";

vi.mock("@devvit/web/server", () => ({
  context: {},
  reddit: {},
  redis: {},
  scheduler: {},
}));

describe("lock expiry constants", () => {
  it("bound every exported lock expiry to the rules in lockTtl", async () => {
    const [
      { communityGoalMutationLockTtlMs },
      { onboardingSubscriberGoalLockTtlMs },
      { subscriberGoalCreationOperationLockTtlMs },
      { createGoalDraftLeaseExpirationMs, devvitWebMaximumRequestMs },
      { completionTransitionLockTtlMs },
      { appAccountRecoveryLockTtlMs },
      { jobRunnerLockTtlMs },
      { crosspostCreateInFlightTtlMs },
    ] = await Promise.all([
      import("../core/communityGoalMutation"),
      import("../core/onboardingState"),
      import("../core/createSubscriberGoal"),
      import("../data/createGoalDraft"),
      import("../data/subGoalData"),
      import("../core/appAccountRecovery"),
      import("../jobs/runner"),
      import("../crosspost/bookkeeping"),
    ]);

    expect(devvitWebMaximumRequestMs).toBe(30_000);
    expect({
      communityGoalMutationLockTtlMs,
      onboardingSubscriberGoalLockTtlMs,
      subscriberGoalCreationOperationLockTtlMs,
      createGoalDraftLeaseExpirationMs,
      jobRunnerLockTtlMs,
      completionTransitionLockTtlMs,
      appAccountRecoveryLockTtlMs,
      crosspostCreateInFlightTtlMs,
    }).toEqual({
      communityGoalMutationLockTtlMs: 60_000,
      onboardingSubscriberGoalLockTtlMs: 60_000,
      subscriberGoalCreationOperationLockTtlMs: 60_000,
      createGoalDraftLeaseExpirationMs: 60_000,
      jobRunnerLockTtlMs: 60_000,
      completionTransitionLockTtlMs: 45_000,
      appAccountRecoveryLockTtlMs: 90_000,
      crosspostCreateInFlightTtlMs: 90_000,
    });
  });
});
