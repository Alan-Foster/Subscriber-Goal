/**
 * Phase 2 fault-injection tests.
 *
 * These run the real creation, registration, AutoGoal worker, inventory and
 * Community Highlight code against in-memory Redis/Reddit fakes. Only side
 * channels are stubbed: app-account health, flair, notifications, milestone
 * scheduling and the actor-authority check.
 *
 * Tests marked `it.fails` reproduce a known bug; the comment above each names
 * its GitHub issue. They pass while the bug exists and start failing once it is
 * fixed, at which point the marker should be removed.
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

import { processDueAutoCreateNextGoals } from "./autoCreateNextGoal";
import { createSubscriberGoal } from "./createSubscriberGoal";
import {
  AutomaticGoalPrerequisiteError,
  automaticGoalRetryGenerationsKey,
} from "./automaticGoalRetry";
import { dispatchAutomaticGoalRetryJob } from "../jobs/automaticGoalRetry";
import { dueJobsKey } from "../jobs/queue";
import {
  autoCreateNextGoalDelayMs,
  autoCreateNextGoalQueueKey,
  autoCreateNextGoalRetryAttemptsKey,
  autoCreateNextGoalSuccessorsKey,
  postCompletedTimeSuffix,
  registerNewSubGoalPost,
  registerNewSubscribeOnlyPost,
  recordAutoCreateNextGoalFailure,
  scheduleAutoCreateNextGoal,
  subscriberGoalsKey,
} from "../data/subGoalData";
import { getRegisteredSubscriberGoalPosts } from "../data/subscriberGoalPostRegistry";
import { appRepairStateKey } from "../data/highlightRepair";
import { defaultAfterSubscribeAction } from "../../shared/afterSubscribeAction";
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

function opKey(sourcePostId: string): string {
  return `subscriber_goal_creation_v1:auto-next:${sourcePostId}`;
}

async function op(sourcePostId: string): Promise<Record<string, string>> {
  return world.redisImpl.hGetAll(opKey(sourcePostId));
}

async function queuedAt(postId: string): Promise<number | undefined> {
  return world.redisImpl.zScore(autoCreateNextGoalQueueKey, postId);
}

/** Classic goal posts the app account submitted after the source. */
function successorPosts(source: FakePost): FakePost[] {
  return [...world.redditImpl.posts.values()].filter(
    (post) =>
      post.id !== source.id &&
      post.postData.postKind === subscriberGoalPostKind,
  );
}

/** Seeds a completed, registered classic goal whose successor is queued. */
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

async function tick(atMs: number) {
  vi.setSystemTime(atMs);
  return processDueAutoCreateNextGoals({
    reddit: world.reddit as never,
    redis: world.redis as never,
    appSettings,
    nowMs: atMs,
  });
}

async function scheduledTick(atMs: number, deadlineMs = atMs + 20_000) {
  vi.setSystemTime(atMs);
  await dispatchAutomaticGoalRetryJob(
    world.reddit as never,
    world.redis as never,
    appSettings,
    deadlineMs,
  );
}

/** Runs ticks at each scheduled time for the source, up to `max` runs. */
async function runUntilSettled(sourcePostId: string, max = 12) {
  for (let i = 0; i < max; i += 1) {
    const at = await queuedAt(sourcePostId);
    if (at === undefined) return;
    await tick(Math.max(at, Date.now()));
  }
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

describe("harness sanity", () => {
  it("creates exactly one highlighted, registered successor on a clean run", async () => {
    const { source, dueAt } = await seedCompletedSource();

    const summary = await tick(dueAt);

    expect(summary).toMatchObject({ created: 1, failed: 0 });
    const [successor] = successorPosts(source);
    expect(successorPosts(source)).toHaveLength(1);
    expect(
      await getRegisteredSubscriberGoalPosts(world.redis as never),
    ).toContain(successor!.id);
    expect(
      await world.redisImpl.hGet(autoCreateNextGoalSuccessorsKey, source.id),
    ).toBe(successor!.id);
    expect(await queuedAt(source.id)).toBeUndefined();
    expect(world.redditImpl.highlights.map((h) => h.postId)).toContain(
      successor!.id,
    );
    expect((await op(source.id)).status).toBe("complete");
  });
});

describe("scheduled automatic goal retries", () => {
  it("preserves a queued legacy retry and dispatches it once across overlapping ticks", async () => {
    const { source, dueAt } = await seedCompletedSource();
    const operationId = `auto-next:${source.id}`;
    await world.redisImpl.hSet(automaticGoalRetryGenerationsKey, {
      [operationId]: "2",
    });
    const { retryAt } = await recordAutoCreateNextGoalFailure(
      world.redis as never,
      source.id,
      dueAt,
    );
    expect(retryAt).toBe(dueAt + 5 * minute);
    const at = retryAt!;

    await scheduledTick(at - 1);
    await scheduledTick(at, at);
    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(0);
    expect(
      await world.redisImpl.zScore(dueJobsKey, "automatic_goal_retry"),
    ).toBe(at);
    expect(await queuedAt(source.id)).toBe(at);
    expect(
      await world.redisImpl.hGet(autoCreateNextGoalRetryAttemptsKey, source.id),
    ).toBe("1");

    const submission = new Gate();
    world.plan.add({
      target: "reddit",
      method: "submitCustomPost",
      mode: "pause",
      gate: submission,
    });
    const first = scheduledTick(at);
    try {
      await Promise.race([
        submission.reached,
        first.then(() => {
          throw new Error("The scheduled retry did not reach submission");
        }),
      ]);
      await scheduledTick(at);
      expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
    } finally {
      submission.release();
      await first;
    }
    await scheduledTick(at);

    expect(successorPosts(source)).toHaveLength(1);
    expect(await queuedAt(source.id)).toBeUndefined();
    expect(
      await world.redisImpl.hGet(automaticGoalRetryGenerationsKey, operationId),
    ).toBe("2");
    expect(
      await world.redisImpl.zScore(dueJobsKey, "automatic_goal_retry"),
    ).toBeUndefined();
    expect(
      await world.redisImpl.hGetAll("automatic_goal_retry_job_v1_state"),
    ).toEqual({});
  });

  it("reconciles a lost submission response on the next scheduled tick without reposting", async () => {
    const { source, dueAt } = await seedCompletedSource();
    world.plan.add({
      target: "reddit",
      method: "submitCustomPost",
      mode: "commit-then-throw",
      error: new Error("socket hang up"),
    });

    await scheduledTick(dueAt);
    expect((await op(source.id)).status).toBe("submission_unknown");
    expect(await queuedAt(source.id)).toBe(dueAt + minute);
    expect(
      await world.redisImpl.zScore(dueJobsKey, "automatic_goal_retry"),
    ).toBe(dueAt + minute);

    await scheduledTick(dueAt + minute);
    await scheduledTick(dueAt + 2 * minute);
    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
    expect(successorPosts(source)).toHaveLength(1);
    expect((await op(source.id)).status).toBe("complete");
    expect(await queuedAt(source.id)).toBeUndefined();
  });
});

describe("recovery after partial failure", () => {
  it("adopts a post Reddit accepted when the submit response was lost", async () => {
    const { source, dueAt } = await seedCompletedSource();
    world.plan.add({
      target: "reddit",
      method: "submitCustomPost",
      mode: "commit-then-throw",
      error: new Error("socket hang up"),
    });

    const first = await tick(dueAt);
    expect(first.unresolved).toBe(1);
    expect((await op(source.id)).status).toBe("submission_unknown");
    expect(await queuedAt(source.id)).toBe(dueAt + 1 * minute);

    await runUntilSettled(source.id);

    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
    const [successor] = successorPosts(source);
    expect(successorPosts(source)).toHaveLength(1);
    expect(
      await world.redisImpl.hGet(autoCreateNextGoalSuccessorsKey, source.id),
    ).toBe(successor!.id);
    expect((await op(source.id)).status).toBe("complete");
  });

  it("adopts the post through inventory when registration bookkeeping fails", async () => {
    const { source, dueAt } = await seedCompletedSource();
    world.plan.add({
      target: "redis",
      method: "hSet",
      match: ([key, fields]) =>
        key === opKey(source.id) &&
        (fields as Record<string, string>).status === "registered",
    });

    await tick(dueAt);
    expect((await op(source.id)).status).toBe("post_submitted");
    expect(await queuedAt(source.id)).toBeGreaterThan(dueAt);

    await runUntilSettled(source.id);

    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
    const [successor] = successorPosts(source);
    expect(
      await getRegisteredSubscriberGoalPosts(world.redis as never),
    ).toContain(successor!.id);
    expect(
      await world.redisImpl.hGet(autoCreateNextGoalSuccessorsKey, source.id),
    ).toBe(successor!.id);
    expect(await queuedAt(source.id)).toBeUndefined();
    // Inventory, not the creation retry, finishes the job, so the operation
    // record is left at `post_submitted`. Nothing reads it again because the
    // source is cancelled; recorded here so a change is noticed.
    expect((await op(source.id)).status).toBe("post_submitted");
  });

  it("keeps the goal and schedules repair when highlighting fails after registration", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { source, dueAt } = await seedCompletedSource();
    const realAddPost = world.redditImpl.addPost.bind(world.redditImpl);
    world.redditImpl.addPost = (overrides = {}) => {
      const post = realAddPost(overrides);
      if (post.id !== source.id) {
        post.highlight = async () => {
          throw new Error("500 Internal Server Error");
        };
      }
      return post;
    };

    const pending = tick(dueAt);
    // Highlight verification polls with setTimeout; advance past its window.
    await vi.advanceTimersByTimeAsync(5 * minute);
    const summary = await pending;

    expect(summary.created).toBe(1);
    const [successor] = successorPosts(source);
    expect(
      await getRegisteredSubscriberGoalPosts(world.redis as never),
    ).toContain(successor!.id);
    const repair = await world.redisImpl.hGetAll(appRepairStateKey);
    expect(repair).toMatchObject({
      status: "pending",
      targetPostId: successor!.id,
    });
  });

  it("does not submit twice when a Redis write fails after the lock is taken", async () => {
    const { source, dueAt } = await seedCompletedSource();
    world.plan.add({
      target: "redis",
      method: "hSet",
      match: ([key, fields]) =>
        key === opKey(source.id) &&
        (fields as Record<string, string>).status === "claimed",
    });

    await tick(dueAt);
    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(0);

    await runUntilSettled(source.id);

    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
    expect(successorPosts(source)).toHaveLength(1);
    expect(await queuedAt(source.id)).toBeUndefined();
  });

  it("stops after six inconclusive scans without resubmitting", async () => {
    const { source, dueAt } = await seedCompletedSource();
    world.plan.add({
      target: "reddit",
      method: "submitCustomPost",
      mode: "commit-then-throw",
    });
    // Listing lag: the accepted post never appears in the scan, and author
    // search (inventory) cannot see it either.
    const realSubmit = world.redditImpl.submitCustomPost.bind(world.redditImpl);
    world.redditImpl.submitCustomPost = async (options) => {
      const post = await realSubmit(options);
      world.redditImpl.hiddenFromListing.add(post.id);
      return post;
    };

    await tick(dueAt);
    await runUntilSettled(source.id, 20);

    const record = await op(source.id);
    expect(record.reconciliationStatus).toBe("exhausted");
    expect(record.reconciliationAttempts).toBe("6");
    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
    expect(await queuedAt(source.id)).toBeUndefined();
    expect(stubs.notifyExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ unresolved: true }),
    );
  });
});

describe("suspected bugs", () => {
  // #111 (B1): a terminal `auto-next` operation record is permanent and the
  // source is left queued, so the source never gets a successor and is
  // re-processed on every run.
  it("#111: a retired recovery does not leave the source queued forever", async () => {
    const { source, dueAt } = await seedCompletedSource();
    // Submission succeeds, then the `registered` write fails, so the post
    // exists but registration is incomplete.
    world.plan.add({
      target: "redis",
      method: "hSet",
      match: ([key, fields]) =>
        key === opKey(source.id) &&
        (fields as Record<string, string>).status === "registered",
    });
    await tick(dueAt);
    const [halfMade] = successorPosts(source);
    expect((await op(source.id)).status).toBe("post_submitted");

    // A moderator deletes the half-made post with the app's Delete Goal
    // action, which deletes as the author.
    world.redditImpl.posts.get(halfMade!.id)!.removedByCategory = "deleted";

    // Recovery revalidates the deleted post and records `retired`.
    await tick((await queuedAt(source.id))!);
    expect((await op(source.id)).status).toBe("retired");

    // Every following run: inventory finds no active classic, creation
    // returns the stored terminal outcome, and the worker breaks.
    for (let run = 1; run <= 3; run += 1) {
      await tick(Date.now() + 5 * minute);
    }

    const successor = await world.redisImpl.hGet(
      autoCreateNextGoalSuccessorsKey,
      source.id,
    );
    const stillQueued = (await queuedAt(source.id)) !== undefined;
    // Either outcome is acceptable: a new successor, or the source is
    // cancelled. Remaining queued and due with no successor is the bug.
    expect(Boolean(successor) || !stillQueued).toBe(true);
  });

  // #111 (B2): recovery treats a newer Tiny post as superseding the classic
  // successor, so the accepted classic post is never registered.
  it("#111: a removed Tiny post does not supersede a recovered classic successor", async () => {
    const { source, dueAt } = await seedCompletedSource();
    world.plan.add({
      target: "reddit",
      method: "submitCustomPost",
      mode: "commit-then-throw",
    });
    await tick(dueAt);
    const [classic] = successorPosts(source);
    // Hide the classic post from author search so the Tiny blocker, not the
    // half-made classic, is what inventory reports.
    world.redditImpl.hiddenFromListing.add(classic!.id);

    // While the submission is unresolved, a moderator adds a Tiny post.
    vi.setSystemTime(dueAt + 30_000);
    const tiny = world.redditImpl.addPost({
      title: "tiny",
      postData: { postKind: "subscribe-only-v1" },
    });
    await registerNewSubscribeOnlyPost(
      world.redis as never,
      appSettings,
      tiny as never,
      "testsub",
      "red",
      "en",
      defaultAfterSubscribeAction,
    );

    // The worker defers to the Tiny blocker.
    await tick(dueAt + 1 * minute);
    expect(await queuedAt(source.id)).toBe(dueAt + 61 * minute);

    // A moderator removes the Tiny post. Removal is reversible, so the post
    // is not retired and keeps its goal data, but inventory no longer
    // treats a removed Tiny post as a blocker.
    world.redditImpl.posts.get(tiny.id)!.removedByCategory = "moderator";
    world.redditImpl.hiddenFromListing.delete(classic!.id);

    await runUntilSettled(source.id);

    expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
    expect(
      await getRegisteredSubscriberGoalPosts(world.redis as never),
    ).toContain(classic!.id);
    expect((await op(source.id)).status).toBe("complete");
  });

  // #115 (B4): two failed lookups while recovering a `complete` operation send
  // it down the recovery path: the record is briefly rewritten to `claimed`
  // and approve/highlight run again on a finished goal.
  it("#115: replaying a complete operation does not repeat post-creation side effects", async () => {
    const { source, dueAt } = await seedCompletedSource();
    await tick(dueAt);
    const [successor] = successorPosts(source);
    expect((await op(source.id)).status).toBe("complete");
    const approvalsBefore = world.redditImpl.approvals.length;

    world.plan.add({
      target: "reddit",
      method: "getPostById",
      match: ([id]) => id === successor!.id,
      times: 2,
      error: new Error("503 Service Unavailable"),
    });
    await expect(
      createSubscriberGoal({
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
      }),
    ).rejects.toThrow(AutomaticGoalPrerequisiteError);

    expect((await op(source.id)).status).toBe("complete");
    expect(world.redditImpl.approvals.length).toBe(approvalsBefore);
  });

  it("AutoGoal dispatches the crosspost once when registration bookkeeping fails", async () => {
    const { source, dueAt } = await seedCompletedSource();
    world.plan.add({
      target: "redis",
      method: "hSet",
      match: ([key, fields]) =>
        key === opKey(source.id) &&
        (fields as Record<string, string>).status === "registered",
    });

    await tick(dueAt);
    await runUntilSettled(source.id);

    expect(successorPosts(source)).toHaveLength(1);
    expect(
      world.redditImpl.wikiUpdates.filter(
        (update) => update.subredditName === "SubscriberGoal",
      ),
    ).toHaveLength(1);
  });

  // B6 (not tracked; accepted alongside #85): a manual retry after the `registered` write fails dispatches the
  // crosspost again. (The AutoGoal path is covered by inventory adoption.)
  it.fails(
    "a manual creation retry does not dispatch the crosspost twice",
    async () => {
      vi.setSystemTime(T0);
      const operationId = "manual-v2:b6";
      world.plan.add({
        target: "redis",
        method: "hSet",
        match: ([key, fields]) =>
          key === `subscriber_goal_creation_v1:${operationId}` &&
          (fields as Record<string, string>).status === "registered",
      });
      const create = () =>
        createSubscriberGoal({
          reddit: world.reddit as never,
          redis: world.redis as never,
          appSettings,
          options: {
            title: "manual goal",
            goal: 10_000,
            subredditDisplayName: "testsub",
            crosspost: true,
            colorTheme: "red",
            postHeight: "regular",
            autoCreateNextGoal: true,
            language: "en",
            operationId,
          },
        });

      await expect(create()).rejects.toThrow();
      await create();

      expect(world.plan.calls("reddit", "submitCustomPost")).toHaveLength(1);
      expect(
        world.redditImpl.wikiUpdates.filter(
          (update) => update.subredditName === "SubscriberGoal",
        ),
      ).toHaveLength(1);
    },
  );

  // Suspected B8, ruled out for AutoGoal: inventory adopts the submitted post
  // before the creation preflight can strand it.
  it("permission flapping during recovery does not strand an unregistered post", async () => {
    const { source, dueAt } = await seedCompletedSource();
    // Submission succeeds; registration fails, so recovery is needed.
    world.plan.add({
      target: "redis",
      method: "hSet",
      match: ([key, fields]) =>
        key === opKey(source.id) &&
        (fields as Record<string, string>).status === "registered",
    });
    await tick(dueAt);
    const [halfMade] = successorPosts(source);

    // From now on the worker's own preflight passes but the creation
    // preflight sees missing permissions (flapping between the two calls).
    stubs.health.mockImplementation(
      async (options: { scheduleUnknownRetry?: boolean }) =>
        options.scheduleUnknownRetry === true
          ? healthy
          : { ...healthy, healthy: false, permissions: [] },
    );
    await runUntilSettled(source.id, 20);

    const registered = await getRegisteredSubscriberGoalPosts(
      world.redis as never,
    );
    const exhausted = await world.redisImpl.hGet(
      "auto_create_next_goal_v1_exhausted",
      source.id,
    );
    expect(!exhausted || registered.includes(halfMade!.id)).toBe(true);
  });
});
