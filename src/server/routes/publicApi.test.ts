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
    getTopPosts: vi.fn(),
    getNewPosts: vi.fn(),
    subscribeToCurrentSubreddit: vi.fn(),
  },
  redis: {},
  realtime: {
    send: vi.fn(),
  },
  getPublicAppSettings: vi.fn(),
  getSubGoalData: vi.fn(),
  getSubredditIcon: vi.fn(),
  observeDailySubscriberCount: vi.fn(),
  isTrackedSubscriber: vi.fn(),
  setNewSubscriber: vi.fn(),
  checkCompletionStatus: vi.fn(),
  isSubredditBlacklisted: vi.fn(),
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
  setNewSubscriber: hoisted.setNewSubscriber,
}));

vi.mock("../data/subscriberDailyStats", () => ({
  observeDailySubscriberCount: hoisted.observeDailySubscriberCount,
}));

vi.mock("../utils/redditUtils", () => ({
  getSubredditIcon: hoisted.getSubredditIcon,
}));

vi.mock("../utils/subredditBlacklist", () => ({
  isSubredditBlacklisted: hoisted.isSubredditBlacklisted,
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
    hoisted.reddit.getTopPosts.mockReturnValue({ all: vi.fn() });
    hoisted.reddit.getNewPosts.mockReturnValue({ all: vi.fn() });
    hoisted.getPublicAppSettings.mockReturnValue({ promoSubreddit: "SubGoal" });
    hoisted.getSubredditIcon.mockResolvedValue("/icon.png");
    hoisted.observeDailySubscriberCount.mockResolvedValue({
      growth: { count: 5, period: "today" },
    });
    hoisted.isTrackedSubscriber.mockResolvedValue(false);
    hoisted.setNewSubscriber.mockResolvedValue(true);
    hoisted.reddit.getCurrentUsername.mockResolvedValue("TinyUser");
    hoisted.isSubredditBlacklisted.mockResolvedValue(false);
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
      afterSubscribeAction: {
        type: "link",
        buttonText: "Join the Discord",
        url: "https://discord.com/invite/example",
        colorTheme: "pink",
      },
    });
  });

  it("rejects initialization for a blacklisted subreddit", async () => {
    hoisted.isSubredditBlacklisted.mockResolvedValue(true);
    const routes = createRouteHarness();
    const status = vi.fn();
    const json = vi.fn();
    status.mockReturnValue({ json });

    await routes.get(apiRoutes.init)?.(
      {} as Request,
      { status, json } as unknown as Response,
    );

    expect(hoisted.isSubredditBlacklisted).toHaveBeenCalledWith(
      hoisted.reddit,
      "ExampleSub",
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      status: "error",
      message: "This content is prohibited",
    });
    expect(hoisted.getSubGoalData).not.toHaveBeenCalled();
  });

  it("returns custom header text through init state", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(apiRoutes.init)?.({} as Request, res);

    const response = json.mock.calls[0]?.[0] as InitResponse;
    expect(response.state.headerText).toBe("Custom Header");
    expect(response.state.postHeight).toBe("short");
    expect(response.state.afterSubscribeAction).toEqual({
      type: "link",
      buttonText: "Join the Discord",
      url: "https://discord.com/invite/example",
      colorTheme: "pink",
    });
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
      afterSubscribeAction: {
        type: "link",
        buttonText: "Visit Website",
        url: "https://example.com/",
        colorTheme: "pink",
      },
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
      promoSubreddit: "SubGoal",
      language: "es",
      afterSubscribeAction: {
        type: "link",
        buttonText: "Visit Website",
        url: "https://example.com/",
        colorTheme: "pink",
      },
      subscribed: true,
      authenticated: true,
      subreddit: {
        name: "ExampleSub",
        subscribers: 100,
        growth: { count: 5, period: "today" },
      },
    });
    expect(hoisted.reddit.getCurrentSubreddit).toHaveBeenCalledOnce();
    expect(hoisted.reddit.getCurrentUsername).not.toHaveBeenCalled();
    expect(hoisted.isTrackedSubscriber).toHaveBeenCalledWith(
      hoisted.redis,
      "t2_user",
    );
    expect(hoisted.getSubredditIcon).not.toHaveBeenCalled();
    expect(response.state).not.toHaveProperty("appSettings");
    expect(hoisted.observeDailySubscriberCount).toHaveBeenCalledWith(
      hoisted.redis,
      100,
      { displayedSubscribers: 100 },
    );
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
      promoSubreddit: "SubGoal",
      subscribed: true,
      subreddit: {
        name: "ExampleSub",
        subscribers: 100,
        growth: { count: 5, period: "today" },
      },
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
      promoSubreddit: "SubGoal",
      authenticated: false,
      subscribed: false,
      subreddit: {
        name: "ExampleSub",
        subscribers: 100,
        growth: { count: 5, period: "today" },
      },
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

  it("records and broadcasts Tiny subscriptions through the normal subscriber path", async () => {
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
      promoSubreddit: "SubGoal",
      subscribed: true,
      authenticated: true,
      subreddit: {
        name: "ExampleSub",
        subscribers: 101,
        growth: { count: 5, period: "today" },
      },
    });
    expect(hoisted.reddit.subscribeToCurrentSubreddit).toHaveBeenCalledOnce();
    expect(hoisted.reddit.getCurrentUsername).toHaveBeenCalledOnce();
    expect(hoisted.setNewSubscriber).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_post",
      101,
      { id: "t2_user", username: "TinyUser" },
      true,
    );
    expect(hoisted.reddit.getCurrentSubreddit).toHaveBeenCalledOnce();
    expect(hoisted.observeDailySubscriberCount).toHaveBeenCalledWith(
      hoisted.redis,
      100,
      { displayedSubscribers: 101 },
    );
    expect(hoisted.isTrackedSubscriber).toHaveBeenCalledWith(
      hoisted.redis,
      "t2_user",
    );
    expect(hoisted.checkCompletionStatus).not.toHaveBeenCalled();
    expect(hoisted.realtime.send).toHaveBeenCalledWith("subscriber_updates", {
      type: "sub",
      newSubscriberCount: 101,
      recentSubscriber: "TinyUser",
    });
  });

  it("does not report Tiny success when subscriber history persistence fails", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.setNewSubscriber.mockRejectedValue(new Error("redis unavailable"));
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
    expect(hoisted.setNewSubscriber).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      status: "error",
      message: "Subscription failed: redis unavailable",
    });
    expect(hoisted.realtime.send).not.toHaveBeenCalled();
  });

  it("records NSFW Tiny subscriptions without publicly sharing the username", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      isNsfw: true,
    });
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscribe-only-v1",
      subredditDisplayName: "ExampleSub",
      colorTheme: "red",
      postHeight: "tiny",
      language: "en",
      afterSubscribeAction: { type: "disabled" },
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.subscribe)?.(
      { body: {} } as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.setNewSubscriber).toHaveBeenCalledWith(
      hoisted.redis,
      "t3_post",
      101,
      { id: "t2_user", username: "TinyUser" },
      false,
    );
    expect(hoisted.realtime.send).toHaveBeenCalledWith("subscriber_updates", {
      type: "sub",
      newSubscriberCount: 101,
    });
  });

  it("does not subscribe a Tiny viewer when their username cannot be resolved", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.reddit.getCurrentUsername.mockResolvedValue(null);
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscribe-only-v1",
      subredditDisplayName: "ExampleSub",
      colorTheme: "red",
      postHeight: "tiny",
      language: "en",
      afterSubscribeAction: { type: "disabled" },
    });
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.subscribe)?.(
      { body: {} } as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      status: "error",
      message: "Unable to resolve username.",
    });
    expect(hoisted.reddit.subscribeToCurrentSubreddit).not.toHaveBeenCalled();
    expect(hoisted.setNewSubscriber).not.toHaveBeenCalled();
    expect(hoisted.realtime.send).not.toHaveBeenCalled();
  });

  it("returns the current top-day post as a minimal navigation target", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscriber-goal-v1",
      goal: 200,
      colorTheme: "red",
      postHeight: "regular",
      language: "en",
      afterSubscribeAction: {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "pink",
      },
    });
    const all = vi.fn().mockResolvedValue([
      {
        id: "t3_top",
        title: "Top post",
        url: "https://www.reddit.com/r/ExampleSub/comments/top",
        permalink: "/r/ExampleSub/comments/top",
        authorName: "ignored",
      },
    ]);
    hoisted.reddit.getTopPosts.mockReturnValue({ all });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.reddit.getTopPosts).toHaveBeenCalledWith({
      subredditName: "ExampleSub",
      timeframe: "day",
      limit: 1,
      pageSize: 1,
    });
    expect(hoisted.reddit.getNewPosts).not.toHaveBeenCalled();
    expect(all).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith({
      target: {
        url: "https://www.reddit.com/r/ExampleSub/comments/top",
        permalink: "/r/ExampleSub/comments/top",
      },
    });
  });

  it("falls back from day to week and month until it finds a valid top post", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.getSubGoalData.mockResolvedValue({
      afterSubscribeAction: {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "red",
      },
    });
    hoisted.reddit.getTopPosts
      .mockReturnValueOnce({ all: vi.fn().mockResolvedValue([{ url: " " }]) })
      .mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ url: "not a URL" }]),
      })
      .mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([
          {
            url: "https://www.reddit.com/r/ExampleSub/comments/monthly",
            permalink: "/r/ExampleSub/comments/monthly",
          },
        ]),
      });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    expect(
      hoisted.reddit.getTopPosts.mock.calls.map(
        ([options]) => options.timeframe,
      ),
    ).toEqual(["day", "week", "month"]);
    expect(json).toHaveBeenCalledWith({
      target: {
        url: "https://www.reddit.com/r/ExampleSub/comments/monthly",
        permalink: "/r/ExampleSub/comments/monthly",
      },
    });
  });

  it("returns the most recent available post without trusting an action from the client", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscribe-only-v1",
      goal: 0,
      colorTheme: "red",
      postHeight: "tiny",
      language: "en",
      afterSubscribeAction: {
        type: "newest-post",
        buttonText: "View the Most Recent Post Today",
        colorTheme: "blue",
      },
    });
    const all = vi
      .fn()
      .mockResolvedValue([
        { url: "https://www.reddit.com/r/ExampleSub/comments/newest" },
      ]);
    hoisted.reddit.getNewPosts.mockReturnValue({ all });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.reddit.getNewPosts).toHaveBeenCalledWith({
      subredditName: "ExampleSub",
      limit: 1,
      pageSize: 1,
    });
    expect(json).toHaveBeenCalledWith({
      target: {
        url: "https://www.reddit.com/r/ExampleSub/comments/newest",
      },
    });
  });

  it("returns unavailable when the most recent post has no valid target", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.getSubGoalData.mockResolvedValue({
      afterSubscribeAction: {
        type: "newest-post",
        buttonText: "View the Most Recent Post Today",
        colorTheme: "red",
      },
    });
    hoisted.reddit.getNewPosts.mockReturnValue({
      all: vi.fn().mockResolvedValue([{ url: "not a URL" }]),
    });
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { status } as unknown as Response,
    );

    expect(hoisted.reddit.getNewPosts).toHaveBeenCalledOnce();
    expect(hoisted.reddit.getTopPosts).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(404);
  });

  it("rejects dynamic navigation for unsubscribed viewers", async () => {
    hoisted.context.userId = "t2_user";
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(403);
    expect(hoisted.getSubGoalData).not.toHaveBeenCalled();
    expect(hoisted.reddit.getTopPosts).not.toHaveBeenCalled();
  });

  it("does not query Reddit for a persisted link action", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(hoisted.reddit.getTopPosts).not.toHaveBeenCalled();
    expect(hoisted.reddit.getNewPosts).not.toHaveBeenCalled();
  });

  it("returns unavailable when a dynamic listing is empty", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.getSubGoalData.mockResolvedValue({
      afterSubscribeAction: {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "red",
      },
    });
    hoisted.reddit.getTopPosts.mockReturnValue({
      all: vi.fn().mockResolvedValue([]),
    });
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(
      hoisted.reddit.getTopPosts.mock.calls.map(
        ([options]) => options.timeframe,
      ),
    ).toEqual(["day", "week", "month", "all"]);
    expect(json).toHaveBeenCalledWith({
      status: "error",
      message: "No post is currently available.",
    });
  });

  it("does not hide a top-post API failure behind a broader fallback", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.getSubGoalData.mockResolvedValue({
      afterSubscribeAction: {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "red",
      },
    });
    hoisted.reddit.getTopPosts.mockImplementation(() => {
      throw new Error("listing unavailable");
    });
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(503);
    expect(hoisted.reddit.getTopPosts).toHaveBeenCalledTimes(1);
    expect(hoisted.reddit.getTopPosts).toHaveBeenCalledWith({
      subredditName: "ExampleSub",
      timeframe: "day",
      limit: 1,
      pageSize: 1,
    });
  });

  it("returns a service error when Reddit cannot resolve the target", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.getSubGoalData.mockResolvedValue({
      afterSubscribeAction: {
        type: "newest-post",
        buttonText: "View the Most Recent Post Today",
        colorTheme: "red",
      },
    });
    hoisted.reddit.getNewPosts.mockImplementation(() => {
      throw new Error("listing unavailable");
    });
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      status: "error",
      message: "The post target could not be loaded.",
    });
  });
});
