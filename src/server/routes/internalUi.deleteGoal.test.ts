import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internalRoutes } from "../../shared/routes";
import { captureUiRoutes } from "./internalUi.testHelpers";
import { registerDeleteGoalRoutes } from "./internalUi.deleteGoal";

const hoisted = vi.hoisted(() => ({
  redisValues: new Map<string, string>(),
  redisHashes: new Map<string, Map<string, string>>(),
  redisSortedSets: new Map<string, Map<string, number>>(),
  context: {
    postId: "t3_post",
    subredditName: "ExampleSub",
    userId: "t2_mod",
  },
  reddit: {
    getCurrentSubreddit: vi.fn(),
    getAppUser: vi.fn(),
    getPostById: vi.fn(),
    getPostData: vi.fn(),
    getCurrentUser: vi.fn(),
    getModerators: vi.fn(),
  },
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    hGetAll: vi.fn(),
    hGet: vi.fn(),
    hMGet: vi.fn(),
    hSet: vi.fn(),
    hDel: vi.fn(),
    hScan: vi.fn(),
    zRem: vi.fn(),
    zAdd: vi.fn(),
    expire: vi.fn(),
    watch: vi.fn(),
  },
  getAppSettings: vi.fn(),
  getSubscriberGoalCandidatePostIds: vi.fn(),
  removeSubscriberGoalPost: vi.fn(),
  dispatchPostAction: vi.fn(),
  cancelUpdates: vi.fn(),
  untrackPost: vi.fn(),
  deletePost: vi.fn(),
}));

vi.mock("@devvit/web/server", () => ({
  context: hoisted.context,
  reddit: hoisted.reddit,
  redis: hoisted.redis,
}));

vi.mock("../settings", () => ({
  getAppSettings: hoisted.getAppSettings,
}));

vi.mock("../data/subGoalData", () => ({
  autoCreateNextGoalSuccessorsKey: "auto_create_next_goal_v1_successors",
  autoCreateNextGoalQueueKey: "auto_create_next_goal_v1_queue",
  autoCreateNextGoalRetryAttemptsKey: "auto_create_next_goal_v1_retries",
  autoCreateNextGoalExhaustedKey: "auto_create_next_goal_v1_exhausted",
  subscriberGoalsKey: "subscriber_goals",
  subscriberGoalPostFieldSuffixes: ["_goal"],
  postKindSuffix: "_post_kind",
  postHeightSuffix: "_post_height",
  postCompletedTimeSuffix: "_completed_time",
  cancelAutoCreateNextGoal: vi.fn(),
}));

vi.mock("../data/updaterData", () => ({
  cancelUpdates: hoisted.cancelUpdates,
  untrackPost: hoisted.untrackPost,
}));

vi.mock("../data/crosspostData", () => ({
  dispatchPostAction: hoisted.dispatchPostAction,
}));

vi.mock("../data/subscriberGoalPostRegistry", () => ({
  removeSubscriberGoalPost: hoisted.removeSubscriberGoalPost,
}));

vi.mock("../data/subscriberGoalCandidates", () => ({
  getSubscriberGoalCandidatePostIds: hoisted.getSubscriberGoalCandidatePostIds,
}));

function createRouteHarness() {
  return captureUiRoutes(registerDeleteGoalRoutes);
}

describe("internalUi deleteGoal routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
    });
    hoisted.reddit.getAppUser.mockResolvedValue({
      username: "subscriber-goal",
    });

    hoisted.redisValues.clear();
    hoisted.redisHashes.clear();
    hoisted.redisSortedSets.clear();
    hoisted.redis.set.mockImplementation(async (key, value, options) => {
      if (options?.nx && hoisted.redisValues.has(key)) return undefined;
      hoisted.redisValues.set(key, value);
      return "OK";
    });
    hoisted.redis.get.mockImplementation(async (key) =>
      hoisted.redisValues.get(key),
    );
    hoisted.redis.del.mockImplementation(async (key) => {
      const existed = hoisted.redisValues.delete(key);
      hoisted.redisHashes.delete(key);
      return existed ? 1 : 0;
    });
    hoisted.redis.hGetAll.mockImplementation(async (key) =>
      Object.fromEntries(hoisted.redisHashes.get(key) ?? []),
    );
    hoisted.redis.hGet.mockImplementation(async (key, field) =>
      hoisted.redisHashes.get(key)?.get(field),
    );
    hoisted.redis.hMGet.mockImplementation(async (key, fields) =>
      fields.map((field: string) => hoisted.redisHashes.get(key)?.get(field)),
    );
    hoisted.redis.hSet.mockImplementation(async (key, fields) => {
      const hash = hoisted.redisHashes.get(key) ?? new Map<string, string>();
      Object.entries(fields as Record<string, string>).forEach(
        ([field, value]) => hash.set(field, value),
      );
      hoisted.redisHashes.set(key, hash);
    });
    hoisted.redis.hDel.mockImplementation(async (key, fields) => {
      const hash = hoisted.redisHashes.get(key);
      for (const field of fields as string[]) hash?.delete(field);
    });
    hoisted.redis.hScan.mockResolvedValue({ cursor: 0, fieldValues: [] });
    hoisted.redis.zRem.mockResolvedValue(undefined);
    hoisted.redis.zAdd.mockImplementation(async (key, entry) => {
      const sortedSet =
        hoisted.redisSortedSets.get(key) ?? new Map<string, number>();
      sortedSet.set(entry.member, entry.score);
      hoisted.redisSortedSets.set(key, sortedSet);
    });
    hoisted.redis.expire.mockResolvedValue(undefined);
    hoisted.redis.watch.mockImplementation(async () => {
      let queuedDelete: string | undefined;
      let queuedCommand = false;
      const transaction = {
        multi: vi.fn(async () => undefined),
        del: vi.fn(async (key: string) => {
          queuedDelete = key;
          return transaction;
        }),
        hDel: vi.fn(async () => {
          queuedCommand = true;
          return transaction;
        }),
        zRem: vi.fn(async () => {
          queuedCommand = true;
          return transaction;
        }),
        exec: vi.fn(async () => {
          if (queuedDelete) hoisted.redisValues.delete(queuedDelete);
          return queuedDelete || queuedCommand ? [1] : [];
        }),
        discard: vi.fn(async () => undefined),
        unwatch: vi.fn(async () => transaction),
      };
      return transaction;
    });
    hoisted.context.subredditName = "ExampleSub";
    hoisted.context.postId = "t3_post";
    hoisted.context.userId = "t2_mod";
    hoisted.reddit.getCurrentUser.mockResolvedValue({
      id: "t2_mod",
      username: "ExampleMod",
    });
    hoisted.reddit.getModerators.mockReturnValue({
      all: vi.fn(async () => [
        {
          id: "t2_mod",
          username: "ExampleMod",
          moderatorInfo: { modPermissions: ["all"] },
        },
      ]),
    });
    hoisted.deletePost.mockResolvedValue(undefined);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_post",
      subredditId: "t5_example",
      subredditName: "ExampleSub",
      delete: hoisted.deletePost,
    });
    hoisted.reddit.getPostData.mockResolvedValue(undefined);
    hoisted.dispatchPostAction.mockResolvedValue(undefined);
    hoisted.cancelUpdates.mockResolvedValue(undefined);
    hoisted.untrackPost.mockResolvedValue(undefined);
    hoisted.removeSubscriberGoalPost.mockResolvedValue(undefined);
    hoisted.getAppSettings.mockReturnValue({ promoSubreddit: "SubGoal" });
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue(["t3_post"]);
  });

  it("logs Delete a Goal metadata failures instead of leaking an UNKNOWN rejection", async () => {
    hoisted.context.subredditName = undefined as unknown as string;
    hoisted.reddit.getCurrentSubreddit.mockRejectedValue(
      new Error("reddit metadata unavailable"),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.deleteGoal)?.(
      { body: { confirm: true } } as Request,
      { json } as unknown as Response,
    );

    expect(json).toHaveBeenCalledWith({
      showToast: expect.stringContaining("Couldn’t delete this post"),
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /"event":"delete_goal_failed".*"phase":"metadata_resolution".*"errorMessage":"reddit metadata unavailable".*"stack":/,
      ),
    );
    errorSpy.mockRestore();
  });

  it.each([
    ["post_lookup", "getPostById"],
    ["reddit_post_delete", "deletePost"],
  ] as const)(
    "logs the failed Delete a Goal %s phase",
    async (phase, mockName) => {
      const mocks = {
        getPostById: hoisted.reddit.getPostById,
        dispatchPostAction: hoisted.dispatchPostAction,
        deletePost: hoisted.deletePost,
        cancelUpdates: hoisted.cancelUpdates,
        untrackPost: hoisted.untrackPost,
        removeSubscriberGoalPost: hoisted.removeSubscriberGoalPost,
      };
      mocks[mockName].mockRejectedValueOnce(new Error(`${phase} unavailable`));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const routes = createRouteHarness();
      const json = vi.fn();

      await routes.get(internalRoutes.forms.deleteGoal)?.(
        { body: { confirm: true } } as Request,
        { json } as unknown as Response,
      );

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`"phase":"${phase}"`),
      );
      expect(json).toHaveBeenCalledWith({
        showToast: expect.stringContaining("Reference: delete-goal-"),
      });
      errorSpy.mockRestore();
    },
  );

  it("keeps durable cleanup queued when source deletion succeeds but dispatch fails", async () => {
    hoisted.dispatchPostAction.mockRejectedValueOnce(
      new Error("wiki unavailable"),
    );
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.deleteGoal)?.(
      { body: { confirm: true } } as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.deletePost).toHaveBeenCalledOnce();
    expect(hoisted.dispatchPostAction).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith({
      showToast:
        "Post deleted. If it was crossposted, Subscriber Goal will try to remove the copy.",
    });
  });

  it("makes no Reddit delete or wiki call when intent persistence is uncertain", async () => {
    hoisted.redis.hSet.mockRejectedValueOnce(new Error("redis uncertain"));
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.deleteGoal)?.(
      { body: { confirm: true } } as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.deletePost).not.toHaveBeenCalled();
    expect(hoisted.dispatchPostAction).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({
      showToast: expect.stringContaining("Couldn’t delete this post"),
    });
  });

  it("reuses one intent when a fresh authorized submit retries a live source", async () => {
    hoisted.deletePost
      .mockRejectedValueOnce(new Error("delete response unknown"))
      .mockResolvedValueOnce(undefined);
    const routes = createRouteHarness();

    await routes.get(internalRoutes.forms.deleteGoal)?.(
      { body: { confirm: true } } as Request,
      { json: vi.fn() } as unknown as Response,
    );
    await routes.get(internalRoutes.forms.deleteGoal)?.(
      { body: { confirm: true } } as Request,
      { json: vi.fn() } as unknown as Response,
    );

    expect(hoisted.deletePost).toHaveBeenCalledTimes(2);
    expect(hoisted.dispatchPostAction).toHaveBeenCalledOnce();
    const intents = hoisted.redisHashes.get("source_post_deletion_intents_v1");
    expect(intents?.size).toBe(1);
    expect(JSON.parse(intents?.values().next().value ?? "{}")).toMatchObject({
      id: "t5_example:t3_post",
      status: "dispatched",
      deleteAttemptCount: 2,
    });
  });

  it("blocks deletion after Manage Posts is revoked", async () => {
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue([]);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_post",
      subredditId: "t5_example",
      subredditName: "ExampleSub",
      authorName: "subscriber-goal",
      delete: hoisted.deletePost,
    });
    hoisted.reddit.getPostData.mockResolvedValue({
      postKind: "subscriber-goal-v1",
    });
    hoisted.reddit.getModerators.mockReturnValue({
      all: vi.fn(async () => [
        {
          id: "t2_mod",
          username: "ExampleMod",
          moderatorInfo: { modPermissions: ["flair"] },
        },
      ]),
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.deleteGoal)?.(
      { body: { confirm: true } } as Request,
      { json } as unknown as Response,
    );

    expect(json).toHaveBeenCalledWith({
      showToast: expect.stringContaining("Manage Posts"),
    });
    expect(hoisted.dispatchPostAction).not.toHaveBeenCalled();
    expect(hoisted.deletePost).not.toHaveBeenCalled();
    expect(hoisted.removeSubscriberGoalPost).not.toHaveBeenCalled();
  });

  it("rejects deletion for a post outside the trusted current subreddit", async () => {
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_post",
      subredditId: "t5_other",
      subredditName: "OtherSub",
      delete: hoisted.deletePost,
    });
    hoisted.reddit.getPostData.mockResolvedValue({
      postKind: "subscriber-goal-v1",
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.deleteGoal)?.(
      { body: { confirm: true } } as Request,
      { json } as unknown as Response,
    );

    expect(json).toHaveBeenCalledWith({
      showToast: expect.stringContaining("couldn’t verify"),
    });
    expect(hoisted.reddit.getPostData).not.toHaveBeenCalled();
    expect(hoisted.reddit.getModerators).not.toHaveBeenCalled();
    expect(hoisted.dispatchPostAction).not.toHaveBeenCalled();
    expect(hoisted.deletePost).not.toHaveBeenCalled();
  });

  it("deletes a verified app post when its Redis registration is missing", async () => {
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue([]);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_post",
      subredditId: "t5_example",
      subredditName: "ExampleSub",
      authorName: "subscriber-goal",
      delete: hoisted.deletePost,
    });
    hoisted.reddit.getPostData.mockResolvedValue({
      postKind: "subscriber-goal-v1",
    });
    const routes = createRouteHarness();

    await routes.get(internalRoutes.forms.deleteGoal)?.(
      { body: { confirm: true } } as Request,
      { json: vi.fn() } as unknown as Response,
    );

    expect(hoisted.reddit.getAppUser).toHaveBeenCalledOnce();
    expect(hoisted.deletePost).toHaveBeenCalledOnce();
  });

  it("rejects another app's post even when it uses a recognized post kind", async () => {
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue([]);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_post",
      subredditId: "t5_example",
      subredditName: "ExampleSub",
      authorName: "another-app",
      delete: hoisted.deletePost,
    });
    hoisted.reddit.getPostData.mockResolvedValue({
      postKind: "subscriber-goal-v1",
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.deleteGoal)?.(
      { body: { confirm: true } } as Request,
      { json } as unknown as Response,
    );

    expect(json).toHaveBeenCalledWith({
      showToast: expect.stringContaining("couldn’t verify"),
    });
    expect(hoisted.deletePost).not.toHaveBeenCalled();
  });

  it("rejects malformed custom post metadata without consulting the app user", async () => {
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue([]);
    hoisted.reddit.getPostById.mockResolvedValue({
      id: "t3_post",
      subredditId: "t5_example",
      subredditName: "ExampleSub",
      authorName: "subscriber-goal",
      delete: hoisted.deletePost,
    });
    hoisted.reddit.getPostData.mockResolvedValue({ postKind: 42 });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.deleteGoal)?.(
      { body: { confirm: true } } as Request,
      { json } as unknown as Response,
    );

    expect(json).toHaveBeenCalledWith({
      showToast: expect.stringContaining("couldn’t verify"),
    });
    expect(hoisted.reddit.getAppUser).not.toHaveBeenCalled();
    expect(hoisted.deletePost).not.toHaveBeenCalled();
  });

  it.each([
    ["update_cancellation", "cancelUpdates"],
    ["post_untracking", "untrackPost"],
    ["registry_cleanup", "removeSubscriberGoalPost"],
  ] as const)(
    "continues Delete a Goal cleanup after a failed %s phase",
    async (phase, mockName) => {
      const mocks = {
        cancelUpdates: hoisted.cancelUpdates,
        untrackPost: hoisted.untrackPost,
        removeSubscriberGoalPost: hoisted.removeSubscriberGoalPost,
      };
      mocks[mockName].mockRejectedValueOnce(new Error(`${phase} unavailable`));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const routes = createRouteHarness();
      const json = vi.fn();

      await routes.get(internalRoutes.forms.deleteGoal)?.(
        { body: { confirm: true } } as Request,
        { json } as unknown as Response,
      );

      expect(hoisted.cancelUpdates).toHaveBeenCalledOnce();
      expect(hoisted.untrackPost).toHaveBeenCalledOnce();
      expect(hoisted.removeSubscriberGoalPost).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /delete_goal_cleanup_failed.*"phase":"post_retirement"/,
        ),
      );
      expect(json).toHaveBeenCalledWith({
        showToast: expect.stringMatching(
          /^Post deleted\. Subscriber Goal couldn’t finish updating its records\. Reference: delete-goal-/,
        ),
      });
      errorSpy.mockRestore();
    },
  );
});
