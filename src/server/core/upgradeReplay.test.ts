/**
 * Phase 5 upgrade and replay tests.
 *
 * Each test seeds Redis with records in the shapes older versions left
 * behind (missing post-kind/height fields, the v1 highlight baseline,
 * pre-marker and pre-flair creation records, an overdue successor with no
 * queue entry), then runs the real upgrade handler and recovery workers twice
 * and checks that goals survive, overdue work resumes, and nothing is posted
 * twice.
 *
 * Tests marked `it.fails` reproduce a known bug; the comment above each names
 * its GitHub issue. Remove the marker once the bug is fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeFaultWorld,
  createFaultWorld,
  Gate,
  type FakePost,
  type FaultWorld,
} from "../testing/faultHarness";

vi.mock("@devvit/web/server", async () =>
  (await import("../testing/faultHarness")).devvitServerMock(),
);
vi.mock("@devvit/notifications", () => ({ notifications: {} }));

const stubs = vi.hoisted(() => ({
  health: vi.fn(),
  notifyExhausted: vi.fn(async () => {}),
}));

vi.mock("./appAccountHealth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./appAccountHealth")>()),
  checkAppAccountHealth: stubs.health,
  rememberAppInstaller: vi.fn(async () => {}),
}));
vi.mock("./appAccountRecovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./appAccountRecovery")>()),
  recordLifecycleAndScheduleRecovery: vi.fn(async () => {}),
}));
vi.mock("./subscriberGoalPostFlair", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subscriberGoalPostFlair")>()),
  ensureSubscriberGoalPostFlair: vi.fn(async () => ({ id: "flair_goal" })),
  backfillSubscriberGoalPostFlair: vi.fn(async () => {}),
}));
vi.mock("./milestoneNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./milestoneNotifications")>()),
  maybeScheduleMilestoneNotification: vi.fn(async () => {}),
}));
vi.mock("../utils/highlightFailureNotifications", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../utils/highlightFailureNotifications")
  >()),
  notifyHighlightFailure: vi.fn(async () => {}),
  notifyHighlightFailureIncident: vi.fn(async () => {}),
  clearHighlightFailureIncident: vi.fn(async () => {}),
}));
vi.mock("./automaticGoalRetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./automaticGoalRetry")>()),
  notifyAutomaticGoalExhausted: stubs.notifyExhausted,
}));
vi.mock("../utils/subredditBlacklist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/subredditBlacklist")>()),
  isSubredditBlacklisted: vi.fn(async () => false),
}));
vi.mock("../utils/actorAuthorization", () => ({
  getCurrentActorAuthority: vi.fn(async () => ({ status: "authorized" })),
}));

import { onAppChanged } from "../triggers/appChanged";
import { runAutoGoalSuccessorQueue } from "../jobs/automaticGoalRetry";
import { dueJobsKey } from "../jobs/queue";
import { processDueAppRepair } from "./appRepair";
import { processDueAutoCreateNextGoals } from "./autoCreateNextGoal";
import { createSubscriberGoal } from "./createSubscriberGoal";
import {
  autoCreateNextGoalDelayMs,
  autoCreateNextGoalQueueKey,
  autoCreateNextGoalSuccessorsKey,
  postAfterSubscribeActionSuffix,
  postAfterSubscribeButtonTextSuffix,
  postAfterSubscribeColorThemeSuffix,
  postAfterSubscribePresetSuffix,
  postAfterSubscribeUrlSuffix,
  postCompletedTimeSuffix,
  postHeightSuffix,
  postKindSuffix,
  registerNewSubGoalPost,
  scheduleAutoCreateNextGoal,
  subscriberGoalsKey,
} from "../data/subGoalData";
import {
  postKindMigrationQueueKey,
  postKindMigrationStateKey,
  processPostKindMigrationBatch,
  initializePostKindMigration,
} from "../data/postKindMigration";
import { getRegisteredSubscriberGoalPosts } from "../data/subscriberGoalPostRegistry";
import {
  getCanonicalGoalPointer,
  highlightManagementStateKey,
} from "../data/highlightManagement";
import { subscriberGoalPostKind } from "../../shared/postKind";
import { dispatchOnboardingJob } from "../jobs/onboarding";
import { reconcileOnboardingForLifecycle } from "./onboardingLifecycle";
import {
  migrateOnboardingWarning,
  onboardingReminderStateKey,
  onboardingSubscriberGoalLockKey,
  onboardingSubscriberGoalLockTtlMs,
  onboardingSubscriberGoalStateKey,
  readOnboardingWarningFields,
} from "./onboardingState";
import { withRedisLock } from "../utils/redisOwnedLock";

const legacyHighlightManagementStateKey =
  "subscriber_goal_highlight_management_v1_state";

const appSettings = {
  promoSubreddit: "SubscriberGoal",
  crosspostAuthoritySubreddit: "SubscriberGoal",
} as never;

const healthy = {
  status: "healthy",
  healthy: true,
  appUsername: "subscriber-goal",
  permissions: ["all"],
  notification: "not_needed",
};

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const minute = 60_000;
const day = 24 * 60 * minute;

let world: FaultWorld;

function goalPosts(): FakePost[] {
  return [...world.redditImpl.posts.values()].filter(
    (post) => post.postData.postKind === subscriberGoalPostKind,
  );
}

/**
 * A classic goal as an older version stored it: no post-kind or height
 * fields, no after-subscribe action, and no postKind in post data.
 */
async function seedLegacyGoal(
  options: {
    completedAt?: number;
    createdAt?: number;
    archived?: boolean;
  } = {},
): Promise<FakePost> {
  const post = world.redditImpl.addPost({
    title: "legacy goal",
    createdAt: new Date(options.createdAt ?? T0 - 30 * day),
    postData: {},
    ...(options.archived ? { archived: true } : {}),
  });
  await registerNewSubGoalPost(
    world.reddit as never,
    world.redis as never,
    appSettings,
    post as never,
    7_500,
    false,
    "testsub",
  );
  await world.redisImpl.hDel(subscriberGoalsKey, [
    `${post.id}${postKindSuffix}`,
    `${post.id}${postHeightSuffix}`,
    `${post.id}${postAfterSubscribeActionSuffix}`,
    `${post.id}${postAfterSubscribeButtonTextSuffix}`,
    `${post.id}${postAfterSubscribeUrlSuffix}`,
    `${post.id}${postAfterSubscribeColorThemeSuffix}`,
    `${post.id}${postAfterSubscribePresetSuffix}`,
  ]);
  if (options.completedAt !== undefined) {
    await world.redisImpl.hSet(subscriberGoalsKey, {
      [`${post.id}${postCompletedTimeSuffix}`]: String(options.completedAt),
    });
  }
  return post;
}

async function upgrade(atMs: number) {
  vi.setSystemTime(atMs);
  await onAppChanged({ lifecycleSource: "upgrade" });
}

async function schedulerWork(atMs: number) {
  vi.setSystemTime(atMs);
  await processPostKindMigrationBatch(
    world.reddit as never,
    world.redis as never,
  );
  await processDueAppRepair({
    reddit: world.reddit as never,
    redis: world.redis as never,
    nowMs: atMs,
  });
  await runAutoGoalSuccessorQueue({
    reddit: world.reddit as never,
    redis: world.redis as never,
    appSettings,
    nowMs: atMs,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  world = createFaultWorld();
  activeFaultWorld.current = world;
  stubs.health.mockReset();
  stubs.health.mockResolvedValue(healthy);
  stubs.notifyExhausted.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  delete activeFaultWorld.current;
});

describe("upgrading a community with an active legacy goal", () => {
  it("keeps the goal, migrates its metadata, and posts nothing, when run twice", async () => {
    vi.setSystemTime(T0);
    const legacy = await seedLegacyGoal();
    world.redditImpl.highlights = [{ postId: legacy.id }];
    await world.redisImpl.hSet(legacyHighlightManagementStateKey, {
      version: "highlight_management_v1",
      canonicalPostId: legacy.id,
      highlighted: "true",
      position: "0",
      highlightLabel: "",
      highlightedUntil: "",
      moderatorOverride: "none",
      reconciledAt: String(T0 - day),
    });

    await upgrade(T0);
    await upgrade(T0 + minute);
    for (let run = 0; run < 3; run += 1) {
      await schedulerWork(T0 + (run + 2) * 10 * minute);
    }

    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(0);
    expect(
      await getRegisteredSubscriberGoalPosts(world.redis as never),
    ).toEqual([legacy.id]);
    expect(world.redditImpl.highlights.map((h) => h.postId)).toEqual([
      legacy.id,
    ]);
    expect(
      await world.redisImpl.hMGet(subscriberGoalsKey, [
        `${legacy.id}${postKindSuffix}`,
        `${legacy.id}${postHeightSuffix}`,
      ]),
    ).toEqual([subscriberGoalPostKind, "regular"]);
    expect(world.redditImpl.posts.get(legacy.id)!.postData.postKind).toBe(
      subscriberGoalPostKind,
    );
    expect(
      await world.redisImpl.hGet(postKindMigrationStateKey, "status"),
    ).toBe("complete");
    // The upgrade's highlight pass sees the legacy post as ambiguous before
    // post-kind migration, so it preserves the highlight without a pointer.
    expect(await getCanonicalGoalPointer(world.redis as never)).toBeUndefined();
    expect(await world.redisImpl.hGetAll(highlightManagementStateKey)).toEqual(
      {},
    );
    expect(
      await world.redisImpl.hGet(legacyHighlightManagementStateKey, "version"),
    ).toBe("highlight_management_v1");
    expect(world.plan.calls("reddit", "highlight")).toHaveLength(0);
  });
});

describe("upgrading a community with an overdue completed goal", () => {
  it("keeps a legacy queued successor at the original 24-hour deadline and creates it once", async () => {
    vi.setSystemTime(T0);
    const source = await seedLegacyGoal({ completedAt: T0 });
    const dueAt = T0 + autoCreateNextGoalDelayMs;
    await world.redisImpl.zAdd(autoCreateNextGoalQueueKey, {
      member: source.id,
      score: dueAt,
    });

    await upgrade(T0 + minute);
    await schedulerWork(dueAt - 1);
    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(0);
    expect(
      await world.redisImpl.zScore(autoCreateNextGoalQueueKey, source.id),
    ).toBe(dueAt);
    expect(
      await world.redisImpl.zScore(dueJobsKey, "automatic_goal_retry"),
    ).toBe(dueAt);

    await schedulerWork(dueAt);
    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
    const [successor] = goalPosts().filter((post) => post.id !== source.id);
    expect(
      await world.redisImpl.hGet(autoCreateNextGoalSuccessorsKey, source.id),
    ).toBe(successor?.id);
    await upgrade(dueAt + minute);
    await schedulerWork(dueAt + 2 * minute);
    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
    expect(
      await world.redisImpl.zScore(autoCreateNextGoalQueueKey, source.id),
    ).toBeUndefined();
    expect(
      await world.redisImpl.zScore(dueJobsKey, "automatic_goal_retry"),
    ).toBeUndefined();
  });

  it("creates exactly one successor however often upgrade and recovery run", async () => {
    vi.setSystemTime(T0);
    // Completed three days ago by a version that had no successor queue.
    const legacy = await seedLegacyGoal({ completedAt: T0 - 3 * day });
    expect(
      await world.redisImpl.zScore(autoCreateNextGoalQueueKey, legacy.id),
    ).toBeUndefined();

    await upgrade(T0);
    await upgrade(T0 + minute);
    for (let run = 0; run < 3; run += 1) {
      await schedulerWork(T0 + (run + 2) * 10 * minute);
    }
    await upgrade(T0 + 2 * 60 * minute);

    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
    const successors = goalPosts().filter((post) => post.id !== legacy.id);
    expect(successors).toHaveLength(1);
    expect(
      await world.redisImpl.hGet(autoCreateNextGoalSuccessorsKey, legacy.id),
    ).toBe(successors[0]!.id);
    expect(
      await world.redisImpl.zScore(autoCreateNextGoalQueueKey, legacy.id),
    ).toBeUndefined();
  });
});

describe("replaying creation records written by older versions", () => {
  async function seedQueuedSource(): Promise<FakePost> {
    vi.setSystemTime(T0);
    const source = await seedLegacyGoal({ completedAt: T0 });
    await scheduleAutoCreateNextGoal(world.redis as never, source.id, T0);
    return source;
  }

  it("keeps a pre-marker ambiguous submission blocked and never resubmits", async () => {
    const source = await seedQueuedSource();
    // An older version recorded `submitting` with no submission marker.
    await world.redisImpl.hSet(
      `subscriber_goal_creation_v1:auto-next:${source.id}`,
      {
        status: "submitting",
        startedAt: String(T0 + autoCreateNextGoalDelayMs - 5 * minute),
        updatedAt: String(T0 + autoCreateNextGoalDelayMs - 5 * minute),
        subredditName: "testsub",
        subredditId: "t5_test",
      },
    );
    world.redditImpl.addPost({
      title: "the post the old version submitted",
      postData: { postKind: subscriberGoalPostKind },
    });

    for (let run = 0; run < 2; run += 1) {
      await processDueAutoCreateNextGoals({
        reddit: world.reddit as never,
        redis: world.redis as never,
        appSettings,
        nowMs: T0 + autoCreateNextGoalDelayMs + run * minute,
      });
    }

    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(0);
    expect(goalPosts()).toHaveLength(1);
  });

  // #115 (B4) (legacy variant): a `complete` record written before flair
  // results were stored fails `recoverCompletedCreation` (line 222), so a
  // replay re-runs approve and highlighting on a finished goal.
  it("#115: replaying a pre-flair complete record does not repeat side effects", async () => {
    const source = await seedQueuedSource();
    const successor = world.redditImpl.addPost({
      title: "successor from older version",
      postData: { postKind: subscriberGoalPostKind },
    });
    await registerNewSubGoalPost(
      world.reddit as never,
      world.redis as never,
      appSettings,
      successor as never,
      10_000,
      false,
      "testsub",
    );
    // Older record: `stickyResult` with legacy status, and no flairResult.
    await world.redisImpl.hSet(
      `subscriber_goal_creation_v1:auto-next:${source.id}`,
      {
        status: "complete",
        postId: successor.id,
        crosspostDispatchResult: JSON.stringify({ status: "skipped" }),
        stickyResult: JSON.stringify({
          status: "pinned",
          verifiedStickied: true,
        }),
        completedAt: String(T0),
        updatedAt: String(T0),
      },
    );

    await createSubscriberGoal({
      reddit: world.reddit as never,
      redis: world.redis as never,
      appSettings,
      options: {
        title: "replay",
        goal: 10_000,
        subredditDisplayName: "testsub",
        crosspost: false,
        colorTheme: "red",
        postHeight: "regular",
        autoCreateNextGoal: true,
        language: "en",
        operationId: `auto-next:${source.id}`,
        automaticPermissionCheck: true,
      },
    });

    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(0);
    expect(world.redditImpl.approvals).toEqual([]);
  });

  it("recovers a complete record that stored a legacy sticky result", async () => {
    const source = await seedQueuedSource();
    const successor = world.redditImpl.addPost({
      title: "successor",
      postData: { postKind: subscriberGoalPostKind },
    });
    await world.redisImpl.hSet(
      `subscriber_goal_creation_v1:auto-next:${source.id}`,
      {
        status: "complete",
        postId: successor.id,
        crosspostDispatchResult: JSON.stringify({ status: "skipped" }),
        stickyResult: JSON.stringify({
          status: "pinned",
          verifiedStickied: true,
        }),
        flairResult: JSON.stringify({ status: "applied", flairId: "f" }),
        completedAt: String(T0),
        updatedAt: String(T0),
      },
    );

    const replay = await createSubscriberGoal({
      reddit: world.reddit as never,
      redis: world.redis as never,
      appSettings,
      options: {
        title: "replay",
        goal: 10_000,
        subredditDisplayName: "testsub",
        crosspost: false,
        colorTheme: "red",
        postHeight: "regular",
        autoCreateNextGoal: true,
        language: "en",
        operationId: `auto-next:${source.id}`,
        automaticPermissionCheck: true,
      },
    });

    expect(replay.post.id).toBe(successor.id);
    expect(replay.highlightResult).toMatchObject({
      status: "highlighted",
      verifiedHighlighted: true,
      issues: [],
    });
    expect(world.redditImpl.approvals).toEqual([]);
  });
});

describe("migration queues", () => {
  // #113 (B12): a record that fails permanently is never removed from the
  // post-kind migration queue, and each batch reads the queue from the front,
  // so a full batch of permanent failures blocks every record behind it.
  it("#113: ten archived legacy posts do not block migration of the rest", async () => {
    vi.setSystemTime(T0);
    const archived: FakePost[] = [];
    for (let index = 0; index < 10; index += 1) {
      archived.push(
        await seedLegacyGoal({
          createdAt: T0 - 300 * day + index,
          archived: true,
        }),
      );
    }
    const healthyGoal = await seedLegacyGoal();
    await initializePostKindMigration(world.redis as never, [
      ...archived.map((post) => post.id),
      healthyGoal.id,
    ]);

    for (let run = 0; run < 20; run += 1) {
      vi.setSystemTime(T0 + run * minute);
      await processPostKindMigrationBatch(
        world.reddit as never,
        world.redis as never,
      );
    }

    expect(
      await world.redisImpl.hGet(
        subscriberGoalsKey,
        `${healthyGoal.id}${postKindSuffix}`,
      ),
    ).toBe(subscriberGoalPostKind);
    expect(
      await world.redisImpl.zScore(postKindMigrationQueueKey, healthyGoal.id),
    ).toBeUndefined();
  });
});

describe("#134 unified onboarding", () => {
  function runOnboarding(
    at: number,
    permissionWorkAllowed = true,
    deadlineMs?: number,
  ): Promise<void> {
    vi.setSystemTime(at);
    return dispatchOnboardingJob({
      reddit: world.reddit as never,
      redis: world.redis as never,
      appSettings,
      permissionWorkAllowed,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });
  }

  const pairs = ["pending", "processing", "dispatching", "complete"].flatMap(
    (warning) =>
      ["awaiting_warning", "pending", "processing", "complete"].map((goal) => ({
        warning,
        goal,
      })),
  );
  it.each(pairs)(
    "replays migration for a $warning warning and $goal goal",
    async ({ warning, goal }) => {
      vi.setSystemTime(T0);
      const oldWarning = {
        version: "onboarding_reminder_v3",
        status: warning,
        armedAt: String(T0 - minute),
        nextRunAt: String(T0 + minute),
        lifecycleSource: "upgrade",
        reminderStaggerMinutes: "2",
        ...(warning === "complete"
          ? { result: "sent", sentAt: String(T0 - minute) }
          : {}),
      };
      const oldGoal = {
        version: "onboarding_subscriber_goal_v4",
        status: goal,
        armedAt: String(T0 - minute),
        nextRunAt: String(T0 + 3 * minute),
        lifecycleSource: "upgrade",
        creationStaggerMinutes: "3",
        operationId: "legacy-onboarding-operation",
      };
      await world.redisImpl.hSet(onboardingReminderStateKey, oldWarning);
      await world.redisImpl.hSet(onboardingSubscriberGoalStateKey, oldGoal);
      const migrate = (): Promise<unknown> =>
        withRedisLock(
          world.redis as never,
          onboardingSubscriberGoalLockKey,
          onboardingSubscriberGoalLockTtlMs,
          () => migrateOnboardingWarning(world.redis as never, Date.now()),
        );
      await migrate();
      const migrated = await world.redisImpl.hGetAll(
        onboardingSubscriberGoalStateKey,
      );
      const savedWarning = await readOnboardingWarningFields(
        world.redis as never,
      );
      expect(savedWarning).toMatchObject({
        nextRunAt: oldWarning.nextRunAt,
        status: warning === "dispatching" ? "complete" : warning,
      });
      if (warning === "dispatching")
        expect(savedWarning.result).toBe("delivery_unknown");
      expect(migrated).toMatchObject({
        nextRunAt: oldGoal.nextRunAt,
        operationId: oldGoal.operationId,
        status:
          warning === "dispatching" && goal === "awaiting_warning"
            ? "complete"
            : goal,
      });
      vi.setSystemTime(T0 + day);
      await migrate();
      expect(
        await world.redisImpl.hGetAll(onboardingSubscriberGoalStateKey),
      ).toEqual(migrated);
      expect(await world.redisImpl.hGetAll(onboardingReminderStateKey)).toEqual(
        oldWarning,
      );
    },
  );

  it("sends one warning and creates one goal even when an upgrade races the warning", async () => {
    vi.setSystemTime(T0);
    await onAppChanged({ lifecycleSource: "install" });
    const warning = await readOnboardingWarningFields(world.redis as never);
    const warningAt = Number(warning.nextRunAt);
    await runOnboarding(warningAt - 1);
    expect(await world.redisImpl.zScore(dueJobsKey, "onboarding")).toBe(
      warningAt,
    );
    await runOnboarding(warningAt, true, warningAt);
    expect(world.redditImpl.modmailNotifications).toHaveLength(0);
    const gate = new Gate();
    world.plan.add({
      target: "reddit",
      method: "createModNotification",
      mode: "pause",
      gate,
    });
    const tick = runOnboarding(warningAt, false);
    await Promise.race([
      gate.reached,
      tick.then(() => {
        throw new Error("Onboarding finished without dispatching its warning");
      }),
    ]);
    try {
      await onAppChanged({ lifecycleSource: "upgrade" });
      await runOnboarding(warningAt);
      expect(world.plan.calls("reddit", "createModNotification")).toHaveLength(
        1,
      );
      expect(goalPosts()).toHaveLength(0);
    } finally {
      gate.release();
      await tick;
    }
    const goal = await world.redisImpl.hGetAll(
      onboardingSubscriberGoalStateKey,
    );
    expect(goal).toMatchObject({
      status: "pending",
      reminderSentAt: String(warningAt),
    });
    expect(world.redditImpl.modmailNotifications).toHaveLength(1);
    const creationAt = Number(goal.nextRunAt);
    await runOnboarding(creationAt - 1);
    await runOnboarding(creationAt, false);
    expect(goalPosts()).toHaveLength(0);
    expect(await world.redisImpl.zScore(dueJobsKey, "onboarding")).toBe(
      creationAt,
    );
    await runOnboarding(creationAt);
    await runOnboarding(creationAt + minute);
    expect(goalPosts()).toHaveLength(1);
    expect(world.redditImpl.modmailNotifications).toHaveLength(1);
    expect(
      await world.redisImpl.zScore(dueJobsKey, "onboarding"),
    ).toBeUndefined();
    expect(await world.redisImpl.hGetAll("onboarding_job_v1_state")).toEqual(
      {},
    );
    expect(await world.redisImpl.hGetAll(onboardingReminderStateKey)).toEqual(
      {},
    );
  });

  it("never resends a committed warning whose response was lost, even after another upgrade", async () => {
    vi.setSystemTime(T0);
    await onAppChanged({ lifecycleSource: "install" });
    const warning = await readOnboardingWarningFields(world.redis as never);
    const warningAt = Number(warning.nextRunAt);
    world.plan.add({
      target: "reddit",
      method: "createModNotification",
      mode: "commit-then-throw",
    });
    await runOnboarding(warningAt);
    expect(
      await readOnboardingWarningFields(world.redis as never),
    ).toMatchObject({ status: "complete", result: "delivery_unknown" });
    expect(
      await world.redisImpl.hGetAll(onboardingSubscriberGoalStateKey),
    ).toMatchObject({ status: "complete", resultStatus: "delivery_unknown" });
    vi.setSystemTime(warningAt + minute);
    await expect(
      reconcileOnboardingForLifecycle(
        world.reddit as never,
        world.redis as never,
        { lifecycleSource: "upgrade", appSettings },
      ),
    ).resolves.toMatchObject({
      status: "unchanged",
      reason: "warning_delivery_unknown_preserved",
    });
    await runOnboarding(warningAt + day);
    expect(world.plan.calls("reddit", "createModNotification")).toHaveLength(1);
    expect(world.redditImpl.modmailNotifications).toHaveLength(1);
    expect(goalPosts()).toHaveLength(0);
  });

  it("resumes a warning at the recorded retry deadline after a pre-dispatch failure", async () => {
    vi.setSystemTime(T0);
    await onAppChanged({ lifecycleSource: "install" });
    const warning = await readOnboardingWarningFields(world.redis as never);
    const warningAt = Number(warning.nextRunAt);
    world.plan.add({ target: "reddit", method: "getCurrentSubreddit" });

    await runOnboarding(warningAt);
    const retry = await readOnboardingWarningFields(world.redis as never);
    const retryAt = Number(retry.nextRunAt);
    expect(retry).toMatchObject({ status: "pending", result: "failed" });
    expect(retryAt).toBe(warningAt + 5 * minute);
    expect(await world.redisImpl.zScore(dueJobsKey, "onboarding")).toBe(
      retryAt,
    );
    await runOnboarding(retryAt - 1);
    expect(world.redditImpl.modmailNotifications).toHaveLength(0);

    await runOnboarding(retryAt);
    await runOnboarding(retryAt + minute);
    expect(world.redditImpl.modmailNotifications).toHaveLength(1);
    expect(
      await world.redisImpl.hGetAll(onboardingSubscriberGoalStateKey),
    ).toMatchObject({
      status: "pending",
      reminderSentAt: String(retryAt),
    });
  });

  it.each(["pending", "dispatching"] as const)(
    "upgrades a due legacy %s warning without shifting its deadline or repeating a dispatch",
    async (status) => {
      vi.setSystemTime(T0);
      const warningAt = T0 + minute;
      await world.redisImpl.hSet(onboardingSubscriberGoalStateKey, {
        version: "onboarding_subscriber_goal_v4",
        status: "awaiting_warning",
        lifecycleSource: "install",
        armedAt: String(T0),
        creationStaggerMinutes: "2",
        operationId: "original-onboarding-operation",
      });
      await world.redisImpl.hSet(onboardingReminderStateKey, {
        version: "onboarding_reminder_v3",
        status,
        lifecycleSource: "install",
        armedAt: String(T0),
        nextRunAt: String(warningAt),
        reminderStaggerMinutes: "1",
      });

      await onAppChanged({ lifecycleSource: "upgrade" });
      await runOnboarding(warningAt - 1);
      expect(world.redditImpl.modmailNotifications).toHaveLength(0);
      expect(await world.redisImpl.zScore(dueJobsKey, "onboarding")).toBe(
        status === "pending" ? warningAt : undefined,
      );
      expect(
        await readOnboardingWarningFields(world.redis as never),
      ).toMatchObject({
        nextRunAt: String(warningAt),
      });
      await runOnboarding(warningAt);
      await onAppChanged({ lifecycleSource: "upgrade" });
      await runOnboarding(warningAt + 1);

      expect(
        await world.redisImpl.hGetAll(onboardingSubscriberGoalStateKey),
      ).toMatchObject({
        operationId: "original-onboarding-operation",
        ...(status === "dispatching"
          ? { status: "complete", resultStatus: "delivery_unknown" }
          : { status: "pending", reminderSentAt: String(warningAt) }),
      });
      expect(world.redditImpl.modmailNotifications).toHaveLength(
        status === "pending" ? 1 : 0,
      );
    },
  );
});
