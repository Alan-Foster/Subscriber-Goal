/**
 * Phase 3 deterministic race tests.
 *
 * Each test pauses one operation at a chosen call with a harness `Gate`, runs
 * a competing operation to completion, then releases the first and checks the
 * final state. The production code runs unmodified against the in-memory
 * fakes; side channels are stubbed exactly as in faultInjection.test.ts.
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
  healthGate: undefined as
    undefined | { arrive(): void; released: Promise<void> },
}));

vi.mock("./appAccountHealth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./appAccountHealth")>()),
  checkAppAccountHealth: stubs.health,
}));
vi.mock("./subscriberGoalPostFlair", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subscriberGoalPostFlair")>()),
  ensureSubscriberGoalPostFlair: vi.fn(async () => ({ id: "flair_goal" })),
  backfillSubscriberGoalPostFlair: vi.fn(async () => ({
    applied: 0,
    failed: [],
  })),
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
  notifyAutomaticGoalExhausted: vi.fn(async () => {}),
}));
vi.mock("../utils/subredditBlacklist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/subredditBlacklist")>()),
  isSubredditBlacklisted: vi.fn(async () => false),
}));
vi.mock("../utils/actorAuthorization", () => ({
  getCurrentActorAuthority: vi.fn(async () => ({ status: "authorized" })),
}));

import { processDueAutoCreateNextGoals } from "./autoCreateNextGoal";
import {
  createSubscriberGoal,
  SubscriberGoalCreationInProgressError,
} from "./createSubscriberGoal";
import { processDueAppRepair } from "./appRepair";
import {
  acquireCommunityGoalMutationLease,
  communityGoalMutationLockKey,
  communityGoalMutationLockTtlMs,
  releaseCommunityGoalMutationLease,
} from "./communityGoalMutation";
import {
  autoCreateNextGoalDelayMs,
  autoCreateNextGoalQueueKey,
  autoCreateNextGoalSuccessorsKey,
  postCompletedTimeSuffix,
  registerNewSubGoalPost,
  scheduleAutoCreateNextGoal,
  subscriberGoalsKey,
} from "../data/subGoalData";
import {
  appRepairStateKey,
  scheduleHighlightRepair,
} from "../data/highlightRepair";
import { getCanonicalGoalPointer } from "../data/highlightManagement";
import { subscriberGoalPostKind } from "../../shared/postKind";

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

let world: FaultWorld;

function successorPosts(source: FakePost): FakePost[] {
  return [...world.redditImpl.posts.values()].filter(
    (post) =>
      post.id !== source.id &&
      post.postData.postKind === subscriberGoalPostKind,
  );
}

async function seedCompletedSource(): Promise<{
  source: FakePost;
  dueAt: number;
}> {
  vi.setSystemTime(T0);
  const source = world.redditImpl.addPost({
    title: "source goal",
    createdAt: new Date(T0 - 7 * 24 * 60 * minute),
    postData: { postKind: subscriberGoalPostKind },
  });
  await registerNewSubGoalPost(
    world.reddit as never,
    world.redis as never,
    appSettings,
    source as never,
    5_000,
    false,
    "testsub",
  );
  await world.redisImpl.hSet(subscriberGoalsKey, {
    [`${source.id}${postCompletedTimeSuffix}`]: String(T0),
  });
  await scheduleAutoCreateNextGoal(world.redis as never, source.id, T0);
  return { source, dueAt: T0 + autoCreateNextGoalDelayMs };
}

/** A live, highlighted successor goal with a saved highlight baseline. */
async function seedLiveGoal(): Promise<{ source: FakePost; live: FakePost }> {
  const { source, dueAt } = await seedCompletedSource();
  await tick(dueAt);
  const [live] = successorPosts(source);
  expect(world.redditImpl.highlights.map((h) => h.postId)).toEqual([live!.id]);
  return { source, live: live! };
}

async function tick(atMs: number) {
  vi.setSystemTime(atMs);
  return processDueAutoCreateNextGoals({
    reddit: world.reddit as never,
    redis: world.redis as never,
    appSettings,
    nowMs: atMs,
  });
}

function repair(atMs: number) {
  vi.setSystemTime(atMs);
  return processDueAppRepair({
    reddit: world.reddit as never,
    redis: world.redis as never,
    nowMs: atMs,
  });
}

function manualCreate(operationId: string) {
  return createSubscriberGoal({
    reddit: world.reddit as never,
    redis: world.redis as never,
    appSettings,
    options: {
      title: "manual goal",
      goal: 10_000,
      subredditDisplayName: "testsub",
      crosspost: false,
      colorTheme: "red",
      postHeight: "regular",
      autoCreateNextGoal: true,
      language: "en",
      operationId,
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  world = createFaultWorld();
  activeFaultWorld.current = world;
  stubs.healthGate = undefined;
  stubs.health.mockReset();
  stubs.health.mockImplementation(async () => {
    const gate = stubs.healthGate;
    if (gate) {
      stubs.healthGate = undefined;
      gate.arrive();
      await gate.released;
    }
    return healthy;
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete activeFaultWorld.current;
});

describe("overlapping scheduler runs", () => {
  it("a second AutoGoal run during the first does not create a second goal", async () => {
    const { source, dueAt } = await seedCompletedSource();
    const gate = new Gate();
    world.plan.add({
      target: "reddit",
      method: "submitCustomPost",
      mode: "pause",
      gate,
    });

    const first = tick(dueAt);
    await gate.reached;
    const second = await tick(dueAt + 30_000);
    gate.release();
    const firstSummary = await first;

    expect(second).toMatchObject({ created: 0, skipped: 1 });
    expect(firstSummary).toMatchObject({ created: 1 });
    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
    expect(successorPosts(source)).toHaveLength(1);
    expect(
      await world.redisImpl.zScore(autoCreateNextGoalQueueKey, source.id),
    ).toBeUndefined();
  });
});

describe("duplicate and delayed form submissions", () => {
  it("a duplicate final submit during creation is refused, and a delayed one returns the same goal", async () => {
    vi.setSystemTime(T0);
    const operationId = "manual-v2:t5_test:t2_mod:attempt-1";
    const gate = new Gate();
    world.plan.add({
      target: "reddit",
      method: "submitCustomPost",
      mode: "pause",
      gate,
    });

    const original = manualCreate(operationId);
    await gate.reached;
    await expect(manualCreate(operationId)).rejects.toBeInstanceOf(
      SubscriberGoalCreationInProgressError,
    );
    gate.release();
    const created = await original;

    vi.setSystemTime(T0 + 10 * minute);
    const delayed = await manualCreate(operationId);

    expect(delayed.outcome).toBe("created");
    expect(delayed.post.id).toBe(created.post.id);
    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
  });

  it("an older attempt submitted after a newer one replaces it without leaving two highlighted goals", async () => {
    vi.setSystemTime(T0);
    const newer = await manualCreate("manual-v2:t5_test:t2_mod:attempt-new");
    vi.setSystemTime(T0 + 2 * minute);
    const older = await manualCreate("manual-v2:t5_test:t2_mod:attempt-old");

    expect(older.post.id).not.toBe(newer.post.id);
    // Two moderator submissions are two deliberate goals; the last one
    // submitted wins and the earlier classic goal is superseded.
    expect(
      await world.redisImpl.hGet(
        autoCreateNextGoalSuccessorsKey,
        newer.post.id,
      ),
    ).toBe(older.post.id);
    expect(world.redditImpl.highlights.map((h) => h.postId)).toEqual([
      older.post.id,
    ]);
  });
});

describe("highlight repair races", () => {
  // #112 (B3): processDueAppRepair writes its final state from the copy it read
  // at the start, overwriting a forced repair scheduled while it ran.
  it("#112: a repair forced while another repair is running is not lost", async () => {
    const { live } = await seedLiveGoal();
    const startAt = Date.now() + minute;
    await scheduleHighlightRepair(world.redis as never, {
      nowMs: startAt,
      delayMs: 0,
      force: true,
      reason: "lifecycle",
    });

    // Pause the running repair in its app-account health phase, which runs
    // after the highlight phase has released the community lease.
    const gate = new Gate();
    stubs.healthGate = gate;
    const running = repair(startAt);
    await gate.reached;
    expect(world.plan.calls("reddit", "searchPosts").length).toBeGreaterThan(0);

    // Meanwhile a manual creation degrades and forces a targeted repair.
    await scheduleHighlightRepair(world.redis as never, {
      nowMs: startAt + 1_000,
      delayMs: 5 * minute,
      force: true,
      reason: "manual_creation_highlight_degraded",
      targetPostId: live.id,
    });
    gate.release();
    await running;

    const state = await world.redisImpl.hGetAll(appRepairStateKey);
    expect(state).toMatchObject({
      status: "pending",
      targetPostId: live.id,
      reason: "manual_creation_highlight_degraded",
    });
  });

  async function moderatorSwapScenario(overlap: boolean) {
    const { live } = await seedLiveGoal();
    const modPost = world.redditImpl.addPost({
      title: "Weekly megathread",
      authorName: "a_moderator",
    });
    const startAt = Date.now() + minute;
    await scheduleHighlightRepair(world.redis as never, {
      nowMs: startAt,
      delayMs: 0,
      force: true,
      reason: "lifecycle",
    });
    const swap = () => {
      // The moderator removes the goal's highlight and highlights their own
      // post instead.
      world.redditImpl.highlights = [{ postId: modPost.id }];
    };
    if (overlap) {
      // Pause inventory after it read the highlight snapshot and before it
      // acts on it, then let the moderator swap the highlight.
      const gate = new Gate();
      world.plan.add({
        target: "reddit",
        method: "searchPosts",
        mode: "pause",
        gate,
      });
      const running = repair(startAt);
      await gate.reached;
      swap();
      gate.release();
      await running;
    } else {
      swap();
      await repair(startAt);
    }
    // A later, uninterrupted repair settles whatever the first one left.
    await scheduleHighlightRepair(world.redis as never, {
      nowMs: startAt + 10 * minute,
      delayMs: 0,
      force: true,
      reason: "lifecycle",
    });
    await repair(startAt + 10 * minute);
    return {
      live: live.id,
      modPost: modPost.id,
      highlighted: world.redditImpl.highlights.map((h) => h.postId),
      pointer: await getCanonicalGoalPointer(world.redis as never),
    };
  }

  // The app re-highlights its canonical goal after a moderator unhighlights
  // it. The race must preserve that outcome and the moderator's highlight.
  it("a moderator swapping highlights during a repair ends the same as without overlap", async () => {
    const control = await moderatorSwapScenario(false);
    world = createFaultWorld();
    activeFaultWorld.current = world;
    const raced = await moderatorSwapScenario(true);

    for (const result of [control, raced]) {
      expect(result.highlighted).toContain(result.modPost);
      expect(
        result.highlighted.filter((postId) => postId === result.live),
      ).toHaveLength(1);
      expect(result.pointer).toMatchObject({
        canonicalPostId: result.live,
      });
    }
    expect(raced.highlighted).toEqual(control.highlighted);
  });
});

// The expired holder must leave the successor's lease in place.
describe("lock expiry", () => {
  it("a holder whose community lease expired cannot release the next holder's lease", async () => {
    vi.setSystemTime(T0);
    const first = await acquireCommunityGoalMutationLease(
      world.redis as never,
      T0,
    );
    expect(first).toBeDefined();

    vi.setSystemTime(T0 + communityGoalMutationLockTtlMs + 1);
    const second = await acquireCommunityGoalMutationLease(
      world.redis as never,
      T0 + communityGoalMutationLockTtlMs + 1,
    );
    expect(second).toBeDefined();

    await releaseCommunityGoalMutationLease(world.redis as never, first!);
    expect(await world.redisImpl.get(communityGoalMutationLockKey)).toBe(
      second!.token,
    );
  });
});
