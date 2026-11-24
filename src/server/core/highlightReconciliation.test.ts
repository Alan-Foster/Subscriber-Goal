import { describe, expect, it, vi } from "vitest";
import { autoCreateNextGoalSuccessorsKey } from "./autoCreateNextGoal";
import { ensureExistingSubscriberGoalHighlighted } from "./highlightReconciliation";
import {
  highlightManagementStateKey,
  saveCanonicalGoalPointer,
} from "../data/highlightManagement";
import { highlightContradictionKey } from "../data/highlightContradiction";
import { appRepairStateKey } from "../data/highlightRepair";
import { postOperationalStateKeyPrefix } from "../data/postOperationalState";
import {
  InMemoryRedis,
  nowMs,
  seedGoalData,
} from "../testing/onboardingLifecycleFixtures";

describe("existing goal highlight ensurance", () => {
  const makePost = ({
    id,
    createdAt,
    postKind,
    postHeight,
    highlighted = false,
    highlightFails = false,
    highlightError,
    archived = false,
    locked = false,
    listed,
    highlightLabel,
    highlightedUntil,
  }: {
    id: `t3_${string}`;
    createdAt: string;
    postKind?: string;
    postHeight?: string;
    highlighted?: boolean;
    highlightFails?: boolean;
    highlightError?: string;
    archived?: boolean;
    locked?: boolean;
    listed?: boolean;
    highlightLabel?: "ANNOUNCEMENT" | "EVENT";
    highlightedUntil?: Date;
  }) => {
    let isHighlighted = highlighted;
    const post = {
      id,
      title: id,
      authorName: "subscriber-goal-app",
      subredditId: "t5_example",
      subredditName: "ExampleSub",
      createdAt: new Date(createdAt),
      postData: {
        ...(postKind ? { postKind } : {}),
        ...(postHeight ? { postHeight } : {}),
      },
      listed,
      highlightLabel,
      highlightedUntil,
      archived,
      locked,
      isHighlighted: vi.fn(async () => isHighlighted),
      highlight: vi.fn(
        async (options?: {
          highlightUntil?: Date;
          highlightLabelType?: "ANNOUNCEMENT" | "EVENT";
        }) => {
          if (highlightFails || highlightError)
            throw new Error(highlightError ?? "highlight slots full");
          isHighlighted = true;
          void options;
        },
      ),
      unhighlight: vi.fn(async () => {
        isHighlighted = false;
      }),
    };
    return post;
  };

  const makeReddit = (posts: ReturnType<typeof makePost>[]) => {
    const getHighlightedPosts = vi.fn(async () => {
      const highlightedPosts = [] as {
        postId: `t3_${string}`;
        highlightLabel?: "ANNOUNCEMENT" | "EVENT";
        highlightedUntil?: Date;
      }[];
      for (const post of posts) {
        if (post.listed ?? (await post.isHighlighted())) {
          highlightedPosts.push({
            postId: post.id,
            ...(post.highlightLabel
              ? { highlightLabel: post.highlightLabel }
              : {}),
            ...(post.highlightedUntil
              ? { highlightedUntil: post.highlightedUntil }
              : {}),
          });
        }
      }
      return highlightedPosts;
    });
    return {
      getCurrentSubreddit: vi.fn(async () => ({
        id: "t5_example",
        name: "ExampleSub",
        getHighlightedPosts,
        reorderHighlightedPosts: vi.fn(async () => undefined),
      })),
      getAppUser: vi.fn(async () => ({
        username: "subscriber-goal-app",
        getModPermissionsForSubreddit: vi.fn(async () => ["posts"]),
      })),
      getPostById: vi.fn(async (postId: string) =>
        posts.find((post) => post.id === postId),
      ),
      searchPosts: vi.fn(() => ({ all: vi.fn(async () => posts) })),
      getNewPosts: vi.fn(() => ({ all: vi.fn(async () => []) })),
      modMail: { createModNotification: vi.fn(async () => undefined) },
    };
  };

  it("preserves six moderator and other-app highlights until a slot opens", async () => {
    const protectedPosts = Array.from({ length: 6 }, (_, i) => ({
      ...makePost({
        id: `t3_protected${i}`,
        createdAt: "2026-09-14",
        highlighted: true,
      }),
      authorName: i % 2 ? "moderator" : "other-app",
    }));
    const older = makePost({
      id: "t3_older",
      createdAt: "2026-09-15",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
    });
    const tiny = makePost({
      id: "t3_tiny",
      createdAt: "2026-09-16",
      postKind: "subscribe-only-v1",
      postHeight: "tiny",
    });
    const cta = makePost({
      id: "t3_cta",
      createdAt: "2026-09-17",
      postKind: "cta-only-v1",
      postHeight: "cta",
    });
    const redis = new InMemoryRedis();
    await seedGoalData(redis, older.id, { goal: 3000 });
    const reddit = makeReddit([older, tiny, cta, ...protectedPosts]);
    const run = (time: number) =>
      ensureExistingSubscriberGoalHighlighted({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: time,
        notifyOnFailure: true,
        reconciliationContext: "repair",
      });
    const blocked = await run(nowMs);
    expect(blocked).toMatchObject({
      capacityOnly: true,
      unhighlightedEligiblePostIds: [older.id],
    });
    expect(cta.highlight).not.toHaveBeenCalled();
    expect(tiny.highlight).not.toHaveBeenCalled();
    expect(older.highlight).not.toHaveBeenCalled();
    await run(nowMs + 60_000);
    expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
    expect(
      await redis.hGetAll("app_repair_community_highlights_v3_state"),
    ).toEqual({});
    for (const post of protectedPosts)
      expect(post.unhighlight).not.toHaveBeenCalled();
    await protectedPosts[0]!.unhighlight();
    await expect(run(nowMs + 6 * 60 * 60 * 1000)).resolves.toMatchObject({
      status: "existing",
      unhighlightedEligiblePostIds: [],
    });
    expect(older.highlight).toHaveBeenCalledOnce();
    expect(tiny.unhighlight).not.toHaveBeenCalled();
    expect(cta.unhighlight).not.toHaveBeenCalled();
    expect(reddit.modMail.createModNotification).not.toHaveBeenCalled();
  });

  it("sends permission Modmail for the selected goal and reopens the incident after recovery", async () => {
    const posts = Array.from({ length: 3 }, (_, i) =>
      makePost({
        id: `t3_goal${i}`,
        createdAt: `2026-09-1${i + 4}`,
        postKind: "subscribe-only-v1",
        postHeight: "tiny",
      }),
    );
    const reddit = makeReddit(posts);
    const permissions = vi.fn(async (): Promise<string[]> => []);
    reddit.getAppUser.mockResolvedValue({
      username: "subscriber-goal-app",
      getModPermissionsForSubreddit: permissions,
    });
    const redis = new InMemoryRedis();
    const run = (time: number) =>
      ensureExistingSubscriberGoalHighlighted({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: time,
        notifyOnFailure: true,
        reconciliationContext: "repair",
      });
    await expect(run(nowMs)).resolves.toMatchObject({
      notificationOutcome: "sent",
      failureCategories: ["permission"],
    });
    const message = reddit.modMail.createModNotification.mock
      .calls[0] as unknown as [{ bodyMarkdown: string }];
    expect(message[0].bodyMarkdown).toContain("/comments/goal2");
    expect(message[0].bodyMarkdown).not.toContain("/comments/goal0");
    for (const post of posts) expect(post.highlight).not.toHaveBeenCalled();
    await expect(run(nowMs + 60_000)).resolves.toMatchObject({
      notificationOutcome: "skipped_duplicate",
    });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
    permissions.mockResolvedValue(["posts"]);
    await run(nowMs + 120_000);
    for (const post of posts) await post.unhighlight();
    permissions.mockResolvedValue([]);
    await run(nowMs + 180_000);
    expect(reddit.modMail.createModNotification).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      caller: "onboarding",
      reconciliationContext: "onboarding",
      scheduleRepair: true,
    },
    {
      caller: "AutoGoal",
      reconciliationContext: "repair",
      scheduleRepair: true,
    },
    {
      caller: "the repair job",
      reconciliationContext: "repair",
      scheduleRepair: false,
    },
  ] as const)(
    "schedules degraded highlight repair for $caller only when enabled",
    async ({ reconciliationContext, scheduleRepair }) => {
      const goal = makePost({
        id: "t3_goal",
        createdAt: "2026-09-16T00:00:00Z",
        postKind: "subscriber-goal-v1",
        postHeight: "regular",
      });
      const reddit = makeReddit([goal]);
      reddit.getAppUser.mockResolvedValue({
        username: "subscriber-goal-app",
        getModPermissionsForSubreddit: vi.fn(async (): Promise<string[]> => []),
      });
      const redis = new InMemoryRedis();
      await redis.hSet("subscriber_goals", { t3_goal_goal: "3000" });
      const repairState = {
        status: "processing",
        nextRunAt: String(nowMs),
        attempts: "2",
      };
      if (!scheduleRepair) await redis.hSet(appRepairStateKey, repairState);

      await expect(
        ensureExistingSubscriberGoalHighlighted({
          reddit: reddit as never,
          redis: redis as never,
          nowMs,
          notifyOnFailure: true,
          reconciliationContext,
          ...(scheduleRepair ? {} : { scheduleRepairOnDegraded: false }),
        }),
      ).resolves.toMatchObject({
        failureCategories: ["permission"],
        notificationOutcome: "sent",
      });
      const state = await redis.hGetAll(appRepairStateKey);
      if (scheduleRepair) {
        expect(state).toMatchObject({
          reason: "highlight_reconciliation_degraded",
          status: "pending",
          nextRunAt: String(nowMs + 5 * 60_000),
        });
      } else {
        expect(state).toEqual(repairState);
      }
    },
  );

  it("restores an unhighlighted protected Tiny post", async () => {
    const older = makePost({
      id: "t3_older",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
    });
    const newer = makePost({
      id: "t3_newer",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "subscribe-only-v1",
      postHeight: "tiny",
    });
    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([older, newer]) as never,
      redis: new InMemoryRedis() as never,
      nowMs,
    });

    expect(result).toMatchObject({
      status: "existing",
      postId: "t3_newer",
      classification: "tiny",
      selectedWasAlreadyHighlighted: false,
    });
    expect(newer.highlight).toHaveBeenCalledOnce();
    expect(older.highlight).not.toHaveBeenCalled();
  });

  it("restores an unhighlighted CTA post", async () => {
    const cta = makePost({
      id: "t3_cta_recovery",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "cta-only-v1",
      postHeight: "cta",
    });

    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([cta]) as never,
      redis: new InMemoryRedis() as never,
      nowMs,
    });

    expect(result).toMatchObject({
      status: "existing",
      postId: cta.id,
      classification: "cta",
      eligiblePostIds: [cta.id],
      unhighlightedEligiblePostIds: [],
    });
    expect(cta.highlight).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "AutoGoal off", enabled: false, mapped: false, graceMinutes: 0 },
    {
      label: "AutoGoal awaiting a successor",
      enabled: true,
      mapped: false,
      graceMinutes: 30,
    },
    {
      label: "AutoGoal successor mapped",
      enabled: true,
      mapped: true,
      graceMinutes: 0,
    },
  ])(
    "hands off a completed highlight at the correct deadline with $label",
    async ({ enabled, mapped, graceMinutes }) => {
      const completion = nowMs - 3 * 60 * 60 * 1000;
      const normalDeadline = completion + 24 * 60 * 60 * 1000;
      const deadline = normalDeadline + graceMinutes * 60 * 1000;
      const completed = makePost({
        id: "t3_celebration",
        createdAt: "2026-09-15",
        postKind: "subscriber-goal-v1",
        postHeight: "regular",
        highlighted: true,
      });
      const tiny = makePost({
        id: "t3_between",
        createdAt: "2026-09-14",
        postKind: "subscribe-only-v1",
        postHeight: "tiny",
        highlighted: true,
      });
      const cta = makePost({
        id: "t3_between_newer",
        createdAt: "2026-09-16",
        postKind: "cta-only-v1",
        postHeight: "cta",
      });
      const redis = new InMemoryRedis();
      const reddit = makeReddit([completed, tiny, cta]);
      await seedGoalData(redis, completed.id, {
        goal: 1000,
        completedTime: completion,
        autoCreateNextGoal: enabled,
      });
      if (mapped) {
        await redis.hSet(autoCreateNextGoalSuccessorsKey, {
          [completed.id]: "t3_successor",
        });
      }
      const run = (time: number) =>
        ensureExistingSubscriberGoalHighlighted({
          reddit: reddit as never,
          redis: redis as never,
          nowMs: time,
          reconciliationContext: "repair",
        });

      await expect(run(nowMs)).resolves.toMatchObject({
        postId: completed.id,
        eligiblePostIds: [cta.id, tiny.id],
      });
      expect(tiny.unhighlight).toHaveBeenCalledOnce();
      await expect(redis.hGetAll(appRepairStateKey)).resolves.toMatchObject({
        status: "pending",
        nextRunAt: String(nowMs + 6 * 60 * 60 * 1000),
      });
      await redis.hSet(appRepairStateKey, { status: "processing" });
      if (graceMinutes) {
        await expect(run(normalDeadline)).resolves.toMatchObject({
          postId: completed.id,
        });
      }
      await expect(run(deadline - 1)).resolves.toMatchObject({
        postId: completed.id,
      });
      expect(completed.unhighlight).not.toHaveBeenCalled();
      expect(cta.highlight).not.toHaveBeenCalled();
      await expect(redis.hGetAll(appRepairStateKey)).resolves.toMatchObject({
        status: "pending",
        nextRunAt: String(deadline),
        reason: "completed_goal_highlight_window_ends",
      });

      await expect(run(deadline)).resolves.toMatchObject({ postId: cta.id });
      expect(completed.unhighlight).toHaveBeenCalledOnce();
      expect(cta.highlight).toHaveBeenCalledOnce();
      expect(completed.unhighlight.mock.invocationCallOrder[0]).toBeGreaterThan(
        cta.highlight.mock.invocationCallOrder[0]!,
      );
      await expect(
        (await reddit.getCurrentSubreddit()).getHighlightedPosts(),
      ).resolves.toEqual([{ postId: cta.id }]);
      await expect(run(deadline + 60 * 60 * 1000)).resolves.toMatchObject({
        postId: cta.id,
        managedHighlightsRemoved: [],
      });
      expect(cta.highlight).toHaveBeenCalledOnce();
    },
  );

  it("preserves the current Tiny highlight after the chosen goal fails and cleans it up on retry", async () => {
    const tiny = makePost({
      id: "t3_waiting_tiny",
      createdAt: "2026-09-14",
      postKind: "subscribe-only-v1",
      postHeight: "tiny",
      highlighted: true,
    });
    const goal = makePost({
      id: "t3_pending_highlight",
      createdAt: "2026-09-16",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
    });
    goal.highlight.mockRejectedValueOnce(new Error("Highlight write failed"));
    const redis = new InMemoryRedis();
    const reddit = makeReddit([tiny, goal]);
    await seedGoalData(redis, goal.id, { goal: 3000 });
    const run = (time: number) =>
      ensureExistingSubscriberGoalHighlighted({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: time,
        reconciliationContext: "repair",
        highlightVerification: { maxWaitMs: 0, intervalMs: 0 },
      });

    await expect(run(nowMs)).resolves.toMatchObject({
      status: "existing_not_highlighted",
      postId: goal.id,
      managedHighlightsRemoved: [],
    });
    expect(tiny.unhighlight).not.toHaveBeenCalled();
    const retryAt = nowMs + 5 * 60 * 1000;
    await expect(redis.hGetAll(appRepairStateKey)).resolves.toMatchObject({
      status: "pending",
      nextRunAt: String(retryAt),
    });
    await expect(run(retryAt)).resolves.toMatchObject({
      status: "existing",
      postId: goal.id,
      managedHighlightsRemoved: [tiny.id],
    });
    expect(tiny.unhighlight).toHaveBeenCalledOnce();
  });

  it("pins the newest active classic and keeps the older one in inventory", async () => {
    const highlighted = makePost({
      id: "t3_highlighted",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
    });
    const newer = makePost({
      id: "t3_newer",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "short",
    });
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", {
      t3_highlighted_goal: "3000",
      t3_newer_goal: "4000",
    });
    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([highlighted, newer]) as never,
      redis: redis as never,
      nowMs,
    });

    expect(result).toMatchObject({
      status: "existing",
      eligiblePostIds: ["t3_newer", "t3_highlighted"],
      unhighlightedEligiblePostIds: [],
    });
    expect(highlighted.unhighlight).toHaveBeenCalledOnce();
    expect(newer.highlight).toHaveBeenCalledOnce();
    expect(highlighted.unhighlight.mock.invocationCallOrder[0]).toBeGreaterThan(
      newer.highlight.mock.invocationCallOrder[0]!,
    );
  });

  it("consolidates manually highlighted app surfaces and preserves ambiguous highlights", async () => {
    const oldClassic = makePost({
      id: "t3_oldclassic",
      createdAt: "2026-09-14T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
    });
    const newClassic = makePost({
      id: "t3_newclassic",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "short",
      highlighted: true,
    });
    const cta = makePost({
      id: "t3_cta",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "cta-only-v1",
      postHeight: "cta",
      highlighted: true,
    });
    const tiny = makePost({
      id: "t3_tiny",
      createdAt: "2026-09-16T01:00:00Z",
      postKind: "subscribe-only-v1",
      postHeight: "tiny",
      highlighted: true,
    });
    const ambiguous = makePost({
      id: "t3_legacy",
      createdAt: "2026-09-13T00:00:00Z",
      postKind: "subscriber-goal-v1",
      highlighted: true,
    });
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", {
      t3_oldclassic_goal: "1000",
      t3_newclassic_goal: "2000",
      t3_legacy_goal: "100",
    });

    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([
        oldClassic,
        newClassic,
        cta,
        tiny,
        ambiguous,
      ]) as never,
      redis: redis as never,
      nowMs,
    });

    expect(result.classicPostsUnhighlighted).toEqual([oldClassic.id]);
    expect(result.protectedHighlightsPreserved).toEqual([]);
    expect(result.managedHighlightsRemoved).toEqual([
      oldClassic.id,
      cta.id,
      tiny.id,
    ]);
    expect(oldClassic.unhighlight).toHaveBeenCalledOnce();
    expect(newClassic.unhighlight).not.toHaveBeenCalled();
    expect(cta.unhighlight).toHaveBeenCalledOnce();
    expect(tiny.unhighlight).toHaveBeenCalledOnce();
    expect(ambiguous.unhighlight).not.toHaveBeenCalled();
  });

  it("keeps the only active goal and removes two completed legacy classics", async () => {
    const firstCompleted = makePost({
      id: "t3_completed_one",
      createdAt: "2026-09-13T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
    });
    const secondCompleted = makePost({
      id: "t3_completed_two",
      createdAt: "2026-09-14T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
    });
    const active = makePost({
      id: "t3_active_goal",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
    });
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", {
      t3_completed_one_goal: "1000",
      t3_completed_one_completed_time: String(nowMs - 20_000),
      t3_completed_two_goal: "2000",
      t3_completed_two_completed_time: String(nowMs - 10_000),
      t3_active_goal_goal: "3000",
    });
    await redis.hSet(autoCreateNextGoalSuccessorsKey, {
      [firstCompleted.id]: "t3_existing_successor",
    });

    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([firstCompleted, secondCompleted, active]) as never,
      redis: redis as never,
      nowMs,
      reconciliationContext: "legacy_upgrade",
    });

    expect(result).toMatchObject({ status: "existing", postId: active.id });
    expect(result.classicPostsUnhighlighted).toEqual([
      firstCompleted.id,
      secondCompleted.id,
    ]);
    expect(firstCompleted.unhighlight).toHaveBeenCalledOnce();
    expect(secondCompleted.unhighlight).toHaveBeenCalledOnce();
    expect(active.unhighlight).not.toHaveBeenCalled();
    await expect(
      redis.hGet(autoCreateNextGoalSuccessorsKey, firstCompleted.id),
    ).resolves.toBe("t3_existing_successor");
    await expect(
      redis.hGet(autoCreateNextGoalSuccessorsKey, secondCompleted.id),
    ).resolves.toBe(active.id);
  });

  it("preserves a moderator highlight and the canonical goal's existing slot", async () => {
    const scheduled = {
      ...makePost({
        id: "t3_scheduled",
        createdAt: "2026-09-16T00:00:00Z",
        highlighted: true,
      }),
      authorName: "ScheduleCreator",
    };
    const active = makePost({
      id: "t3_active_slot",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
    });
    const reddit = makeReddit([scheduled, active]);
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", { t3_active_slot_goal: "3000" });
    await saveCanonicalGoalPointer(redis as never, {
      canonicalPostId: active.id,
      reconciledAt: nowMs,
    });
    await redis.hSet(highlightManagementStateKey, {
      version: "highlight_management_v2",
      highlighted: "true",
      position: "0",
    });

    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs,
      reconciliationContext: "repair",
    });

    expect(result.status).toBe("existing");
    expect(active.highlight).not.toHaveBeenCalled();
    expect(scheduled.unhighlight).not.toHaveBeenCalled();
    await expect(
      redis.hGetAll(highlightManagementStateKey),
    ).resolves.toMatchObject({
      canonicalPostId: active.id,
      reconciledAt: String(nowMs),
    });
  });

  it("restores a moderator-unhighlighted active goal", async () => {
    const active = makePost({
      id: "t3_moderator_override",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
    });
    const reddit = makeReddit([active]);
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", {
      t3_moderator_override_goal: "3000",
    });
    await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs,
      reconciliationContext: "legacy_upgrade",
    });
    expect(active.highlight).toHaveBeenCalledOnce();
    await active.unhighlight();
    active.highlight.mockClear();

    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs: nowMs + 60_000,
      reconciliationContext: "repair",
    });

    expect(result).toMatchObject({
      status: "existing",
    });
    expect(active.highlight).toHaveBeenCalledOnce();
    await expect(
      redis.hGetAll(highlightManagementStateKey),
    ).resolves.toMatchObject({
      canonicalPostId: active.id,
      reconciledAt: String(nowMs + 60_000),
    });
  });

  it("restores the canonical goal after its highlight expires", async () => {
    const active = makePost({
      id: "t3_expired",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: false,
      highlightedUntil: new Date(nowMs - 1_000),
    });
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", { t3_expired_goal: "3000" });
    await saveCanonicalGoalPointer(redis as never, {
      canonicalPostId: active.id,
      reconciledAt: nowMs - 60_000,
    });

    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: makeReddit([active]) as never,
      redis: redis as never,
      nowMs,
      reconciliationContext: "repair",
    });

    expect(result).toMatchObject({
      status: "existing",
    });
    expect(active.highlight).toHaveBeenCalledOnce();
    await expect(redis.hGetAll(highlightManagementStateKey)).resolves.toEqual({
      canonicalPostId: active.id,
      reconciledAt: String(nowMs),
    });
  });

  it("preserves a moderator-edited highlight label and expiration", async () => {
    const newExpiration = new Date(nowMs + 2 * 60 * 60 * 1000);
    const active = makePost({
      id: "t3_metadata",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: true,
      highlightLabel: "EVENT",
      highlightedUntil: newExpiration,
    });
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", { t3_metadata_goal: "3000" });
    await saveCanonicalGoalPointer(redis as never, {
      canonicalPostId: active.id,
      reconciledAt: nowMs - 60_000,
    });

    const reddit = makeReddit([active]);
    await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs,
      reconciliationContext: "repair",
    });

    expect(active.highlight).not.toHaveBeenCalled();
    await expect(
      (await reddit.getCurrentSubreddit()).getHighlightedPosts(),
    ).resolves.toMatchObject([
      {
        postId: active.id,
        highlightLabel: "EVENT",
        highlightedUntil: newExpiration,
      },
    ]);
    await expect(
      redis.hGetAll(highlightManagementStateKey),
    ).resolves.toMatchObject({
      canonicalPostId: active.id,
      reconciledAt: String(nowMs),
    });
  });

  it.each([true, false])(
    "discovers the canonical goal from live state with only a v1 baseline (already highlighted: %s)",
    async (alreadyHighlighted) => {
      const expiration = new Date(nowMs + 2 * 60 * 60 * 1000);
      const active = makePost({
        id: "t3_v1_baseline",
        createdAt: "2026-09-15T00:00:00Z",
        postKind: "subscriber-goal-v1",
        postHeight: "regular",
        highlighted: alreadyHighlighted,
        highlightLabel: "EVENT",
        highlightedUntil: expiration,
      });
      const redis = new InMemoryRedis();
      await redis.hSet("subscriber_goals", { t3_v1_baseline_goal: "3000" });
      await redis.hSet("subscriber_goal_highlight_management_v1_state", {
        version: "highlight_management_v1",
        canonicalPostId: "t3_stale_legacy",
        highlighted: "true",
        position: "0",
        moderatorOverride: "none",
        reconciledAt: String(nowMs - 60_000),
      });

      await ensureExistingSubscriberGoalHighlighted({
        reddit: makeReddit([active]) as never,
        redis: redis as never,
        nowMs,
        reconciliationContext: "repair",
      });

      expect(active.highlight).toHaveBeenCalledTimes(
        alreadyHighlighted ? 0 : 1,
      );
      await expect(redis.hGetAll(highlightManagementStateKey)).resolves.toEqual(
        {
          canonicalPostId: active.id,
          reconciledAt: String(nowMs),
        },
      );
    },
  );

  it("persists contradictory observations and notifies once after three", async () => {
    const active = makePost({
      id: "t3_contradiction",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlighted: false,
      listed: true,
    });
    const reddit = makeReddit([active]);
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", {
      t3_contradiction_goal: "3000",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await ensureExistingSubscriberGoalHighlighted({
        reddit: reddit as never,
        redis: redis as never,
        nowMs: nowMs + attempt * 5 * 60 * 1000,
        notifyOnFailure: true,
        reconciliationContext: "repair",
      });
    }

    await expect(
      redis.hGetAll(highlightContradictionKey),
    ).resolves.toMatchObject({ postId: active.id, consecutiveCount: "3" });
    expect(active.highlight).not.toHaveBeenCalled();
    expect(active.unhighlight).not.toHaveBeenCalled();
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
    await expect(redis.hGetAll(appRepairStateKey)).resolves.toMatchObject({
      status: "pending",
      reason: "contradictory_highlight_state",
      nextRunAt: String(nowMs + 5 * 60 * 1000),
    });
    await expect(redis.hGetAll(highlightManagementStateKey)).resolves.toEqual(
      {},
    );

    active.isHighlighted.mockResolvedValue(true);
    await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs: nowMs + 60 * 60 * 1000,
      notifyOnFailure: true,
      reconciliationContext: "repair",
    });
    await expect(redis.hGetAll(highlightContradictionKey)).resolves.toEqual({});
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
  });

  it("stops retrying a narrowly recognized archived-post highlight rejection", async () => {
    const active = makePost({
      id: "t3_archived_blocked",
      createdAt: "2026-09-15T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      archived: true,
      highlightError: "This post is archived and cannot be highlighted",
    });
    const reddit = makeReddit([active]);
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", {
      t3_archived_blocked_goal: "3000",
    });

    const first = await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs,
      notifyOnFailure: true,
      reconciliationContext: "repair",
    });
    await expect(
      redis.hGetAll(`${postOperationalStateKeyPrefix}:${active.id}`),
    ).resolves.toMatchObject({ archived: "true", highlightBlocked: "true" });
    const second = await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs: nowMs + 60_000,
      notifyOnFailure: true,
      reconciliationContext: "repair",
    });

    expect(first.failureCategories).toContain("post_state");
    expect(second.failureCategories).toContain("post_state");
    expect(active.highlight).toHaveBeenCalledOnce();
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
  });

  it("records a failed existing-goal highlight and sends one accurate modmail", async () => {
    const existing = makePost({
      id: "t3_existing",
      createdAt: "2026-09-16T00:00:00Z",
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      highlightFails: true,
    });
    const reddit = makeReddit([existing]);
    const redis = new InMemoryRedis();
    await redis.hSet("subscriber_goals", { t3_existing_goal: "3000" });
    const result = await ensureExistingSubscriberGoalHighlighted({
      reddit: reddit as never,
      redis: redis as never,
      nowMs,
      notifyOnFailure: true,
      highlightVerification: { maxWaitMs: 0, intervalMs: 0 },
    });

    expect(result).toMatchObject({
      status: "existing_not_highlighted",
      postId: "t3_existing",
      notificationOutcome: "sent",
    });
    expect(reddit.modMail.createModNotification).toHaveBeenCalledOnce();
    expect(reddit.modMail.createModNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyMarkdown: expect.stringContaining("existing valid goal"),
      }),
    );
  });
});
