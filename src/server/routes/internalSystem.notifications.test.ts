import type { Request, Response, Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internalRoutes } from "../../shared/routes";
import { redis } from "@devvit/web/server";

const hoisted = vi.hoisted(() => ({
  getSubGoalData: vi.fn(),
  getCurrentSubreddit: vi.fn(),
  runJob: vi.fn(),
  listOptedInUsers: vi.fn(),
  enqueue: vi.fn(),
  incrBy: vi.fn(),
  expire: vi.fn(),
  onAppChanged: vi.fn(),
  onModAction: vi.fn(),
  recordCommunityPostCreated: vi.fn(),
  processAppAccountRecovery: vi.fn(),
}));

vi.mock("@devvit/web/server", () => ({
  reddit: { getCurrentSubreddit: hoisted.getCurrentSubreddit },
  redis: { incrBy: hoisted.incrBy, expire: hoisted.expire },
  scheduler: { runJob: hoisted.runJob },
}));

vi.mock("@devvit/notifications", () => ({
  notifications: {
    listOptedInUsers: hoisted.listOptedInUsers,
    enqueue: hoisted.enqueue,
  },
}));

vi.mock("../data/subGoalData", () => ({
  getSubGoalData: hoisted.getSubGoalData,
}));
vi.mock("../triggers/appChanged", () => ({
  onAppChanged: hoisted.onAppChanged,
}));
vi.mock("../triggers/modAction", () => ({ onModAction: hoisted.onModAction }));
vi.mock("../triggers/scheduler", () => ({ onPostsUpdaterJob: vi.fn() }));
vi.mock("../data/ctaActivity", () => ({
  recordCommunityPostCreated: hoisted.recordCommunityPostCreated,
}));
vi.mock("../core/appAccountRecovery", () => ({
  processAppAccountRecovery: hoisted.processAppAccountRecovery,
}));

import { registerInternalSystemRoutes } from "./internalSystem";

type Handler = (req: Request, res: Response) => void | Promise<void>;

describe("moderation and post creation trigger routes", () => {
  const modAction = {
    action: "removelink",
    targetPost: { id: "t3_source", subredditId: "t5_source" },
  };
  const post = { id: "t3_created", createdAt: 1_789_000_000_000 };

  beforeEach(() => vi.resetAllMocks());

  async function invoke(path: string, body: unknown) {
    const handlers = new Map<string, Handler>();
    const router = {
      post: (route: string, handler: Handler) => handlers.set(route, handler),
    } as unknown as Router;
    registerInternalSystemRoutes(router);
    const handler = handlers.get(path);
    if (!handler) throw new Error(`Missing trigger route ${path}`);
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    await handler({ body } as Request, { json, status } as unknown as Response);
    return { json, status };
  }

  it.each([
    ["wrapped", { modAction }],
    ["bare", modAction],
  ])("passes the %s mod action to the handler", async (_shape, body) => {
    const { json, status } = await invoke(
      internalRoutes.triggers.onModAction,
      body,
    );
    expect(hoisted.onModAction).toHaveBeenCalledExactlyOnceWith(modAction);
    expect(status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledExactlyOnceWith({ status: "ok" });
  });

  it.each([
    ["wrapped", { post }],
    ["bare", post],
  ])("records the %s post using its ID and timestamp", async (_shape, body) => {
    const { json, status } = await invoke(
      internalRoutes.triggers.onPostCreate,
      body,
    );
    expect(hoisted.recordCommunityPostCreated).toHaveBeenCalledExactlyOnceWith(
      redis,
      post.id,
      post.createdAt,
    );
    expect(status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledExactlyOnceWith({ status: "ok" });
  });

  it.each([{ post: { id: 42 } }, { createdAt: post.createdAt }, undefined])(
    "rejects a post without a string ID (%j)",
    async (body) => {
      const { json, status } = await invoke(
        internalRoutes.triggers.onPostCreate,
        body,
      );
      expect(hoisted.recordCommunityPostCreated).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledExactlyOnceWith(400);
      expect(json).toHaveBeenCalledExactlyOnceWith({
        status: "error",
        message: "Post ID is required.",
      });
    },
  );

  it.each(
    [
      {
        modAction: {
          action: "removelink",
          targetPost: { authorId: "t2_author" },
        },
      },
      { action: "removelink", targetPost: { id: 42 } },
      { action: "removemoderator", targetUser: { name: 42 } },
      { action: "approvelink", targetPost: { id: "t3_source", nsfw: "false" } },
      { action: 42 },
      { actionedAt: 42 },
      { moderator: [] },
      { modAction: null },
      [],
      null,
    ].map((body) => ({ body })),
  )(
    "returns 400 without invoking the handler for a malformed mod action ($body)",
    async ({ body }) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { json, status } = await invoke(
          internalRoutes.triggers.onModAction,
          body,
        );
        expect(status).toHaveBeenCalledExactlyOnceWith(400);
        expect(json).toHaveBeenCalledExactlyOnceWith({
          status: "error",
          message: "Invalid mod action event.",
        });
        expect(hoisted.onModAction).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining('"event":"internal_trigger_failed"'),
        );
      } finally {
        error.mockRestore();
      }
    },
  );

  it.each([
    [
      internalRoutes.triggers.onModAction,
      { modAction },
      hoisted.onModAction,
      "mod_action",
      "Failed to handle mod action",
    ],
    [
      internalRoutes.triggers.onPostCreate,
      { post },
      hoisted.recordCommunityPostCreated,
      "post_create",
      "Failed to record post creation",
    ],
  ] as const)(
    "returns a safe error when %s throws",
    async (path, body, handler, workflow, message) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      handler.mockRejectedValueOnce(new Error("platform unavailable"));
      try {
        const { json, status } = await invoke(path, body);
        expect(status).toHaveBeenCalledExactlyOnceWith(503);
        expect(json).toHaveBeenCalledExactlyOnceWith({
          status: "error",
          message,
        });
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining(`"workflow":"${workflow}"`),
        );
      } finally {
        error.mockRestore();
      }
    },
  );
});

describe("milestone notification scheduler route", () => {
  beforeEach(() => vi.resetAllMocks());

  it("suppresses direct invocation before loading recipients or goal data", async () => {
    let handler: Handler | undefined;
    const router = {
      post: (path: string, candidate: Handler) => {
        if (path === internalRoutes.scheduler.milestoneNotificationJob) {
          handler = candidate;
        }
      },
    } as unknown as Router;
    registerInternalSystemRoutes(router);
    const json = vi.fn();

    await handler?.(
      {
        body: {
          data: {
            campaign: "milestone-completed",
            postId: "t3_goal",
            completedTime: 1_789_000_000_000,
            cursor: "",
            attemptedRecipients: 0,
          },
        },
      } as Request,
      { json } as unknown as Response,
    );

    expect(json).toHaveBeenCalledWith({
      status: "suppressed",
      done: true,
      cursor: "",
    });
    expect(hoisted.getSubGoalData).not.toHaveBeenCalled();
    expect(hoisted.getCurrentSubreddit).not.toHaveBeenCalled();
    expect(hoisted.listOptedInUsers).not.toHaveBeenCalled();
    expect(hoisted.enqueue).not.toHaveBeenCalled();
    expect(hoisted.incrBy).not.toHaveBeenCalled();
    expect(hoisted.expire).not.toHaveBeenCalled();
    expect(hoisted.runJob).not.toHaveBeenCalled();
  });
});

describe("app lifecycle routes", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    [internalRoutes.triggers.onAppInstall, "install"],
    [internalRoutes.triggers.onAppUpgrade, "upgrade"],
  ] as const)(
    "passes installer identity from %s",
    async (path, lifecycleSource) => {
      let handler: Handler | undefined;
      const router = {
        post: (candidatePath: string, candidate: Handler) => {
          if (candidatePath === path) handler = candidate;
        },
      } as unknown as Router;
      registerInternalSystemRoutes(router);
      const json = vi.fn();

      await handler?.(
        { body: { installer: { name: "InstallingMod" } } } as Request,
        { json } as unknown as Response,
      );

      expect(hoisted.onAppChanged).toHaveBeenCalledWith({
        lifecycleSource,
        installerUsername: "InstallingMod",
      });
      expect(json).toHaveBeenCalledWith({ status: "ok" });
    },
  );
});

describe("app-account recovery scheduler route", () => {
  beforeEach(() => vi.resetAllMocks());

  const getHandler = (): Handler | undefined => {
    let handler: Handler | undefined;
    const router = {
      post: (path: string, candidate: Handler) => {
        if (path === internalRoutes.scheduler.appAccountRecoveryJob) {
          handler = candidate;
        }
      },
    } as unknown as Router;
    registerInternalSystemRoutes(router);
    return handler;
  };

  it("processes a typed incident token", async () => {
    const result = { status: "healthy", incidentToken: "incident-1" };
    hoisted.processAppAccountRecovery.mockResolvedValue(result);
    const json = vi.fn();

    await getHandler()?.(
      { body: { data: { incidentToken: "incident-1" } } } as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.processAppAccountRecovery).toHaveBeenCalledWith({
      reddit: expect.any(Object),
      redis: expect.any(Object),
      scheduler: expect.any(Object),
      incidentToken: "incident-1",
    });
    expect(json).toHaveBeenCalledWith(result);
  });

  it("rejects a missing incident token", async () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });

    await getHandler()?.(
      { body: { data: {} } } as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      status: "error",
      message: "Recovery incident token is required.",
    });
    expect(hoisted.processAppAccountRecovery).not.toHaveBeenCalled();
  });

  it("returns 503 when recovery processing fails", async () => {
    hoisted.processAppAccountRecovery.mockRejectedValue(new Error("failed"));
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });

    await getHandler()?.(
      { body: { incidentToken: "incident-1" } } as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      status: "error",
      message: "Failed to process app-account recovery",
    });
  });
});
