import type { Request, Response, Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../../shared/routes";
import type { InitResponse } from "../../shared/types/api";

const hoisted = vi.hoisted(() => ({
  context: {
    postId: "t3_post",
    userId: null as string | null,
  },
  reddit: {
    getCurrentSubreddit: vi.fn(),
  },
  redis: {},
  realtime: {
    send: vi.fn(),
  },
  getPublicAppSettings: vi.fn(),
  getSubGoalData: vi.fn(),
  getSubredditIcon: vi.fn(),
  getSubscriberStats: vi.fn(),
}));

vi.mock("@devvit/web/server", () => ({
  context: hoisted.context,
  reddit: hoisted.reddit,
  redis: hoisted.redis,
  realtime: hoisted.realtime,
}));

vi.mock("../settings", () => ({
  getPublicAppSettings: hoisted.getPublicAppSettings,
}));

vi.mock("../data/subGoalData", () => ({
  checkCompletionStatus: vi.fn(),
  getSubGoalData: hoisted.getSubGoalData,
}));

vi.mock("../data/subscriberStats", () => ({
  getSubscriberStats: hoisted.getSubscriberStats,
  setNewSubscriber: vi.fn(),
}));

vi.mock("../utils/redditUtils", () => ({
  getSubredditIcon: hoisted.getSubredditIcon,
}));

import { registerPublicApiRoutes } from "./publicApi";

type RouteHandler = (req: Request, res: Response) => void | Promise<void>;

function createRouteHarness(): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>();
  const router = {
    get: (path: string, handler: RouteHandler) => {
      routes.set(path, handler);
    },
    post: (path: string, handler: RouteHandler) => {
      routes.set(path, handler);
    },
  } as unknown as Router;
  registerPublicApiRoutes(router);
  return routes;
}

describe("publicApi routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.context.postId = "t3_post";
    hoisted.context.userId = null;
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      isNsfw: false,
    });
    hoisted.getPublicAppSettings.mockReturnValue({ promoSubreddit: "SubGoal" });
    hoisted.getSubredditIcon.mockResolvedValue("/icon.png");
    hoisted.getSubGoalData.mockResolvedValue({
      goal: 200,
      recentSubscriber: null,
      completedTime: 0,
      subredditDisplayName: "ExampleSub",
      headerText: "Custom Header",
      colorTheme: "red",
      autoCreateNextGoal: true,
      language: "en",
    });
  });

  it("returns custom header text through init state", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(apiRoutes.init)?.({} as Request, res);

    const response = json.mock.calls[0]?.[0] as InitResponse;
    expect(response.state.headerText).toBe("Custom Header");
  });
});
