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
  await processDueAutoCreateNextGoals({
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
