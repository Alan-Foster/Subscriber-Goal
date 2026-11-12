import type { Request, Response, Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLanguageMetadata } from "../../shared/i18n/catalog";
import { formNames, internalRoutes } from "../../shared/routes";
import { subGoalLanguages } from "../../shared/subGoalPostI18n";

const hoisted = vi.hoisted(() => ({
  redisValues: new Map<string, string>(),
  redisHashes: new Map<string, Map<string, string>>(),
  highlightedPostIds: [] as string[],
  context: {
    postId: "t3_post",
    subredditName: "ExampleSub",
    userId: "t2_mod",
  },
  reddit: {
    getCurrentSubreddit: vi.fn(),
    getAppUser: vi.fn(),
    getPostById: vi.fn(),
    getCurrentUsername: vi.fn(),
    getUserById: vi.fn(),
    getUserByUsername: vi.fn(),
    submitPost: vi.fn(),
    modMail: {
      createModNotification: vi.fn(),
    },
    sendPrivateMessage: vi.fn(),
  },
  getModPermissionsForSubreddit: vi.fn(),
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    hGetAll: vi.fn(),
    hSet: vi.fn(),
    expire: vi.fn(),
    watch: vi.fn(),
  },
  getAppSettings: vi.fn(),
  getSavedSubredditDisplayName: vi.fn(),
  setSavedSubredditDisplayName: vi.fn(),
  createGoalPost: vi.fn(),
  registerNewSubGoalPost: vi.fn(),
  registerNewSubscribeOnlyPost: vi.fn(),
  registerNewCtaOnlyPost: vi.fn(),
  setSubredditDisplayNameForPost: vi.fn(),
  cancelAllAutoCreateNextGoals: vi.fn(),
  eraseFromRecentSubscribers: vi.fn(),
  untrackSubscriberById: vi.fn(),
  untrackSubscriberByUsername: vi.fn(),
  getTrackedPosts: vi.fn(),
  getQueuedUpdates: vi.fn(),
  queueUpdate: vi.fn(),
  getSubscriberGoalCandidatePostIds: vi.fn(),
  ensureSubscriberGoalPostFlair: vi.fn(),
  applyGoalPostFrameStyle: vi.fn(),
  removeSubscriberGoalPost: vi.fn(),
  dispatchPostAction: vi.fn(),
  cancelUpdates: vi.fn(),
  untrackPost: vi.fn(),
  deletePost: vi.fn(),
  isSubredditBlacklisted: vi.fn(),
  checkAppAccountHealth: vi.fn(),
}));

vi.mock("@devvit/web/server", () => ({
  context: hoisted.context,
  reddit: hoisted.reddit,
  redis: hoisted.redis,
}));

vi.mock("../settings", () => ({
  getAppSettings: hoisted.getAppSettings,
}));

vi.mock("../core/post", () => ({
  applyGoalPostFrameStyle: hoisted.applyGoalPostFrameStyle,
  createGoalPost: hoisted.createGoalPost,
}));

vi.mock("../data/subGoalData", () => ({
  cancelAllAutoCreateNextGoals: hoisted.cancelAllAutoCreateNextGoals,
  eraseFromRecentSubscribers: hoisted.eraseFromRecentSubscribers,
  registerNewSubGoalPost: hoisted.registerNewSubGoalPost,
  registerNewSubscribeOnlyPost: hoisted.registerNewSubscribeOnlyPost,
  registerNewCtaOnlyPost: hoisted.registerNewCtaOnlyPost,
  setSubredditDisplayNameForPost: hoisted.setSubredditDisplayNameForPost,
}));

vi.mock("../data/subredditDisplayNameData", () => ({
  getSavedSubredditDisplayName: hoisted.getSavedSubredditDisplayName,
  setSavedSubredditDisplayName: hoisted.setSavedSubredditDisplayName,
}));

vi.mock("../data/subscriberStats", () => ({
  untrackSubscriberById: hoisted.untrackSubscriberById,
  untrackSubscriberByUsername: hoisted.untrackSubscriberByUsername,
}));

vi.mock("../data/updaterData", () => ({
  cancelUpdates: hoisted.cancelUpdates,
  getQueuedUpdates: hoisted.getQueuedUpdates,
  getTrackedPosts: hoisted.getTrackedPosts,
  queueUpdate: hoisted.queueUpdate,
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

vi.mock("../core/subscriberGoalPostFlair", () => ({
  ensureSubscriberGoalPostFlair: hoisted.ensureSubscriberGoalPostFlair,
}));

vi.mock("../core/appAccountHealth", () => ({
  checkAppAccountHealth: hoisted.checkAppAccountHealth,
}));

vi.mock("../utils/subredditBlacklist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/subredditBlacklist")>()),
  isSubredditBlacklisted: hoisted.isSubredditBlacklisted,
}));

import { registerInternalUiRoutes } from "./internalUi";

type RouteHandler = (req: Request, res: Response) => void | Promise<void>;

function testDraftKey(creationAttemptId = "create-goal-test123"): string {
  return `create_goal_draft_v5:t2_mod:${creationAttemptId}`;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function finishTinyDraft(
  routes: Map<string, RouteHandler>,
  creationAttemptId: string,
): Promise<ReturnType<typeof vi.fn>> {
  await routes.get(internalRoutes.forms.createSubscribeOnly)?.(
    {
      body: {
        [`postTitle__creation_attempt__${creationAttemptId}`]: "Welcome!",
        colorTheme: ["red"],
        afterSubscribePreset: ["top-post-day"],
      },
    } as Request,
    { json: vi.fn() } as unknown as Response,
  );
  const finalJson = vi.fn();
  await routes.get(internalRoutes.forms.createSubscribeOnlyFollowUp)?.(
    {
      body: {
        [`afterSubscribeButtonText__creation_attempt__${creationAttemptId}`]:
          "View the Top Post Today",
      },
    } as Request,
    { json: finalJson } as unknown as Response,
  );
  return finalJson;
}

function createRouteHarness(): Map<string, RouteHandler> {
  const userId = hoisted.context.userId;
  if (
    userId &&
    ![...hoisted.redisValues.keys()].some((key) =>
      key.startsWith(`create_goal_draft_v5:${userId}:`),
    )
  ) {
    seedCreateGoalDraft("regular", "en");
  }
  const routes = new Map<string, RouteHandler>();
  const router = {
    post: (path: string, handler: RouteHandler) => {
      routes.set(path, async (req, res) => {
        const carrierByPath: Record<string, string> = {
          [internalRoutes.forms.createGoalSetup]: "postHeight",
          [internalRoutes.forms.createSubscriberGoal]: "postTitle",
          [internalRoutes.forms.createSubscribeOnly]: "postTitle",
          [internalRoutes.forms.createCtaOnly]: "postTitle",
          [internalRoutes.forms.createSubscriberGoalFollowUp]:
            "afterSubscribeButtonText",
          [internalRoutes.forms.createSubscribeOnlyFollowUp]:
            "afterSubscribeButtonText",
          [internalRoutes.forms.createCtaOnlyFollowUp]:
            "afterSubscribeButtonText",
        };
        const carrier = carrierByPath[path];
        const body = req.body as Record<string, unknown> | undefined;
        if (path === internalRoutes.forms.createGoalSetup) {
          const encodedAttempt = Object.keys(body ?? {})
            .find((key) => key.startsWith("postHeight__creation_attempt__"))
            ?.split("postHeight__creation_attempt__")[1];
          const draftKey = encodedAttempt
            ? `create_goal_draft_v5:${hoisted.context.userId}:${encodedAttempt}`
            : [...hoisted.redisValues.keys()].find(
                (key) =>
                  key.startsWith(
                    `create_goal_draft_v5:${hoisted.context.userId}:`,
                  ) && !key.endsWith(":lease"),
              );
          const rawDraft = draftKey
            ? hoisted.redisValues.get(draftKey)
            : undefined;
          if (rawDraft && !encodedAttempt) {
            const draft = JSON.parse(rawDraft) as {
              creationAttemptId?: string;
            };
            hoisted.redisValues.set(
              draftKey!,
              JSON.stringify({
                version: 5,
                stage: "setup",
                creationAttemptId: draft.creationAttemptId,
              }),
            );
          }
        }
        if (
          carrier &&
          body &&
          !Object.keys(body).some((key) =>
            key.startsWith(`${carrier}__creation_attempt__`),
          )
        ) {
          const draftKey = [...hoisted.redisValues.keys()].find(
            (key) =>
              key.startsWith(
                `create_goal_draft_v5:${hoisted.context.userId}:`,
              ) && !key.endsWith(":lease"),
          );
          const rawDraft = draftKey
            ? hoisted.redisValues.get(draftKey)
            : undefined;
          const attemptId = rawDraft
            ? (JSON.parse(rawDraft).creationAttemptId as string | undefined)
            : undefined;
          if (attemptId) {
            body[`${carrier}__creation_attempt__${attemptId}`] = body[carrier];
            delete body[carrier];
          }
        }
        const testResponse = {
          ...res,
          json: (payload: unknown) => {
            const response = payload as {
              showForm?: { form?: { fields?: Array<{ name?: string }> } };
            };
            for (const field of response.showForm?.form?.fields ?? []) {
              if (field.name?.includes("__creation_attempt__")) {
                field.name = field.name.split("__creation_attempt__", 1)[0];
              }
            }
            return res.json(payload);
          },
        } as Response;
        await handler(req, testResponse);
      });
    },
  } as unknown as Router;
  registerInternalUiRoutes(router);
  return routes;
}

function seedCreateGoalDraft(
  postHeight: "regular" | "short" | "tiny" | "cta",
  language: string,
  options: {
    postTitle?: string;
    colorTheme?: "red" | "blue" | "green" | "pink";
    subscriberGoal?: number;
    crosspost?: boolean;
    afterSubscribePreset?:
      | "web-link"
      | "discord"
      | "top-post-day"
      | "wiki"
      | "create-post"
      | "share-picture"
      | "newest-post";
    autoCreateNextGoal?: boolean;
    customDeveloperField?: string;
    stage?: "setup" | "details" | "follow-up";
    subredditDisplayName?: string;
    creationAttemptId?: string;
  } = {},
): void {
  const base = {
    version: 5,
    stage: options.stage ?? "follow-up",
    creationAttemptId: options.creationAttemptId ?? "create-goal-test123",
    postHeight,
    language,
    subredditDisplayName: options.subredditDisplayName ?? "ExampleSub",
    customDeveloperField: options.customDeveloperField ?? "",
  };
  const details =
    postHeight === "tiny"
      ? {
          kind: "subscribe-only",
          postTitle: options.postTitle ?? "Welcome!",
          colorTheme: options.colorTheme ?? "red",
          afterSubscribePreset: options.afterSubscribePreset ?? "top-post-day",
        }
      : postHeight === "cta"
        ? {
            kind: "cta-only",
            postTitle: options.postTitle ?? "Welcome!",
            afterSubscribePreset:
              options.afterSubscribePreset ?? "top-post-day",
          }
        : {
            kind: "subscriber-goal",
            postTitle: options.postTitle ?? "Welcome!",
            subscriberGoal: options.subscriberGoal ?? 200,
            colorTheme: options.colorTheme ?? "red",
            crosspost: options.crosspost ?? false,
            afterSubscribePreset:
              options.afterSubscribePreset ?? "top-post-day",
            autoCreateNextGoal: options.autoCreateNextGoal ?? true,
          };
  hoisted.redisValues.set(
    `create_goal_draft_v5:${hoisted.context.userId}:${base.creationAttemptId}`,
    JSON.stringify(base.stage === "follow-up" ? { ...base, details } : base),
  );
}

describe("internalUi color theme create goal routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.redisValues.clear();
    hoisted.redisHashes.clear();
    hoisted.highlightedPostIds.splice(0);
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
    hoisted.redis.hSet.mockImplementation(async (key, fields) => {
      const hash = hoisted.redisHashes.get(key) ?? new Map<string, string>();
      Object.entries(fields as Record<string, string>).forEach(
        ([field, value]) => hash.set(field, value),
      );
      hoisted.redisHashes.set(key, hash);
    });
    hoisted.redis.expire.mockResolvedValue(undefined);
    hoisted.redis.watch.mockImplementation(async () => {
      let queuedDelete: string | undefined;
      const transaction = {
        multi: vi.fn(async () => undefined),
        del: vi.fn(async (key: string) => {
          queuedDelete = key;
          return transaction;
        }),
        exec: vi.fn(async () => {
          if (queuedDelete) hoisted.redisValues.delete(queuedDelete);
          return queuedDelete ? [1] : [];
        }),
        discard: vi.fn(async () => undefined),
        unwatch: vi.fn(async () => transaction),
      };
      return transaction;
    });
    hoisted.context.subredditName = "ExampleSub";
    hoisted.context.postId = "t3_post";
    hoisted.context.userId = "t2_mod";
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      type: "public",
      nsfw: false,
      getHighlightedPosts: vi.fn(async () =>
        hoisted.highlightedPostIds.map((postId) => ({ postId })),
      ),
      reorderHighlightedPosts: vi.fn(async (postIds: readonly string[]) => {
        hoisted.highlightedPostIds.splice(0, Infinity, ...postIds);
      }),
    });
    hoisted.reddit.getAppUser.mockResolvedValue({
      username: "subscriber-goal",
      getModPermissionsForSubreddit: hoisted.getModPermissionsForSubreddit,
    });
    hoisted.getModPermissionsForSubreddit.mockResolvedValue(["all"]);
    hoisted.checkAppAccountHealth.mockImplementation(async () => {
      try {
        const appUser = await hoisted.reddit.getAppUser();
        const permissions =
          await appUser.getModPermissionsForSubreddit("ExampleSub");
        return {
          status:
            permissions.includes("all") || permissions.includes("posts")
              ? "healthy"
              : "unhealthy",
          healthy: permissions.includes("all") || permissions.includes("posts"),
          appUsername: appUser.username,
          permissions,
          notification: "not_needed",
        };
      } catch {
        return {
          status: "unknown",
          healthy: false,
          permissions: [],
          notification: "failed",
        };
      }
    });
    hoisted.isSubredditBlacklisted.mockResolvedValue(false);
    hoisted.reddit.getCurrentUsername.mockResolvedValue("ExampleMod");
    hoisted.deletePost.mockResolvedValue(undefined);
    hoisted.reddit.getPostById.mockResolvedValue({
      delete: hoisted.deletePost,
    });
    hoisted.dispatchPostAction.mockResolvedValue(undefined);
    hoisted.cancelUpdates.mockResolvedValue(undefined);
    hoisted.untrackPost.mockResolvedValue(undefined);
    hoisted.removeSubscriberGoalPost.mockResolvedValue(undefined);
    hoisted.reddit.getUserById.mockResolvedValue(undefined);
    hoisted.reddit.getUserByUsername.mockResolvedValue(undefined);
    hoisted.reddit.submitPost.mockResolvedValue({
      id: "t3_selfpost",
      permalink: "/user/ExampleMod/comments/selfpost/subscriber_goal_test/",
    });
    hoisted.reddit.modMail.createModNotification.mockResolvedValue(
      "modmail-id",
    );
    hoisted.reddit.sendPrivateMessage.mockResolvedValue(undefined);
    hoisted.getAppSettings.mockReturnValue({ promoSubreddit: "SubGoal" });
    hoisted.getSavedSubredditDisplayName.mockResolvedValue(undefined);
    hoisted.createGoalPost.mockResolvedValue({
      id: "t3_newpost",
      subredditName: "ExampleSub",
      subredditId: "t5_example",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      title: "Welcome!",
      permalink: "/r/ExampleSub/comments/newpost/welcome/",
      approve: vi.fn(),
      highlight: vi.fn(async () => {
        if (!hoisted.highlightedPostIds.includes("t3_newpost")) {
          hoisted.highlightedPostIds.push("t3_newpost");
        }
      }),
      unhighlight: vi.fn(async () => {
        const index = hoisted.highlightedPostIds.indexOf("t3_newpost");
        if (index >= 0) hoisted.highlightedPostIds.splice(index, 1);
      }),
      isHighlighted: vi.fn(async () =>
        hoisted.highlightedPostIds.includes("t3_newpost"),
      ),
    });
    hoisted.registerNewSubGoalPost.mockResolvedValue({ status: "skipped" });
    hoisted.registerNewSubscribeOnlyPost.mockResolvedValue({
      status: "skipped",
    });
    hoisted.registerNewCtaOnlyPost.mockResolvedValue({ status: "skipped" });
    hoisted.untrackSubscriberById.mockResolvedValue({
      status: "complete",
      userIds: ["t2_mod"],
    });
    hoisted.untrackSubscriberByUsername.mockResolvedValue({
      status: "complete",
      userIds: ["t2_user"],
    });
    hoisted.eraseFromRecentSubscribers.mockResolvedValue(undefined);
    hoisted.getTrackedPosts.mockResolvedValue([]);
    hoisted.getQueuedUpdates.mockResolvedValue([]);
    hoisted.getSubscriberGoalCandidatePostIds.mockResolvedValue([]);
    hoisted.ensureSubscriberGoalPostFlair.mockResolvedValue({
      id: "flair_subgoal",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a self-erasure form with only a confirmation field", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.menu.eraseMyData)?.({} as Request, res);

    const response = json.mock.calls[0]?.[0] as {
      showForm: {
        name: string;
        form: {
          title: string;
          fields: Array<{ name: string; type: string; label?: string }>;
        };
      };
    };
    expect(response.showForm.name).toBe(formNames.eraseMyData);
    expect(response.showForm.form.title).toBe("Sub Goal - Remove My Own Data");
    expect(response.showForm.form.fields).toEqual([
      expect.objectContaining({
        name: "confirm",
        type: "boolean",
        label: "Remove all of my Sub Goal user data",
      }),
    ]);
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
      showToast: expect.stringContaining("Error deleting post"),
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
    ["crosspost_delete_dispatch", "dispatchPostAction"],
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
          /^The post was deleted, but some cleanup is still pending\. Reference: delete-goal-/,
        ),
      });
      errorSpy.mockRestore();
    },
  );

  it("keeps moderator erasure fields available for username or user id", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.menu.eraseData)?.({} as Request, res);

    const response = json.mock.calls[0]?.[0] as {
      showForm: {
        name: string;
        form: {
          title: string;
          fields: Array<{
            name: string;
            label?: string;
            helpText?: string;
          }>;
        };
      };
    };
    expect(response.showForm.name).toBe(formNames.eraseData);
    expect(response.showForm.form.title).toBe(
      "Sub Goal - Erase Another User's Data",
    );
    expect(response.showForm.form.fields.map((field) => field.name)).toEqual([
      "username",
      "userId",
      "confirm",
    ]);
  });

  it("rejects self-erasure without confirmation", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.eraseMyData)?.(
      { body: { confirm: false } } as Request,
      res,
    );

    expect(json).toHaveBeenCalledWith({
      showToast:
        "You did not confirm removal. Please enable the confirmation toggle before proceeding.",
    });
    expect(hoisted.untrackSubscriberById).not.toHaveBeenCalled();
  });

  it("rejects self-erasure when the user is not logged in", async () => {
    hoisted.context.userId = undefined as unknown as string;
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.eraseMyData)?.(
      { body: { confirm: true } } as Request,
      res,
    );

    expect(json).toHaveBeenCalledWith({
      showToast: "Please log in to remove your Sub Goal user data.",
    });
    expect(hoisted.untrackSubscriberById).not.toHaveBeenCalled();
  });

  it("erases the current user's data from the self-erasure form", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.eraseMyData)?.(
      { body: { confirm: true } } as Request,
      res,
    );

    expect(hoisted.untrackSubscriberById).toHaveBeenCalledWith(
      hoisted.redis,
      "t2_mod",
      "ExampleMod",
    );
    expect(hoisted.eraseFromRecentSubscribers).toHaveBeenCalledWith(
      hoisted.redis,
      "ExampleMod",
    );
    expect(json).toHaveBeenCalledWith({
      showToast: "Your Sub Goal user data has been removed.",
    });
  });

  it("responds once after moderator erasure continues past an identity lookup failure", async () => {
    hoisted.reddit.getUserById.mockRejectedValue(
      new Error("identity service unavailable"),
    );
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.eraseData)?.(
      { body: { userId: "user", confirm: true } } as Request,
      res,
    );

    expect(hoisted.untrackSubscriberById).toHaveBeenCalledWith(
      hoisted.redis,
      "t2_user",
      undefined,
    );
    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({
      showToast: expect.stringContaining("Available user data was erased"),
    });
  });

  it("responds once with a failure when moderator erasure throws", async () => {
    hoisted.untrackSubscriberById.mockRejectedValue(
      new Error("redis unavailable"),
    );
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.eraseData)?.(
      { body: { userId: "t2_user", confirm: true } } as Request,
      res,
    );

    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({
      showToast:
        "User data could not be fully erased. Please try again with the user ID.",
    });
  });

  it("opens the numbered setup form with language, capitalization, and height", async () => {
    const routes = createRouteHarness();
    hoisted.redisValues.clear();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.menu.createGoal)?.({} as Request, res);

    const response = json.mock.calls[0]?.[0] as {
      showForm: {
        name: string;
        form: {
          title: string;
          acceptLabel: string;
          fields: Array<{
            name: string;
            type: string;
            label?: string;
            helpText?: string;
            required?: boolean;
            defaultValue?: unknown;
            options?: Array<{ label: string; value: string }>;
          }>;
        };
      };
    };
    const fields = response.showForm.form.fields;
    expect(response.showForm.name).toBe(formNames.createGoalSetup);
    expect(response.showForm.form.title).toBe(
      "Sub Goal - Step 1/3 - Choose Post Type",
    );
    expect(response.showForm.form.acceptLabel).toBe("Next");
    expect(fields.find((field) => field.name === "postHeight")).toMatchObject({
      type: "select",
      defaultValue: ["regular"],
      options: [
        { label: "Full Height Subscriber Goal", value: "regular" },
        { label: "Short Subscriber Goal (No Logo)", value: "short" },
        {
          label: "Subscribe Button and Call to Action Button (No Goal)",
          value: "tiny",
        },
        {
          label: "Call To Action Button (No Subscribing)",
          value: "cta",
        },
      ],
    });
    expect(fields.find((field) => field.name === "language")).toMatchObject({
      type: "select",
      defaultValue: ["en"],
      options: subGoalLanguages.map((language) => ({
        label: getLanguageMetadata(language).label,
        value: language,
      })),
    });
    expect(fields.map((field) => field.name)).toEqual([
      "language",
      "subredditDisplayName",
      "postHeight",
    ]);
    expect(hoisted.reddit.getCurrentSubreddit).toHaveBeenCalled();
    const createdDraft = [...hoisted.redisValues.entries()].find(([key]) =>
      key.startsWith("create_goal_draft_v5:t2_mod:"),
    )?.[1];
    expect(JSON.parse(createdDraft!)).toMatchObject({
      version: 5,
      stage: "setup",
      creationAttemptId: expect.any(String),
    });
  });

  it("pre-selects a supported subreddit language in the setup form", async () => {
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      type: "public",
      nsfw: false,
      language: "hi",
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.menu.createGoal)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    const fields = json.mock.calls[0]?.[0].showForm.form.fields as Array<{
      name: string;
      defaultValue?: unknown;
    }>;
    expect(fields.find((field) => field.name === "language")).toMatchObject({
      defaultValue: ["hi"],
    });
  });

  it.each(["pa", "mr"] as const)(
    "pre-selects the %s subreddit language in the setup form",
    async (language) => {
      hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers: 100,
        type: "public",
        nsfw: false,
        language,
      });
      const routes = createRouteHarness();
      const json = vi.fn();

      await routes.get(internalRoutes.menu.createGoal)?.(
        {} as Request,
        { json } as unknown as Response,
      );

      const fields = json.mock.calls[0]?.[0].showForm.form.fields as Array<{
        name: string;
        defaultValue?: unknown;
      }>;
      expect(fields.find((field) => field.name === "language")).toMatchObject({
        defaultValue: [language],
      });
    },
  );

  it.each(["pt-BR", "pt-br", "pt_BR"] as const)(
    "normalizes the %s subreddit language to stored Portuguese",
    async (language) => {
      hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers: 100,
        type: "public",
        nsfw: false,
        language,
      });
      const routes = createRouteHarness();
      const json = vi.fn();

      await routes.get(internalRoutes.menu.createGoal)?.(
        {} as Request,
        { json } as unknown as Response,
      );

      const fields = json.mock.calls[0]?.[0].showForm.form.fields as Array<{
        name: string;
        defaultValue?: unknown;
      }>;
      expect(fields.find((field) => field.name === "language")).toMatchObject({
        defaultValue: ["pt"],
      });
    },
  );

  it("opens the CTA shortcut with CTA selected by default", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.menu.createCta)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    const fields = json.mock.calls[0]?.[0].showForm.form.fields as Array<{
      name: string;
      defaultValue?: unknown;
    }>;
    expect(fields.find((field) => field.name === "postHeight")).toMatchObject({
      defaultValue: ["cta"],
    });
  });

  it("reuses one attempt ID when the initial setup form is double-submitted", async () => {
    const routes = createRouteHarness();
    hoisted.redisValues.clear();
    const menuJson = vi.fn();
    await routes.get(internalRoutes.menu.createGoal)?.(
      {} as Request,
      { json: menuJson } as unknown as Response,
    );
    const openedDraft = [...hoisted.redisValues.values()]
      .map((value) => JSON.parse(value) as { creationAttemptId?: string })
      .find((draft) => draft.creationAttemptId) as {
      creationAttemptId: string;
    };
    const submit = () => {
      const json = vi.fn();
      return routes
        .get(internalRoutes.forms.createGoalSetup)?.(
          {
            body: {
              language: ["en"],
              subredditDisplayName: "ExampleSub",
              postHeight: ["tiny"],
            },
          } as Request,
          { json } as unknown as Response,
        )
        ?.then(() => json);
    };

    const firstJson = await submit();
    const secondJson = await submit();
    const savedDraft = JSON.parse(
      hoisted.redisValues.get(testDraftKey(openedDraft.creationAttemptId))!,
    ) as { creationAttemptId: string; stage: string };

    expect(savedDraft).toMatchObject({
      creationAttemptId: openedDraft.creationAttemptId,
      stage: "details",
    });
    expect(firstJson).toHaveBeenCalledWith(
      expect.objectContaining({
        showForm: expect.objectContaining({
          name: formNames.createSubscribeOnly,
        }),
      }),
    );
    expect(secondJson).toHaveBeenCalledWith(
      expect.objectContaining({
        showForm: expect.objectContaining({
          name: formNames.createSubscribeOnly,
        }),
      }),
    );
  });

  it("gives each newly opened setup form a new attempt ID", async () => {
    const routes = createRouteHarness();
    hoisted.redisValues.clear();
    const response = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.menu.createGoal)?.({} as Request, response);
    const firstKey = [...hoisted.redisValues.keys()].find((key) =>
      key.startsWith("create_goal_draft_v5:t2_mod:"),
    )!;
    await routes.get(internalRoutes.menu.createGoal)?.({} as Request, response);
    const keys = [...hoisted.redisValues.keys()].filter((key) =>
      key.startsWith("create_goal_draft_v5:t2_mod:"),
    );

    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(firstKey);
  });

  it("rejects a stale setup callback without replacing the newer draft", async () => {
    const routes = createRouteHarness();
    hoisted.redisValues.clear();
    const response = { json: vi.fn() } as unknown as Response;
    await routes.get(internalRoutes.menu.createGoal)?.({} as Request, response);
    const currentKey = [...hoisted.redisValues.keys()].find((key) =>
      key.startsWith("create_goal_draft_v5:t2_mod:"),
    )!;
    const currentDraft = hoisted.redisValues.get(currentKey)!;

    await routes.get(internalRoutes.forms.createGoalSetup)?.(
      {
        body: {
          language: ["en"],
          subredditDisplayName: "ExampleSub",
          "postHeight__creation_attempt__create-goal-stale12": ["tiny"],
        },
      } as Request,
      response,
    );

    expect(response.json).toHaveBeenLastCalledWith({
      showToast: expect.stringContaining("no longer matches"),
    });
    expect(hoisted.redisValues.get(currentKey)).toBe(currentDraft);
  });

  it("falls back to English for an unsupported subreddit language", async () => {
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      type: "public",
      nsfw: false,
      language: "ja",
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.menu.createGoal)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    const fields = json.mock.calls[0]?.[0].showForm.form.fields as Array<{
      name: string;
      defaultValue?: unknown;
    }>;
    expect(fields.find((field) => field.name === "language")).toMatchObject({
      defaultValue: ["en"],
    });
  });

  it("stores setup choices and opens the Regular/Short details form", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoalSetup)?.(
      {
        body: {
          language: ["es"],
          subredditDisplayName: "EXAMPLEsub",
          postHeight: ["short"],
          customDeveloperField: 'header="Special Header"',
        },
      } as Request,
      res,
    );

    const response = json.mock.calls[0]?.[0] as {
      showForm: {
        name: string;
        form: {
          fields: Array<{
            name: string;
            defaultValue?: unknown;
            disabled?: boolean;
            options?: Array<{ label: string; value: string }>;
          }>;
        };
      };
    };
    expect(response.showForm.name).toBe(formNames.createSubscriberGoal);
    expect(response.showForm.form.fields.map((field) => field.name)).toEqual([
      "postTitle",
      "subscriberGoal",
      "colorTheme",
      "afterSubscribePreset",
      "autoCreateNextGoal",
      "crosspost",
    ]);
    expect(
      response.showForm.form.fields.find((field) => field.name === "postTitle"),
    ).toMatchObject({ defaultValue: "¡Bienvenido a r/\u200BEXAMPLEsub!" });
    expect(
      response.showForm.form.fields.find(
        (field) => field.name === "subscriberGoal",
      ),
    ).toMatchObject({ defaultValue: 150 });
    expect(
      response.showForm.form.fields.find(
        (field) => field.name === "colorTheme",
      ),
    ).toMatchObject({
      defaultValue: ["red"],
      options: [
        { label: "Red", value: "red" },
        { label: "Blue", value: "blue" },
        { label: "Green", value: "green" },
        { label: "Purple", value: "purple" },
        { label: "Pink", value: "pink" },
      ],
    });
    expect(
      response.showForm.form.fields.find((field) => field.name === "crosspost"),
    ).toMatchObject({ defaultValue: true });
    expect(
      response.showForm.form.fields.find(
        (field) => field.name === "afterSubscribePreset",
      ),
    ).toMatchObject({
      defaultValue: ["top-post-day"],
      options: [
        { label: "Link to the Top Post Today", value: "top-post-day" },
        {
          label: "Link to the Most Recent Post Today",
          value: "newest-post",
        },
        { label: "Link to Create a New Text Post", value: "create-post" },
        {
          label: "Link to Create a New Image Post",
          value: "share-picture",
        },
        { label: "Link to a Discord Server", value: "discord" },
        { label: "Link to a Webpage URL", value: "web-link" },
        { label: "Link to the Subreddit Wiki", value: "wiki" },
      ],
    });
    expect(
      response.showForm.form.fields.find(
        (field) => field.name === "autoCreateNextGoal",
      ),
    ).toMatchObject({ defaultValue: true });
    expect(hoisted.redis.set).toHaveBeenCalledWith(
      testDraftKey(),
      JSON.stringify({
        version: 5,
        stage: "details",
        creationAttemptId: "create-goal-test123",
        language: "es",
        postHeight: "short",
        subredditDisplayName: "EXAMPLEsub",
        customDeveloperField: "",
      }),
      { expiration: expect.any(Date) },
    );
  });

  it("opens a Tiny details form without goal-only fields", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoalSetup)?.(
      {
        body: {
          language: ["en"],
          subredditDisplayName: "ExampleSub",
          postHeight: ["tiny"],
        },
      } as Request,
      res,
    );

    const response = json.mock.calls[0]?.[0] as {
      showForm: {
        name: string;
        form: {
          fields: Array<{
            name: string;
            helpText?: string;
            defaultValue?: unknown;
          }>;
        };
      };
    };
    expect(response.showForm.name).toBe(formNames.createSubscribeOnly);
    expect(response.showForm.form.fields.map((field) => field.name)).toEqual([
      "postTitle",
      "colorTheme",
      "afterSubscribePreset",
    ]);
    expect(
      response.showForm.form.fields.find((field) => field.name === "colorTheme")
        ?.helpText,
    ).not.toContain("progress bar");
    expect(
      response.showForm.form.fields.find(
        (field) => field.name === "afterSubscribePreset",
      ),
    ).toMatchObject({ defaultValue: ["top-post-day"] });
  });

  it("opens a CTA-only details form with title and action type only", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.createGoalSetup)?.(
      {
        body: {
          language: ["en"],
          subredditDisplayName: "ExampleSub",
          postHeight: ["cta"],
        },
      } as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as {
      showForm: {
        name: string;
        form: { fields: Array<{ name: string; defaultValue?: unknown }> };
      };
    };
    expect(response.showForm.name).toBe(formNames.createCtaOnly);
    expect(response.showForm.form.fields.map((field) => field.name)).toEqual([
      "postTitle",
      "afterSubscribePreset",
    ]);
    expect(
      response.showForm.form.fields.find(
        (field) => field.name === "afterSubscribePreset",
      ),
    ).toMatchObject({ defaultValue: ["top-post-day"] });
  });

  it("defaults every post type to Top Post in restricted subreddits", async () => {
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      type: "restricted",
      nsfw: false,
    });

    for (const postHeight of ["regular", "short", "tiny", "cta"] as const) {
      const routes = createRouteHarness();
      const json = vi.fn();
      await routes.get(internalRoutes.forms.createGoalSetup)?.(
        {
          body: {
            language: ["en"],
            subredditDisplayName: "ExampleSub",
            postHeight: [postHeight],
          },
        } as Request,
        { json } as unknown as Response,
      );
      const fields = (
        json.mock.calls[0]?.[0] as {
          showForm: {
            form: {
              fields: Array<{ name: string; defaultValue?: unknown }>;
            };
          };
        }
      ).showForm.form.fields;
      expect(
        fields.find((field) => field.name === "afterSubscribePreset"),
      ).toMatchObject({ defaultValue: ["top-post-day"] });
    }
  });

  it("removes dynamic post choices and defaults every NSFW post type to Create Post", async () => {
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      type: "public",
      nsfw: true,
    });

    for (const postHeight of ["regular", "short", "tiny", "cta"] as const) {
      const routes = createRouteHarness();
      const json = vi.fn();
      await routes.get(internalRoutes.forms.createGoalSetup)?.(
        {
          body: {
            language: ["en"],
            subredditDisplayName: "ExampleSub",
            postHeight: [postHeight],
          },
        } as Request,
        { json } as unknown as Response,
      );
      const fields = json.mock.calls[0]?.[0].showForm.form.fields as Array<{
        name: string;
        defaultValue?: unknown;
        options?: Array<{ value: string }>;
      }>;
      const actionField = fields.find(
        (field) => field.name === "afterSubscribePreset",
      );
      expect(actionField?.defaultValue).toEqual(["create-post"]);
      expect(actionField?.options?.map(({ value }) => value)).not.toContain(
        "top-post-day",
      );
      expect(actionField?.options?.map(({ value }) => value)).not.toContain(
        "newest-post",
      );
    }
  });

  it.each([
    ["regular", 9_999, "top-post-day"],
    ["short", 9_999, "top-post-day"],
    ["tiny", 9_999, "top-post-day"],
    ["regular", 10_000, "top-post-day"],
    ["short", 10_000, "top-post-day"],
    ["tiny", 10_000, "top-post-day"],
  ] as const)(
    "defaults %s posts at %i subscribers to %s",
    async (postHeight, numberOfSubscribers, expectedPreset) => {
      hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers,
        type: "public",
        nsfw: false,
      });
      const routes = createRouteHarness();
      const json = vi.fn();

      await routes.get(internalRoutes.forms.createGoalSetup)?.(
        {
          body: {
            language: ["en"],
            subredditDisplayName: "ExampleSub",
            postHeight: [postHeight],
          },
        } as Request,
        { json } as unknown as Response,
      );

      const fields = (
        json.mock.calls[0]?.[0] as {
          showForm: {
            form: {
              fields: Array<{ name: string; defaultValue?: unknown }>;
            };
          };
        }
      ).showForm.form.fields;
      expect(
        fields.find((field) => field.name === "afterSubscribePreset"),
      ).toMatchObject({ defaultValue: [expectedPreset] });
    },
  );

  it("stores goal Step 2 and opens the numbered goal follow-up form", async () => {
    seedCreateGoalDraft("regular", "en", { stage: "details" });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.createSubscriberGoal)?.(
      {
        body: {
          postTitle: "A New Goal",
          subscriberGoal: 250,
          colorTheme: ["pink"],
          crosspost: true,
          autoCreateNextGoal: false,
        },
      } as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as {
      showForm: {
        name: string;
        form: {
          title: string;
          acceptLabel: string;
          fields: Array<{
            name: string;
            label?: string;
            helpText?: string;
          }>;
        };
      };
    };
    expect(response.showForm.name).toBe(formNames.createSubscriberGoalFollowUp);
    expect(response.showForm.form.title).toBe(
      "Sub Goal - Step 3/3 - Settings for After Joining",
    );
    expect(response.showForm.form.acceptLabel).toBe("Create");
    expect(response.showForm.form.fields.map((field) => field.name)).toEqual([
      "afterSubscribeButtonText",
      "afterSubscribeColorTheme",
      "customDeveloperField",
    ]);
    expect(
      response.showForm.form.fields.find(
        (field) => field.name === "afterSubscribeButtonText",
      ),
    ).toMatchObject({
      label: "Button Text After a User Joins",
      helpText: "Recommended: 6-24 characters. Accepted: 5-50 characters.",
    });
    expect(
      response.showForm.form.fields.find(
        (field) => field.name === "customDeveloperField",
      ),
    ).toMatchObject({
      label: "Custom Developer Field",
      helpText:
        "This field is for developers and testing only. Please leave this field empty.",
    });
    expect(JSON.parse(hoisted.redisValues.get(testDraftKey())!)).toMatchObject({
      version: 5,
      stage: "follow-up",
      details: {
        kind: "subscriber-goal",
        postTitle: "A New Goal",
        subscriberGoal: 250,
        colorTheme: "pink",
        crosspost: true,
        afterSubscribePreset: "top-post-day",
        autoCreateNextGoal: false,
      },
    });
  });

  it("ignores a forged crosspost value when the community is ineligible", async () => {
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      type: "private",
      nsfw: false,
    });
    seedCreateGoalDraft("regular", "en", { stage: "details" });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.createSubscriberGoal)?.(
      {
        body: {
          postTitle: "A Private Goal",
          subscriberGoal: 250,
          colorTheme: ["pink"],
          crosspost: true,
          autoCreateNextGoal: true,
        },
      } as Request,
      { json } as unknown as Response,
    );

    expect(JSON.parse(hoisted.redisValues.get(testDraftKey())!)).toMatchObject({
      details: { crosspost: false },
    });
  });

  it("treats an omitted eligible crosspost value as disabled", async () => {
    seedCreateGoalDraft("regular", "en", { stage: "details" });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.createSubscriberGoal)?.(
      {
        body: {
          postTitle: "A Local Goal",
          subscriberGoal: 250,
          colorTheme: ["pink"],
          autoCreateNextGoal: true,
        },
      } as Request,
      { json } as unknown as Response,
    );

    expect(JSON.parse(hoisted.redisValues.get(testDraftKey())!)).toMatchObject({
      details: { crosspost: false },
    });
  });

  it("skips crossposting with a warning when eligibility changes before creation", async () => {
    seedCreateGoalDraft("regular", "en", { crosspost: true });
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      type: "private",
      nsfw: false,
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      { body: {} } as Request,
      res,
    );

    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledWith(
      hoisted.reddit,
      hoisted.redis,
      expect.anything(),
      expect.objectContaining({ id: "t3_newpost" }),
      200,
      false,
      "ExampleSub",
      "red",
      true,
      "en",
      undefined,
      "regular",
      expect.anything(),
      "top-post-day",
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        showToast: expect.stringContaining(
          "Crossposting was skipped because this community is no longer eligible.",
        ),
      }),
    );
  });

  it("stores Tiny Step 2 and opens a follow-up form without goal-only fields", async () => {
    seedCreateGoalDraft("tiny", "en", { stage: "details" });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.createSubscribeOnly)?.(
      {
        body: {
          postTitle: "Subscribe Here",
          colorTheme: ["pink"],
        },
      } as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as {
      showForm: {
        name: string;
        form: { title: string; fields: Array<{ name: string }> };
      };
    };
    expect(response.showForm.name).toBe(formNames.createSubscribeOnlyFollowUp);
    expect(response.showForm.form.title).toBe(
      "Sub Goal - Step 3/3 - Settings for After Joining",
    );
    expect(response.showForm.form.fields.map((field) => field.name)).toEqual([
      "afterSubscribeButtonText",
      "afterSubscribeColorTheme",
      "customDeveloperField",
    ]);
    expect(JSON.parse(hoisted.redisValues.get(testDraftKey())!)).toMatchObject({
      version: 5,
      stage: "follow-up",
      details: {
        kind: "subscribe-only",
        postTitle: "Subscribe Here",
        colorTheme: "pink",
        afterSubscribePreset: "top-post-day",
      },
    });
  });

  it("stores CTA-only Step 2 and populates its CTA follow-up form", async () => {
    seedCreateGoalDraft("cta", "en", { stage: "details" });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.createCtaOnly)?.(
      {
        body: {
          postTitle: "Create Something",
          afterSubscribePreset: ["create-post"],
        },
      } as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as {
      showForm: {
        name: string;
        form: {
          title: string;
          fields: Array<{
            name: string;
            label?: string;
            defaultValue?: unknown;
          }>;
        };
      };
    };
    expect(response.showForm.name).toBe(formNames.createCtaOnlyFollowUp);
    expect(response.showForm.form.title).toBe(
      "Sub Goal - Step 3/3 - CTA Button Settings",
    );
    expect(response.showForm.form.fields.map((field) => field.name)).toEqual([
      "afterSubscribeButtonText",
      "afterSubscribeColorTheme",
      "customDeveloperField",
    ]);
    expect(response.showForm.form.fields[0]).toMatchObject({
      label: "CTA Button Text",
      defaultValue: "Create a New Post",
    });
    expect(response.showForm.form.fields[1]).toMatchObject({
      label: "CTA Button Color",
      defaultValue: ["blue"],
    });
  });

  it.each([
    ["web-link", undefined, true, "blue"],
    ["discord", "Únete al Discord", true, "blue"],
    ["top-post-day", "Ver la publicación destacada de hoy", false, "blue"],
    ["wiki", "Leer la Wiki", true, "blue"],
    ["create-post", "Crear una publicación", false, "blue"],
    ["share-picture", "Compartir una imagen", false, "blue"],
    ["newest-post", "Ver la publicación más reciente", false, "blue"],
  ] as const)(
    "builds the %s preset follow-up fields and localized defaults",
    async (preset, buttonText, showUrl, colorTheme) => {
      seedCreateGoalDraft("tiny", "es", { stage: "details" });
      const routes = createRouteHarness();
      const json = vi.fn();

      await routes.get(internalRoutes.forms.createSubscribeOnly)?.(
        {
          body: {
            postTitle: "Suscríbete",
            colorTheme: ["pink"],
            afterSubscribePreset: [preset],
          },
        } as Request,
        { json } as unknown as Response,
      );

      const fields = (
        json.mock.calls[0]?.[0] as {
          showForm: {
            form: {
              fields: Array<{
                name: string;
                defaultValue?: unknown;
                required?: boolean;
                options?: Array<{ label: string; value: string }>;
              }>;
            };
          };
        }
      ).showForm.form.fields;
      expect(fields.map((field) => field.name)).toEqual([
        "afterSubscribeButtonText",
        ...(showUrl ? ["afterSubscribeUrl"] : []),
        "afterSubscribeColorTheme",
        "customDeveloperField",
      ]);
      expect(
        fields.find((field) => field.name === "afterSubscribeButtonText")
          ?.defaultValue,
      ).toBe(buttonText);
      expect(
        fields.find((field) => field.name === "afterSubscribeButtonText")
          ?.required,
      ).toBe(true);
      if (showUrl) {
        expect(
          fields.find((field) => field.name === "afterSubscribeUrl")?.required,
        ).toBe(true);
      }
      expect(
        fields.find((field) => field.name === "afterSubscribeColorTheme")
          ?.defaultValue,
      ).toEqual([colorTheme]);
      expect(
        fields.find((field) => field.name === "afterSubscribeColorTheme")
          ?.options,
      ).toEqual([
        { label: "Red", value: "red" },
        { label: "Blue", value: "blue" },
        { label: "Green", value: "green" },
        { label: "Purple", value: "purple" },
        { label: "Pink", value: "pink" },
      ]);
    },
  );

  it.each([
    ["NSFW", { name: "ExampleSub", type: "public", nsfw: true }],
    ["unknown-safety", { name: "ExampleSub", type: "public" }],
    ["restricted", { name: "ExampleSub", type: "restricted", nsfw: false }],
    ["private", { name: "ExampleSub", type: "private", nsfw: false }],
    ["promotional", { name: "SubGoal", type: "public", nsfw: false }],
  ] as const)(
    "hides goal crossposting for %s communities",
    async (_label, data) => {
      hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        numberOfSubscribers: 100,
        ...data,
      });
      const routes = createRouteHarness();
      const json = vi.fn();
      const res = { json } as unknown as Response;

      await routes.get(internalRoutes.forms.createGoalSetup)?.(
        {
          body: {
            language: ["en"],
            subredditDisplayName: data.name,
            postHeight: ["regular"],
          },
        } as Request,
        res,
      );

      const response = json.mock.calls[0]?.[0] as {
        showForm: {
          form: {
            fields: Array<{
              name: string;
              defaultValue?: unknown;
              disabled?: boolean;
              helpText?: string;
            }>;
          };
        };
      };
      expect(
        response.showForm.form.fields.find(
          (field) => field.name === "crosspost",
        ),
      ).toBeUndefined();
    },
  );

  it("keeps a newer attempt unchanged when an older setup callback resumes", async () => {
    const attemptA = "create-goal-race-a12";
    seedCreateGoalDraft("regular", "en", {
      stage: "setup",
      creationAttemptId: attemptA,
    });
    const routes = createRouteHarness();
    const pausedSubreddit = deferred<{
      id: string;
      name: string;
      numberOfSubscribers: number;
      type: string;
      nsfw: boolean;
    }>();
    hoisted.reddit.getCurrentSubreddit.mockImplementationOnce(
      () => pausedSubreddit.promise,
    );

    const submissionA = routes.get(internalRoutes.forms.createGoalSetup)?.(
      {
        body: {
          language: ["en"],
          subredditDisplayName: "ExampleSub",
          [`postHeight__creation_attempt__${attemptA}`]: ["regular"],
        },
      } as Request,
      { json: vi.fn() } as unknown as Response,
    );
    await Promise.resolve();
    await Promise.resolve();

    const existingKeys = new Set(hoisted.redisValues.keys());
    await routes.get(internalRoutes.menu.createGoal)?.(
      {} as Request,
      { json: vi.fn() } as unknown as Response,
    );
    const keyB = [...hoisted.redisValues.keys()].find(
      (key) =>
        key.startsWith("create_goal_draft_v5:t2_mod:") &&
        !key.endsWith(":lease") &&
        !existingKeys.has(key),
    )!;
    const draftBBefore = hoisted.redisValues.get(keyB)!;

    pausedSubreddit.resolve({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      type: "public",
      nsfw: false,
    });
    await submissionA;

    expect(hoisted.redisValues.get(keyB)).toBe(draftBBefore);
    const attemptB = keyB.split(":").at(-1)!;
    await routes.get(internalRoutes.forms.createGoalSetup)?.(
      {
        body: {
          language: ["en"],
          subredditDisplayName: "ExampleSub",
          [`postHeight__creation_attempt__${attemptB}`]: ["tiny"],
        },
      } as Request,
      { json: vi.fn() } as unknown as Response,
    );
    expect(JSON.parse(hoisted.redisValues.get(keyB)!)).toMatchObject({
      creationAttemptId: attemptB,
      stage: "details",
    });
    const finalJson = await finishTinyDraft(routes, attemptB);
    expect(finalJson).toHaveBeenCalledWith(
      expect.objectContaining({
        navigateTo: expect.stringContaining("/comments/t3_newpost"),
      }),
    );
  });

  it("successful cleanup removes only its attempt while a newer draft survives", async () => {
    const attemptA = "create-goal-final-a12";
    seedCreateGoalDraft("tiny", "en", { creationAttemptId: attemptA });
    const routes = createRouteHarness();
    const pausedSubreddit = deferred<{
      id: string;
      name: string;
      numberOfSubscribers: number;
      type: string;
      nsfw: boolean;
    }>();
    const subreddit = {
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      type: "public",
      nsfw: false,
    };
    hoisted.reddit.getCurrentSubreddit
      .mockResolvedValueOnce(subreddit)
      .mockImplementationOnce(() => pausedSubreddit.promise);

    const submissionA = routes.get(
      internalRoutes.forms.createSubscribeOnlyFollowUp,
    )?.(
      {
        body: {
          [`afterSubscribeButtonText__creation_attempt__${attemptA}`]:
            "View the Top Post Today",
        },
      } as Request,
      { json: vi.fn() } as unknown as Response,
    );
    await vi.waitFor(() =>
      expect(hoisted.reddit.getCurrentSubreddit).toHaveBeenCalledTimes(2),
    );

    const existingKeys = new Set(hoisted.redisValues.keys());
    await routes.get(internalRoutes.menu.createGoal)?.(
      {} as Request,
      { json: vi.fn() } as unknown as Response,
    );
    const keyB = [...hoisted.redisValues.keys()].find(
      (key) =>
        key.startsWith("create_goal_draft_v5:t2_mod:") &&
        !key.endsWith(":lease") &&
        !existingKeys.has(key),
    )!;
    const draftBBefore = hoisted.redisValues.get(keyB)!;

    pausedSubreddit.resolve(subreddit);
    await submissionA;

    expect(hoisted.redisValues.has(testDraftKey(attemptA))).toBe(false);
    expect(hoisted.redisValues.get(keyB)).toBe(draftBBefore);
    const attemptB = keyB.split(":").at(-1)!;
    await routes.get(internalRoutes.forms.createGoalSetup)?.(
      {
        body: {
          language: ["en"],
          subredditDisplayName: "ExampleSub",
          [`postHeight__creation_attempt__${attemptB}`]: ["tiny"],
        },
      } as Request,
      { json: vi.fn() } as unknown as Response,
    );
    expect(JSON.parse(hoisted.redisValues.get(keyB)!)).toMatchObject({
      stage: "details",
    });
    const finalJson = await finishTinyDraft(routes, attemptB);
    expect(finalJson).toHaveBeenCalledWith(
      expect.objectContaining({
        navigateTo: expect.stringContaining("/comments/t3_newpost"),
      }),
    );
  });

  it("serializes same-attempt callbacks and prevents a late stage replay", async () => {
    const attempt = "create-goal-order-a12";
    seedCreateGoalDraft("regular", "en", {
      stage: "setup",
      creationAttemptId: attempt,
    });
    const routes = createRouteHarness();
    const pausedSubreddit = deferred<{
      id: string;
      name: string;
      numberOfSubscribers: number;
      type: string;
      nsfw: boolean;
    }>();
    hoisted.reddit.getCurrentSubreddit.mockImplementationOnce(
      () => pausedSubreddit.promise,
    );
    const setupBody = {
      language: ["en"],
      subredditDisplayName: "ExampleSub",
      [`postHeight__creation_attempt__${attempt}`]: ["regular"],
    };

    const first = routes.get(internalRoutes.forms.createGoalSetup)?.(
      { body: { ...setupBody } } as Request,
      { json: vi.fn() } as unknown as Response,
    );
    await Promise.resolve();
    await Promise.resolve();
    const secondJson = vi.fn();
    await routes.get(internalRoutes.forms.createGoalSetup)?.(
      { body: { ...setupBody } } as Request,
      { json: secondJson } as unknown as Response,
    );

    expect(secondJson).toHaveBeenCalledWith({
      showToast: expect.stringContaining("already in progress"),
    });
    expect(
      JSON.parse(hoisted.redisValues.get(testDraftKey(attempt))!),
    ).toMatchObject({
      stage: "setup",
    });

    pausedSubreddit.resolve({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      type: "public",
      nsfw: false,
    });
    await first;
    expect(
      JSON.parse(hoisted.redisValues.get(testDraftKey(attempt))!),
    ).toMatchObject({
      stage: "details",
    });

    await routes.get(internalRoutes.forms.createSubscriberGoal)?.(
      {
        body: {
          [`postTitle__creation_attempt__${attempt}`]: "Welcome!",
          subscriberGoal: 200,
          colorTheme: ["red"],
          afterSubscribePreset: ["top-post-day"],
        },
      } as Request,
      { json: vi.fn() } as unknown as Response,
    );
    const followUpDraft = hoisted.redisValues.get(testDraftKey(attempt))!;
    expect(JSON.parse(followUpDraft)).toMatchObject({ stage: "follow-up" });

    await routes.get(internalRoutes.forms.createGoalSetup)?.(
      { body: { ...setupBody } } as Request,
      { json: vi.fn() } as unknown as Response,
    );
    expect(hoisted.redisValues.get(testDraftKey(attempt))).toBe(followUpDraft);
  });

  it("rejects invalid setup selections without storing a draft", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoalSetup)?.(
      { body: { language: ["invalid"], postHeight: ["giant"] } } as Request,
      res,
    );

    expect(json).toHaveBeenCalledWith({
      showToast: "Please select a valid language and post height.",
    });
    expect(hoisted.redis.set).not.toHaveBeenCalled();
  });

  it("rejects an expired callback when no operation can be recovered", async () => {
    const routes = createRouteHarness();
    hoisted.redisValues.clear();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          colorTheme: ["red"],
        },
      } as Request,
      res,
    );

    expect(json).toHaveBeenCalledWith({
      showToast: expect.stringContaining("expired"),
    });
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
  });

  it("lets an expired callback recover its completed operation without resubmitting", async () => {
    vi.useFakeTimers();
    const creationAttemptId = "create-goal-recover12";
    seedCreateGoalDraft("tiny", "en", { creationAttemptId });
    const post = {
      id: "t3_newpost",
      subredditName: "ExampleSub",
      subredditId: "t5_example",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      title: "Welcome!",
      approve: vi.fn(),
      highlight: vi.fn(),
      isHighlighted: vi.fn(async () => true),
    };
    hoisted.createGoalPost.mockResolvedValue(post);
    hoisted.reddit.getPostById.mockResolvedValue(post);
    const routes = createRouteHarness();
    const firstJson = vi.fn();
    const secondJson = vi.fn();

    const firstResponse = routes.get(
      internalRoutes.forms.createSubscribeOnlyFollowUp,
    )?.({ body: {} } as Request, { json: firstJson } as unknown as Response);
    await vi.advanceTimersByTimeAsync(30_000);
    await firstResponse;
    expect(hoisted.redisValues.has(testDraftKey(creationAttemptId))).toBe(
      false,
    );

    await routes.get(internalRoutes.forms.createSubscribeOnlyFollowUp)?.(
      {
        body: {
          [`afterSubscribeButtonText__creation_attempt__${creationAttemptId}`]:
            "View the Top Post Today",
        },
      } as Request,
      { json: secondJson } as unknown as Response,
    );

    expect(hoisted.createGoalPost).toHaveBeenCalledOnce();
    expect(secondJson).toHaveBeenCalledWith(
      expect.objectContaining({
        navigateTo: "https://reddit.com/r/ExampleSub/comments/t3_newpost",
      }),
    );
  });

  it("rejects a Tiny draft submitted through the subscriber-goal form", async () => {
    seedCreateGoalDraft("tiny", "en");
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      { body: {} } as Request,
      res,
    );

    expect(json).toHaveBeenCalledWith({
      showToast: expect.stringContaining("expired"),
    });
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
  });

  it("shows the prohibited message when the subreddit is blacklisted", async () => {
    seedCreateGoalDraft("regular", "en");
    hoisted.isSubredditBlacklisted.mockResolvedValue(true);
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      { body: {} } as Request,
      res,
    );

    expect(json).toHaveBeenCalledWith({
      showToast: "This content is prohibited",
    });
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
  });

  it("retains the draft when subscriber-goal validation fails", async () => {
    seedCreateGoalDraft("regular", "en", { stage: "details" });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoal)?.(
      {
        body: {
          subscriberGoal: 100,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          colorTheme: ["red"],
        },
      } as Request,
      res,
    );

    expect(hoisted.redis.del).not.toHaveBeenCalled();
    expect(hoisted.redisValues.has(testDraftKey())).toBe(true);
  });

  it("passes the selected color theme when creating a goal post", async () => {
    seedCreateGoalDraft("short", "es", {
      colorTheme: "blue",
      autoCreateNextGoal: false,
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["blue"],
          postHeight: ["short"],
          language: ["es"],
        },
      } as Request,
      res,
    );

    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledWith(
      hoisted.reddit,
      hoisted.redis,
      expect.anything(),
      expect.objectContaining({ id: "t3_newpost" }),
      200,
      false,
      "ExampleSub",
      "blue",
      false,
      "es",
      undefined,
      "short",
      {
        type: "top-post-day",
        buttonText: "Ver la publicación destacada de hoy",
        colorTheme: "blue",
      },
      "top-post-day",
    );
    expect(hoisted.cancelAllAutoCreateNextGoals).toHaveBeenCalledWith(
      hoisted.redis,
    );
    expect(hoisted.redis.del).toHaveBeenCalledWith(testDraftKey());
    expect(hoisted.redisValues.has(testDraftKey())).toBe(false);
  });

  it("persists a trimmed HTTPS follow-up CTA and its secondary Pink color", async () => {
    seedCreateGoalDraft("regular", "en", {
      colorTheme: "red",
      afterSubscribePreset: "web-link",
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          afterSubscribeButtonText: "  Join the Discord  ",
          afterSubscribeUrl: " https://discord.com/invite/example ",
          afterSubscribeColorTheme: ["pink"],
        },
      } as Request,
      res,
    );

    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledWith(
      hoisted.reddit,
      hoisted.redis,
      expect.anything(),
      expect.objectContaining({ id: "t3_newpost" }),
      200,
      false,
      "ExampleSub",
      "red",
      true,
      "en",
      undefined,
      "regular",
      {
        type: "link",
        buttonText: "Join the Discord",
        url: "https://discord.com/invite/example",
        colorTheme: "pink",
      },
      "web-link",
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ showToast: "Subscriber Goal post created!" }),
    );
  });

  it("returns an actionable error before creating a post when the app lacks Manage Posts", async () => {
    seedCreateGoalDraft("regular", "en");
    hoisted.getModPermissionsForSubreddit.mockResolvedValue(["flair"]);
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      { body: {} } as Request,
      res,
    );

    expect(hoisted.ensureSubscriberGoalPostFlair).not.toHaveBeenCalled();
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      showToast:
        "u/subscriber-goal must be a moderator of r/ExampleSub with Manage Posts permission. Restore the app account's moderator permissions or reinstall Subscriber Goal, then try again.",
    });
  });

  it("creates successfully without flair and warns the moderator when only Posts is granted", async () => {
    seedCreateGoalDraft("regular", "en");
    hoisted.getModPermissionsForSubreddit.mockResolvedValue(["posts"]);
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      { body: {} } as Request,
      res,
    );

    expect(hoisted.ensureSubscriberGoalPostFlair).not.toHaveBeenCalled();
    expect(hoisted.createGoalPost).toHaveBeenCalledWith(
      expect.not.objectContaining({ flairId: expect.anything() }),
    );
    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        showToast: expect.stringContaining(
          "The post was created without Subscriber Goal flair; check the app account's Manage Flair permission.",
        ),
      }),
    );
  });

  it("uses the localized Discord label and Blue default when only its URL is entered", async () => {
    seedCreateGoalDraft("tiny", "es", {
      colorTheme: "pink",
      afterSubscribePreset: "discord",
    });
    const routes = createRouteHarness();

    await routes.get(internalRoutes.forms.createSubscribeOnlyFollowUp)?.(
      {
        body: {
          afterSubscribeUrl: "https://discord.gg/example",
        },
      } as Request,
      { json: vi.fn() } as unknown as Response,
    );

    expect(hoisted.registerNewSubscribeOnlyPost).toHaveBeenCalledWith(
      hoisted.redis,
      expect.anything(),
      expect.objectContaining({ id: "t3_newpost" }),
      "ExampleSub",
      "pink",
      "es",
      {
        type: "link",
        buttonText: "Únete al Discord",
        url: "https://discord.gg/example",
        colorTheme: "blue",
      },
      "discord",
    );
  });

  it("rejects invalid CTA data and preserves the submitted values", async () => {
    seedCreateGoalDraft("tiny", "en", {
      colorTheme: "blue",
      afterSubscribePreset: "web-link",
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscribeOnlyFollowUp)?.(
      {
        body: {
          afterSubscribeButtonText: "No",
          afterSubscribeUrl: "http://insecure.example",
          afterSubscribeColorTheme: ["pink"],
        },
      } as Request,
      res,
    );

    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubscribeOnlyPost).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        showToast: expect.stringContaining(
          "Please enter button text between 5 and 50 characters",
        ),
        showForm: expect.objectContaining({
          form: expect.objectContaining({
            fields: expect.arrayContaining([
              expect.objectContaining({
                name: "afterSubscribeButtonText",
                defaultValue: "No",
              }),
              expect.objectContaining({
                name: "afterSubscribeUrl",
                defaultValue: "http://insecure.example",
              }),
              expect.objectContaining({
                name: "afterSubscribeColorTheme",
                defaultValue: ["pink"],
              }),
            ]),
          }),
        }),
      }),
    );
    expect(hoisted.redisValues.has(testDraftKey())).toBe(true);
  });

  it.each([
    ["web-link", { afterSubscribeButtonText: "Read the rules" }],
    ["discord", {}],
    ["wiki", {}],
  ] as const)(
    "rejects the %s preset when its required URL is missing",
    async (afterSubscribePreset, body) => {
      seedCreateGoalDraft("tiny", "en", {
        colorTheme: "red",
        afterSubscribePreset,
      });
      const routes = createRouteHarness();

      await routes.get(internalRoutes.forms.createSubscribeOnlyFollowUp)?.(
        { body } as Request,
        { json: vi.fn() } as unknown as Response,
      );

      expect(hoisted.createGoalPost).not.toHaveBeenCalled();
      expect(hoisted.registerNewSubscribeOnlyPost).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["create-post", "Create a New Post"],
    ["share-picture", "Share an Image"],
  ] as const)(
    "derives the canonical subreddit submit URL for %s",
    async (afterSubscribePreset, buttonText) => {
      seedCreateGoalDraft("tiny", "en", {
        colorTheme: "pink",
        afterSubscribePreset,
      });
      const routes = createRouteHarness();

      await routes.get(internalRoutes.forms.createSubscribeOnlyFollowUp)?.(
        { body: {} } as Request,
        { json: vi.fn() } as unknown as Response,
      );

      expect(hoisted.registerNewSubscribeOnlyPost).toHaveBeenCalledWith(
        hoisted.redis,
        expect.anything(),
        expect.objectContaining({ id: "t3_newpost" }),
        "ExampleSub",
        "pink",
        "en",
        {
          type: "link",
          buttonText,
          url: "https://www.reddit.com/r/ExampleSub/submit/",
          colorTheme: "blue",
        },
        afterSubscribePreset,
      );
    },
  );

  it.each([
    ["top-post-day", "View the Top Post Today"],
    ["newest-post", "View the Most Recent Post"],
  ] as const)(
    "persists the URL-free %s dynamic action",
    async (afterSubscribePreset, buttonText) => {
      seedCreateGoalDraft("regular", "en", {
        colorTheme: "green",
        afterSubscribePreset,
      });
      const routes = createRouteHarness();

      await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
        { body: {} } as Request,
        { json: vi.fn() } as unknown as Response,
      );

      expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledWith(
        hoisted.reddit,
        hoisted.redis,
        expect.anything(),
        expect.objectContaining({ id: "t3_newpost" }),
        200,
        false,
        "ExampleSub",
        "green",
        true,
        "en",
        undefined,
        "regular",
        { type: afterSubscribePreset, buttonText, colorTheme: "blue" },
        afterSubscribePreset,
      );
    },
  );

  it("normalizes a stale NSFW dynamic-action draft to default Create Post settings", async () => {
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      type: "public",
      nsfw: true,
    });
    seedCreateGoalDraft("regular", "es", {
      colorTheme: "green",
      afterSubscribePreset: "newest-post",
    });
    const routes = createRouteHarness();

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          afterSubscribeButtonText: "Keep this forged text",
          afterSubscribeColorTheme: ["pink"],
        },
      } as Request,
      { json: vi.fn() } as unknown as Response,
    );

    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledWith(
      hoisted.reddit,
      hoisted.redis,
      expect.anything(),
      expect.objectContaining({ id: "t3_newpost" }),
      200,
      false,
      "ExampleSub",
      "green",
      true,
      "es",
      undefined,
      "regular",
      {
        type: "link",
        buttonText: "Crear una publicación",
        url: "https://www.reddit.com/r/ExampleSub/submit/",
        colorTheme: "blue",
      },
      "create-post",
    );
  });

  it("creates tiny posts without requiring or registering a subscriber goal", async () => {
    seedCreateGoalDraft("tiny", "en");
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscribeOnlyFollowUp)?.(
      {
        body: {
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: true,
          colorTheme: ["red"],
          postHeight: ["tiny"],
          autoCreateNextGoal: true,
          language: ["en"],
        },
      } as Request,
      res,
    );

    expect(hoisted.createGoalPost).toHaveBeenCalledWith(
      expect.objectContaining({
        postHeight: "tiny",
      }),
    );
    expect(hoisted.registerNewSubscribeOnlyPost).toHaveBeenCalledWith(
      hoisted.redis,
      expect.anything(),
      expect.objectContaining({ id: "t3_newpost" }),
      "ExampleSub",
      "red",
      "en",
      {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "blue",
      },
      "top-post-day",
    );
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
  });

  it("creates CTA-only posts with the CTA color as the frame theme", async () => {
    seedCreateGoalDraft("cta", "en", {
      afterSubscribePreset: "create-post",
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createCtaOnlyFollowUp)?.(
      {
        body: {
          afterSubscribeButtonText: "Start a New Post",
          afterSubscribeColorTheme: ["pink"],
        },
      } as Request,
      res,
    );

    expect(hoisted.createGoalPost).toHaveBeenCalledWith(
      expect.objectContaining({ postHeight: "cta" }),
    );
    expect(hoisted.registerNewCtaOnlyPost).toHaveBeenCalledWith(
      hoisted.redis,
      expect.anything(),
      expect.objectContaining({ id: "t3_newpost" }),
      "ExampleSub",
      "pink",
      "en",
      {
        type: "link",
        buttonText: "Start a New Post",
        url: "https://www.reddit.com/r/ExampleSub/submit/",
        colorTheme: "pink",
      },
      "create-post",
    );
    expect(hoisted.registerNewSubscribeOnlyPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ showToast: "CTA post created!" }),
    );
  });

  it("localizes the default post title when Spanish is selected", async () => {
    seedCreateGoalDraft("regular", "es", {
      postTitle: "¡Bienvenido a r/ExampleSub!",
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "¡Bienvenido a r/ExampleSub!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["red"],
          autoCreateNextGoal: true,
          language: ["es"],
        },
      } as Request,
      res,
    );

    expect(hoisted.createGoalPost).toHaveBeenCalledWith({
      title: "¡Bienvenido a r/ExampleSub!",
      subredditName: "ExampleSub",
      textFallback: expect.stringContaining(
        "100 suscriptores / 200 suscriptores.",
      ),
      postHeight: "regular",
      language: "es",
      flairId: "flair_subgoal",
    });
  });

  it("passes submitAsUser when the custom developer field is exactly runAs", async () => {
    seedCreateGoalDraft("regular", "en", {
      customDeveloperField: " runAs ",
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["red"],
          autoCreateNextGoal: true,
          language: ["en"],
          customDeveloperField: " runAs ",
        },
      } as Request,
      res,
    );

    expect(hoisted.createGoalPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: expect.stringContaining(
        "100 subscribers / 200 subscribers.",
      ),
      postHeight: "regular",
      language: "en",
      flairId: "flair_subgoal",
      submitAsUser: true,
    });
  });

  it("submits a selfPost to the executing user's personal feed and skips normal goal creation", async () => {
    seedCreateGoalDraft("regular", "en", {
      customDeveloperField: "selfPost",
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["red"],
          autoCreateNextGoal: true,
          language: ["en"],
          customDeveloperField: "selfPost",
        },
      } as Request,
      res,
    );

    expect(hoisted.reddit.submitPost).toHaveBeenCalledWith({
      subredditName: "u_ExampleMod",
      title: "Subscriber Goal test for r/ExampleSub",
      text: expect.stringContaining("Source subreddit: r/ExampleSub"),
      runAs: "USER",
    });
    expect(hoisted.reddit.submitPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Subscriber count: 100"),
      }),
    );
    expect(hoisted.reddit.submitPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Executor: u/ExampleMod"),
      }),
    );
    expect(hoisted.reddit.submitPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Target: r/u_ExampleMod"),
      }),
    );
    expect(hoisted.reddit.submitPost).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Created via Devvit runAs: USER."),
      }),
    );
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
    expect(hoisted.cancelAllAutoCreateNextGoals).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      showToast: "Experimental selfPost submitted to r/u_ExampleMod.",
      navigateTo:
        "https://reddit.com/user/ExampleMod/comments/selfpost/subscriber_goal_test/",
    });
  });

  it("returns a selfPost failure toast when the executing username is unavailable", async () => {
    hoisted.reddit.getCurrentUsername.mockResolvedValue(undefined);
    seedCreateGoalDraft("regular", "en", {
      customDeveloperField: "selfPost",
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["red"],
          autoCreateNextGoal: true,
          language: ["en"],
          customDeveloperField: "selfPost",
        },
      } as Request,
      res,
    );

    expect(hoisted.reddit.submitPost).not.toHaveBeenCalled();
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      showToast:
        "The selfPost developer command requires an authenticated Reddit user.",
    });
  });

  it("returns a selfPost failure toast when submitting to the user feed fails", async () => {
    hoisted.reddit.submitPost.mockRejectedValue(new Error("user feed denied"));
    seedCreateGoalDraft("regular", "en", {
      customDeveloperField: "selfPost",
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["red"],
          autoCreateNextGoal: true,
          language: ["en"],
          customDeveloperField: "selfPost",
        },
      } as Request,
      res,
    );

    expect(hoisted.reddit.submitPost).toHaveBeenCalledWith(
      expect.objectContaining({
        subredditName: "u_ExampleMod",
        runAs: "USER",
      }),
    );
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      showToast: "The experimental self-post could not be submitted.",
    });
  });

  it("passes submitAsUser and headerText when multiple developer commands are provided", async () => {
    seedCreateGoalDraft("regular", "en", {
      customDeveloperField:
        'runAs, header="This post uses runAs and Custom Header"',
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["red"],
          autoCreateNextGoal: true,
          language: ["en"],
          customDeveloperField:
            'runAs, header="This post uses runAs and Custom Header"',
        },
      } as Request,
      res,
    );

    expect(hoisted.createGoalPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: expect.stringContaining(
        "100 subscribers / 200 subscribers.",
      ),
      postHeight: "regular",
      language: "en",
      flairId: "flair_subgoal",
      submitAsUser: true,
    });
    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledWith(
      hoisted.reddit,
      hoisted.redis,
      expect.anything(),
      expect.objectContaining({ id: "t3_newpost" }),
      200,
      false,
      "ExampleSub",
      "red",
      true,
      "en",
      "This post uses runAs and Custom Header",
      "regular",
      {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "blue",
      },
      "top-post-day",
    );
  });

  it("does not pass submitAsUser when the custom developer field is empty", async () => {
    seedCreateGoalDraft("regular", "en", { customDeveloperField: "   " });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["red"],
          autoCreateNextGoal: true,
          language: ["en"],
          customDeveloperField: "   ",
        },
      } as Request,
      res,
    );

    expect(hoisted.createGoalPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: expect.stringContaining(
        "100 subscribers / 200 subscribers.",
      ),
      postHeight: "regular",
      language: "en",
      flairId: "flair_subgoal",
    });
  });

  it("ignores wrong-case custom developer commands", async () => {
    seedCreateGoalDraft("regular", "en", {
      customDeveloperField: "RunAs",
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["red"],
          autoCreateNextGoal: true,
          language: ["en"],
          customDeveloperField: "RunAs",
        },
      } as Request,
      res,
    );

    expect(hoisted.createGoalPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: expect.stringContaining(
        "100 subscribers / 200 subscribers.",
      ),
      postHeight: "regular",
      language: "en",
      flairId: "flair_subgoal",
    });
  });

  it("ignores unknown developer commands without blocking creation", async () => {
    seedCreateGoalDraft("regular", "en", {
      customDeveloperField: 'unknown, header="Custom Header"',
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createSubscriberGoalFollowUp)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["red"],
          autoCreateNextGoal: true,
          language: ["en"],
          customDeveloperField: 'unknown, header="Custom Header"',
        },
      } as Request,
      res,
    );

    expect(hoisted.createGoalPost).toHaveBeenCalledWith({
      title: "Welcome!",
      subredditName: "ExampleSub",
      textFallback: expect.stringContaining(
        "100 subscribers / 200 subscribers.",
      ),
      postHeight: "regular",
      language: "en",
      flairId: "flair_subgoal",
    });
    expect(hoisted.registerNewSubGoalPost).toHaveBeenCalledWith(
      hoisted.reddit,
      hoisted.redis,
      expect.anything(),
      expect.objectContaining({ id: "t3_newpost" }),
      200,
      false,
      "ExampleSub",
      "red",
      true,
      "en",
      "Custom Header",
      "regular",
      {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "blue",
      },
      "top-post-day",
    );
  });

  it("notifies moderators and returns a partial-success toast when the new goal cannot be highlighted", async () => {
    vi.useFakeTimers();
    seedCreateGoalDraft("regular", "en", {
      afterSubscribePreset: "top-post-day",
    });
    hoisted.createGoalPost.mockResolvedValue({
      id: "t3_newpost",
      subredditName: "ExampleSub",
      subredditId: "t5_example",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      title: "Welcome!",
      permalink: "/r/ExampleSub/comments/newpost/welcome/",
      approve: vi.fn(),
      highlight: vi.fn(),
      isHighlighted: vi.fn(() => false),
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    const responsePromise = routes.get(
      internalRoutes.forms.createSubscriberGoalFollowUp,
    )?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["red"],
          autoCreateNextGoal: true,
          language: ["en"],
        },
      } as Request,
      res,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await responsePromise;

    expect(hoisted.reddit.modMail.createModNotification).toHaveBeenCalledWith({
      subredditId: "t5_example",
      subject: "Action Required - SubGoal Not Highlighted in r/ExampleSub",
      bodyMarkdown: expect.stringContaining(
        "The new Subscriber Goal post was created successfully",
      ),
    });
    expect(hoisted.reddit.sendPrivateMessage).toHaveBeenCalledWith({
      to: "ExampleMod",
      subject: "Action Required - SubGoal Not Highlighted in r/ExampleSub",
      text: expect.stringContaining(
        "https://reddit.com/r/ExampleSub/comments/newpost/welcome/",
      ),
    });
    expect(res.json).toHaveBeenCalledWith({
      showToast:
        "Subscriber Goal post created. The goal was created, but Reddit did not confirm it as a Community Highlight.",
      navigateTo: "https://reddit.com/r/ExampleSub/comments/t3_newpost",
    });
  });

  it("logs notification failures without breaking partial-success creation", async () => {
    vi.useFakeTimers();
    seedCreateGoalDraft("regular", "en", {
      afterSubscribePreset: "top-post-day",
    });
    hoisted.createGoalPost.mockResolvedValue({
      id: "t3_newpost",
      subredditName: "ExampleSub",
      subredditId: "t5_example",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      title: "Welcome!",
      approve: vi.fn(),
      highlight: vi.fn(() => {
        throw new Error("highlight slots full");
      }),
      isHighlighted: vi.fn(() => false),
    });
    hoisted.reddit.modMail.createModNotification.mockRejectedValue(
      new Error("modmail unavailable"),
    );
    hoisted.reddit.sendPrivateMessage.mockRejectedValue(
      new Error("dm unavailable"),
    );
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    const responsePromise = routes.get(
      internalRoutes.forms.createSubscriberGoalFollowUp,
    )?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["red"],
          autoCreateNextGoal: true,
          language: ["en"],
        },
      } as Request,
      res,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await responsePromise;

    expect(hoisted.reddit.modMail.createModNotification).toHaveBeenCalled();
    expect(hoisted.reddit.sendPrivateMessage).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      showToast:
        "Subscriber Goal post created. The goal was created, but Reddit did not confirm it as a Community Highlight.",
      navigateTo: "https://reddit.com/r/ExampleSub/comments/t3_newpost",
    });
  });
});
