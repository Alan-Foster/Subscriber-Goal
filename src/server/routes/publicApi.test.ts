import type { Request, Response, Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../../shared/routes";
import type {
  InitResponse,
  RefreshResponse,
  SubscribeResponse,
} from "../../shared/types/api";

const hoisted = vi.hoisted(() => ({
  context: {
    postId: "t3_post",
    userId: null as string | null,
    subredditName: "ExampleSub",
    postData: undefined as Record<string, unknown> | undefined,
  },
  reddit: {
    getCurrentSubreddit: vi.fn(),
    getCurrentUsername: vi.fn(),
    subscribeToCurrentSubreddit: vi.fn(),
  },
  redis: {},
  realtime: {
    send: vi.fn(),
  },
  getPublicAppSettings: vi.fn(),
  getSubGoalData: vi.fn(),
  getSubredditIcon: vi.fn(),
  isTrackedSubscriber: vi.fn(),
  markSubscriber: vi.fn(),
  setNewSubscriber: vi.fn(),
  checkCompletionStatus: vi.fn(),
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
  checkCompletionStatus: hoisted.checkCompletionStatus,
  getSubGoalData: hoisted.getSubGoalData,
}));

vi.mock("../data/subscriberStats", () => ({
  isTrackedSubscriber: hoisted.isTrackedSubscriber,
  markSubscriber: hoisted.markSubscriber,
  setNewSubscriber: hoisted.setNewSubscriber,
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
    hoisted.context.subredditName = "ExampleSub";
    hoisted.context.postData = undefined;
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      isNsfw: false,
    });
    hoisted.getPublicAppSettings.mockReturnValue({ promoSubreddit: "SubGoal" });
    hoisted.getSubredditIcon.mockResolvedValue("/icon.png");
    hoisted.isTrackedSubscriber.mockResolvedValue(false);
    hoisted.markSubscriber.mockResolvedValue(true);
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscriber-goal-v1",
      goal: 200,
      recentSubscriber: null,
      completedTime: 0,
      subredditDisplayName: "ExampleSub",
      headerText: "Custom Header",
      colorTheme: "red",
      postHeight: "short",
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
    expect(response.state.postHeight).toBe("short");
  });

  it("initializes tiny posts from persistent anonymous subscriber status", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscribe-only-v1",
      goal: 0,
      recentSubscriber: null,
      completedTime: 0,
      subredditDisplayName: "ExampleSub",
      headerText: null,
      colorTheme: "purple",
      postHeight: "tiny",
      autoCreateNextGoal: false,
      language: "es",
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.init)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as InitResponse;
    expect(response.state).toEqual({
      colorTheme: "purple",
      postHeight: "tiny",
      language: "es",
      subscribed: true,
      authenticated: true,
      subreddit: { name: "ExampleSub" },
    });
    expect(hoisted.reddit.getCurrentSubreddit).not.toHaveBeenCalled();
    expect(hoisted.reddit.getCurrentUsername).not.toHaveBeenCalled();
    expect(hoisted.isTrackedSubscriber).toHaveBeenCalledWith(
      hoisted.redis,
      "t2_user",
    );
    expect(hoisted.getSubredditIcon).not.toHaveBeenCalled();
  });

  it("keeps Tiny subscribed state during refresh", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscribe-only-v1",
      goal: 0,
      recentSubscriber: null,
      completedTime: 0,
      subredditDisplayName: "ExampleSub",
      headerText: null,
      colorTheme: "red",
      postHeight: "tiny",
      autoCreateNextGoal: false,
      language: "en",
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.refresh)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as RefreshResponse;
    expect(response.state).toMatchObject({
      postHeight: "tiny",
      subscribed: true,
    });
  });

  it("does not look up subscriber status for logged-out Tiny viewers", async () => {
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscribe-only-v1",
      goal: 0,
      recentSubscriber: null,
      completedTime: 0,
      subredditDisplayName: "ExampleSub",
      headerText: null,
      colorTheme: "red",
      postHeight: "tiny",
      autoCreateNextGoal: false,
      language: "en",
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.init)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as InitResponse;
    expect(response.state).toMatchObject({
      postHeight: "tiny",
      authenticated: false,
      subscribed: false,
    });
    expect(hoisted.isTrackedSubscriber).not.toHaveBeenCalled();
  });

  it("recognizes marker-only users as subscribed on full goals", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.reddit.getCurrentUsername.mockResolvedValue("PrivateUser");
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.init)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as InitResponse;
    expect(response.state).toMatchObject({
      postHeight: "short",
      subscribed: true,
    });
    expect(hoisted.setNewSubscriber).not.toHaveBeenCalled();
  });

  it("subscribes tiny posts without recording or broadcasting subscriber data", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscribe-only-v1",
      goal: 0,
      recentSubscriber: null,
      completedTime: 0,
      subredditDisplayName: "ExampleSub",
      headerText: null,
      colorTheme: "red",
      postHeight: "tiny",
      autoCreateNextGoal: false,
      language: "en",
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.subscribe)?.(
      { body: { shareUsername: true } } as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as SubscribeResponse;
    expect(response.state).toMatchObject({
      postHeight: "tiny",
      subscribed: true,
      authenticated: true,
      subreddit: { name: "ExampleSub" },
    });
    expect(hoisted.reddit.subscribeToCurrentSubreddit).toHaveBeenCalledOnce();
    expect(hoisted.markSubscriber).toHaveBeenCalledWith(
      hoisted.redis,
      "t2_user",
    );
    expect(
      hoisted.reddit.subscribeToCurrentSubreddit.mock.invocationCallOrder[0],
    ).toBeLessThan(hoisted.markSubscriber.mock.invocationCallOrder[0]);
    expect(hoisted.reddit.getCurrentUsername).not.toHaveBeenCalled();
    expect(hoisted.reddit.getCurrentSubreddit).not.toHaveBeenCalled();
    expect(hoisted.isTrackedSubscriber).toHaveBeenCalledWith(
      hoisted.redis,
      "t2_user",
    );
    expect(hoisted.setNewSubscriber).not.toHaveBeenCalled();
    expect(hoisted.checkCompletionStatus).not.toHaveBeenCalled();
    expect(hoisted.realtime.send).not.toHaveBeenCalled();
  });

  it("does not report Tiny success when the anonymous Redis write fails", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.markSubscriber.mockRejectedValue(new Error("redis unavailable"));
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscribe-only-v1",
      goal: 0,
      recentSubscriber: null,
      completedTime: 0,
      subredditDisplayName: "ExampleSub",
      headerText: null,
      colorTheme: "red",
      postHeight: "tiny",
      autoCreateNextGoal: false,
      language: "en",
    });
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.subscribe)?.(
      { body: {} } as Request,
      { status } as unknown as Response,
    );

    expect(hoisted.reddit.subscribeToCurrentSubreddit).toHaveBeenCalledOnce();
    expect(hoisted.markSubscriber).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      status: "error",
      message: "Subscription failed: redis unavailable",
    });
    expect(hoisted.realtime.send).not.toHaveBeenCalled();
  });
});
