import type { Request, Response, Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internalRoutes } from "../../shared/routes";

const hoisted = vi.hoisted(() => ({
  getSubGoalData: vi.fn(),
  getCurrentSubreddit: vi.fn(),
  runJob: vi.fn(),
  listOptedInUsers: vi.fn(),
  enqueue: vi.fn(),
  incrBy: vi.fn(),
  expire: vi.fn(),
  onAppChanged: vi.fn(),
  processInviteNewSubsReport: vi.fn(),
}));

vi.mock("@devvit/web/server", () => ({
  context: { subredditName: "subscriber_goal_dev" },
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
vi.mock("../triggers/modAction", () => ({ onModAction: vi.fn() }));
vi.mock("../triggers/scheduler", () => ({ onPostsUpdaterJob: vi.fn() }));
vi.mock("../data/ctaActivity", () => ({ recordCommunityPostCreated: vi.fn() }));
vi.mock("../core/inviteNewSubs", () => ({
  isInviteNewSubsDeliveryJob: vi.fn(),
  processInviteNewSubsDelivery: vi.fn(),
  processInviteNewSubsPoll: vi.fn(),
  processInviteNewSubsReport: hoisted.processInviteNewSubsReport,
}));

import { registerInternalSystemRoutes } from "./internalSystem";

type Handler = (req: Request, res: Response) => void | Promise<void>;

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

describe("new-subreddit DM report scheduler route", () => {
  beforeEach(() => vi.resetAllMocks());

  const getHandler = (): Handler | undefined => {
    let handler: Handler | undefined;
    const router = {
      post: (path: string, candidate: Handler) => {
        if (path === internalRoutes.scheduler.inviteNewSubsReportJob) {
          handler = candidate;
        }
      },
    } as unknown as Router;
    registerInternalSystemRoutes(router);
    return handler;
  };

  it("returns the report result", async () => {
    const result = {
      status: "sent",
      windowStart: 1,
      windowEnd: 2,
      total: 3,
      successful: 2,
      failed: 1,
    };
    hoisted.processInviteNewSubsReport.mockResolvedValue(result);
    const json = vi.fn();

    await getHandler()?.({} as Request, { json } as unknown as Response);

    expect(hoisted.processInviteNewSubsReport).toHaveBeenCalledWith({
      reddit: expect.any(Object),
      redis: expect.any(Object),
      subredditName: "subscriber_goal_dev",
    });
    expect(json).toHaveBeenCalledWith(result);
  });

  it("returns 503 so a failed report remains retryable", async () => {
    hoisted.processInviteNewSubsReport.mockRejectedValue(
      new Error("report failed"),
    );
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });

    await getHandler()?.({} as Request, { status } as unknown as Response);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      status: "error",
      message: "Failed to send new-subreddit DM report",
    });
  });
});
