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
vi.mock("../triggers/appChanged", () => ({ onAppChanged: vi.fn() }));
vi.mock("../triggers/modAction", () => ({ onModAction: vi.fn() }));
vi.mock("../triggers/scheduler", () => ({ onPostsUpdaterJob: vi.fn() }));
vi.mock("../data/ctaActivity", () => ({ recordCommunityPostCreated: vi.fn() }));

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
