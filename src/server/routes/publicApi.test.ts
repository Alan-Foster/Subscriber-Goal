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
    getCurrentUser: vi.fn(),
    getCurrentUsername: vi.fn(),
    getModerators: vi.fn(),
    getTopPosts: vi.fn(),
    getNewPosts: vi.fn(),
    subscribeToCurrentSubreddit: vi.fn(),
  },
  redis: {},
  redisValues: new Map<string, string>(),
  realtime: {
    send: vi.fn(),
  },
  getPublicAppSettings: vi.fn(),
  getSubGoalData: vi.fn(),
  getSubredditIcon: vi.fn(),
  observeDailySubscriberCount: vi.fn(),
  getLastKnownSubscriberCount: vi.fn(),
  isTrackedSubscriber: vi.fn(),
  setNewSubscriber: vi.fn(),
  hasSubscriptionAttemptReceipt: vi.fn(),
  storeSubscriptionAttemptReceipt: vi.fn(),
  getSubscriptionAcceptanceEvidence: vi.fn(),
  getSubscriberTrackingGeneration: vi.fn(),
  getPendingSubscriberTracking: vi.fn(),
  persistAcceptedSubscriberTracking: vi.fn(),
  applySubscriberTracking: vi.fn(),
  cleanupSubscriberTracking: vi.fn(),
  checkCompletionStatus: vi.fn(),
  isSubredditBlacklisted: vi.fn(),
  getCtaActivityMetric: vi.fn(),
  isClickActivityPreset: vi.fn(),
  recordCtaClick: vi.fn(),
  getStatisticsReport: vi.fn(),
  recordStatisticsLoad: vi.fn(),
  recordStatisticsJoinClick: vi.fn(),
  recordStatisticsConfirmedJoin: vi.fn(),
  recordStatisticsCtaClick: vi.fn(),
  notifications: {
    isOptedIn: vi.fn(),
    optInCurrentUser: vi.fn(),
    optOutCurrentUser: vi.fn(),
  },
}));

vi.mock("@devvit/web/server", () => ({
  context: hoisted.context,
  reddit: hoisted.reddit,
  redis: hoisted.redis,
  realtime: hoisted.realtime,
}));

vi.mock("@devvit/notifications", () => ({
  notifications: hoisted.notifications,
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

vi.mock("../data/subscriberTracking", () => ({
  getSubscriberTrackingGeneration: hoisted.getSubscriberTrackingGeneration,
  getPendingSubscriberTracking: hoisted.getPendingSubscriberTracking,
  persistAcceptedSubscriberTracking: hoisted.persistAcceptedSubscriberTracking,
  applySubscriberTracking: hoisted.applySubscriberTracking,
  cleanupSubscriberTracking: hoisted.cleanupSubscriberTracking,
}));

vi.mock("../data/subscriptionAttempt", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../data/subscriptionAttempt")>();
  return {
    ...original,
    hasSubscriptionAttemptReceipt: hoisted.hasSubscriptionAttemptReceipt,
    storeSubscriptionAttemptReceipt: hoisted.storeSubscriptionAttemptReceipt,
    getSubscriptionAcceptanceEvidence:
      hoisted.getSubscriptionAcceptanceEvidence,
  };
});

vi.mock("../data/subscriberDailyStats", () => ({
  observeDailySubscriberCount: hoisted.observeDailySubscriberCount,
  getLastKnownSubscriberCount: hoisted.getLastKnownSubscriberCount,
}));

vi.mock("../utils/redditUtils", () => ({
  getSubredditIcon: hoisted.getSubredditIcon,
}));

vi.mock("../utils/subredditBlacklist", () => ({
  isSubredditBlacklisted: hoisted.isSubredditBlacklisted,
}));

vi.mock("../data/ctaActivity", () => ({
  getCtaActivityMetric: hoisted.getCtaActivityMetric,
  isClickActivityPreset: hoisted.isClickActivityPreset,
  recordCtaClick: hoisted.recordCtaClick,
}));

vi.mock("../data/statisticsAnalytics", () => ({
  getStatisticsReport: hoisted.getStatisticsReport,
  recordStatisticsLoad: hoisted.recordStatisticsLoad,
  recordStatisticsJoinClick: hoisted.recordStatisticsJoinClick,
  recordStatisticsConfirmedJoin: hoisted.recordStatisticsConfirmedJoin,
  recordStatisticsCtaClick: hoisted.recordStatisticsCtaClick,
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
  const attemptId = "123e4567-e89b-42d3-a456-426614174000";

  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.context.postId = "t3_post";
    hoisted.context.userId = null;
    hoisted.context.subredditName = "ExampleSub";
    hoisted.context.postData = undefined;
    hoisted.redisValues.clear();
    Object.assign(hoisted.redis, {
      set: vi.fn(
        async (key: string, value: string, options?: { nx?: boolean }) => {
          if (!options?.nx || !hoisted.redisValues.has(key)) {
            hoisted.redisValues.set(key, value);
          }
          return "OK";
        },
      ),
      get: vi.fn(async (key: string) => hoisted.redisValues.get(key)),
    });
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      nsfw: false,
    });
    hoisted.reddit.getTopPosts.mockReturnValue({ all: vi.fn() });
    hoisted.reddit.getNewPosts.mockReturnValue({ all: vi.fn() });
    hoisted.reddit.getModerators.mockReturnValue({
      all: vi.fn().mockResolvedValue([]),
    });
    hoisted.getPublicAppSettings.mockReturnValue({ promoSubreddit: "SubGoal" });
    hoisted.getSubredditIcon.mockResolvedValue("/icon.png");
    hoisted.observeDailySubscriberCount.mockResolvedValue({
      growth: { count: 5, period: "today" },
    });
    hoisted.getLastKnownSubscriberCount.mockResolvedValue(null);
    hoisted.isTrackedSubscriber.mockResolvedValue(false);
    hoisted.setNewSubscriber.mockResolvedValue(true);
    hoisted.hasSubscriptionAttemptReceipt.mockResolvedValue(false);
    hoisted.storeSubscriptionAttemptReceipt.mockResolvedValue(undefined);
    hoisted.getSubscriptionAcceptanceEvidence.mockResolvedValue(undefined);
    hoisted.getSubscriberTrackingGeneration.mockResolvedValue("");
    hoisted.getPendingSubscriberTracking.mockResolvedValue(undefined);
    hoisted.persistAcceptedSubscriberTracking.mockImplementation(
      async (redis: unknown, input: Record<string, unknown>) => ({
        operation: { ...input, phase: "pending", attempts: 0 },
        created: true,
      }),
    );
    hoisted.applySubscriberTracking.mockImplementation(
      async (
        redis: unknown,
        operation: {
          postId: string;
          subscribers: number;
          userId: string;
          username: string;
          shareUsername: boolean;
        },
      ) =>
        (await hoisted.setNewSubscriber(
          redis,
          operation.postId,
          operation.subscribers,
          { id: operation.userId, username: operation.username },
          operation.shareUsername,
        ))
          ? "applied"
          : "obsolete",
    );
    hoisted.cleanupSubscriberTracking.mockResolvedValue(true);
    hoisted.reddit.getCurrentUsername.mockResolvedValue("TinyUser");
    hoisted.reddit.getCurrentUser.mockResolvedValue({
      username: "TinyUser",
      isModerator: false,
    });
    hoisted.isSubredditBlacklisted.mockResolvedValue(false);
    hoisted.getCtaActivityMetric.mockResolvedValue({
      kind: "posts",
      count: 1,
      period: "week",
    });
    hoisted.isClickActivityPreset.mockReturnValue(false);
    hoisted.notifications.isOptedIn.mockResolvedValue(false);
    hoisted.notifications.optInCurrentUser.mockResolvedValue({ success: true });
    hoisted.notifications.optOutCurrentUser.mockResolvedValue({
      success: true,
    });
    hoisted.getStatisticsReport.mockResolvedValue({
      schemaVersion: 1,
      subreddit: { name: "ExampleSub" },
    });
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

  it("recovers missing goals for init, refresh, and subscribe responses", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.context.userId = "t2_user";
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscriber-goal-v1",
      goal: 0,
      recentSubscriber: null,
      completedTime: 0,
      subredditDisplayName: "ExampleSub",
      headerText: null,
      colorTheme: "red",
      postHeight: "regular",
      autoCreateNextGoal: false,
      language: "en",
      afterSubscribeAction: { type: "disabled" },
    });
    const routes = createRouteHarness();
    const initJson = vi.fn();
    const refreshJson = vi.fn();
    const subscribeJson = vi.fn();

    await routes.get(apiRoutes.init)?.(
      {} as Request,
      { json: initJson } as unknown as Response,
    );
    await routes.get(apiRoutes.refresh)?.(
      {} as Request,
      { json: refreshJson } as unknown as Response,
    );
    await routes.get(apiRoutes.subscribe)?.(
      { body: {} } as Request,
      { json: subscribeJson } as unknown as Response,
    );

    expect((initJson.mock.calls[0]?.[0] as InitResponse).state).toMatchObject({
      goal: 150,
      subreddit: { subscribers: 100 },
    });
    expect(
      (refreshJson.mock.calls[0]?.[0] as RefreshResponse).state,
    ).toMatchObject({
      goal: 150,
      subreddit: { subscribers: 100 },
    });
    expect(
      (subscribeJson.mock.calls[0]?.[0] as SubscribeResponse).state,
    ).toMatchObject({
      goal: 150,
      subreddit: { subscribers: 101 },
    });
    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy.mock.calls.map(([line]) => line)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"workflow":"init"'),
        expect.stringContaining('"workflow":"refresh"'),
        expect.stringContaining('"workflow":"subscribe"'),
      ]),
    );
  });

  it("uses a last-known count when the live count is invalid", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: Number.NaN,
      nsfw: false,
    });
    hoisted.getLastKnownSubscriberCount.mockResolvedValue(74);
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscriber-goal-v1",
      goal: 0,
      recentSubscriber: null,
      completedTime: 0,
      subredditDisplayName: "ExampleSub",
      headerText: null,
      colorTheme: "red",
      postHeight: "short",
      autoCreateNextGoal: false,
      language: "en",
      afterSubscribeAction: { type: "disabled" },
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.init)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    expect((json.mock.calls[0]?.[0] as InitResponse).state).toMatchObject({
      goal: 75,
      subreddit: { subscribers: 74 },
    });
  });

  it("preserves completed state while recovering its reached count", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscriber-goal-v1",
      goal: 0,
      recentSubscriber: null,
      completedTime: 1_700_000_000_000,
      subredditDisplayName: "ExampleSub",
      headerText: null,
      colorTheme: "red",
      postHeight: "regular",
      autoCreateNextGoal: false,
      language: "en",
      afterSubscribeAction: { type: "disabled" },
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.init)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    expect((json.mock.calls[0]?.[0] as InitResponse).state).toMatchObject({
      goal: 100,
      completedTime: 1_700_000_000_000,
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
      messageKey: "errors.content.prohibited",
    });
    expect(hoisted.getSubGoalData).toHaveBeenCalledOnce();
  });

  it.each([
    [apiRoutes.init, "Initialization could not be completed."],
    [apiRoutes.refresh, "Refresh could not be completed."],
  ] as const)(
    "returns a safe runtime message from %s",
    async (route, safePrefix) => {
      hoisted.getSubGoalData.mockRejectedValue(
        new Error("redis password and internal host"),
      );
      const routes = createRouteHarness();
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));

      await routes.get(route)?.(
        { query: {} } as Request,
        { status } as unknown as Response,
      );

      expect(status).toHaveBeenCalledWith(503);
      const response = json.mock.calls[0]?.[0] as { message: string };
      expect(response.message).toContain(safePrefix);
      expect(response.message).toContain("Reference:");
      expect(response.message).not.toMatch(/password|internal host|redis/i);
    },
  );

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

  it("marks an authenticated moderator as eligible for the install promotion", async () => {
    hoisted.context.userId = "t2_moderator";
    hoisted.reddit.getCurrentUsername.mockResolvedValue("ExampleModerator");
    hoisted.reddit.getCurrentUser.mockResolvedValue({
      username: "ExampleModerator",
      isModerator: true,
    });
    hoisted.reddit.getModerators.mockReturnValue({
      all: vi.fn().mockResolvedValue([{ username: "ExampleModerator" }]),
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.init)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as InitResponse;
    expect(response.state).toMatchObject({
      moderatorInstallPromoEligible: true,
      user: { id: "t2_moderator", username: "ExampleModerator" },
    });
    expect(hoisted.reddit.getCurrentUser).toHaveBeenCalledOnce();
    expect(hoisted.reddit.getCurrentUsername).not.toHaveBeenCalled();
  });

  it("rejects anonymous direct statistics requests", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.statistics)?.(
      { query: { hours: "24" } } as unknown as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(401);
    expect(hoisted.getStatisticsReport).not.toHaveBeenCalled();
  });

  it("serves only the current subreddit to an authorized moderator", async () => {
    hoisted.context.userId = "t2_moderator";
    hoisted.reddit.getCurrentUser.mockResolvedValue({
      username: "ExampleModerator",
      isModerator: true,
    });
    hoisted.reddit.getModerators.mockReturnValue({
      all: vi.fn().mockResolvedValue([{ username: "ExampleModerator" }]),
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.statistics)?.(
      { query: { hours: "168", subreddit: "OtherSub" } } as unknown as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.getStatisticsReport).toHaveBeenCalledWith(
      hoisted.redis,
      "ExampleSub",
      168,
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ subreddit: { name: "ExampleSub" } }),
    );
  });

  it("rejects an authenticated non-moderator statistics request", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.reddit.getCurrentUser.mockResolvedValue({
      username: "OrdinaryUser",
      isModerator: false,
    });
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.statistics)?.(
      { query: { hours: "24" } } as unknown as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(403);
    expect(hoisted.getStatisticsReport).not.toHaveBeenCalled();
  });

  it("resolves CTA analytics labels from server configuration", async () => {
    hoisted.context.userId = "t2_subscriber";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    const routes = createRouteHarness();
    const json = vi.fn();
    await routes.get(apiRoutes.statisticsEvent)?.(
      {
        body: {
          type: "cta_click",
          eventId: "11111111-1111-4111-8111-111111111111",
          label: "Forged label",
        },
        header: (name: string) =>
          name === "X-SG-Visitor-ID"
            ? "22222222-2222-4222-8222-222222222222"
            : undefined,
      } as unknown as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.recordStatisticsCtaClick).toHaveBeenCalledWith(
      hoisted.redis,
      expect.objectContaining({
        label: "Join the Discord",
        visitorIdentity: "t2_subscriber",
      }),
    );
    expect(json).toHaveBeenCalledWith({ status: "ok" });
  });

  it("rejects Join statistics events for ineligible tracked subscribers", async () => {
    hoisted.context.userId = "t2_subscriber";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.statisticsEvent)?.(
      {
        body: {
          type: "join_click",
          eventId: "11111111-1111-4111-8111-111111111111",
        },
      } as unknown as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(hoisted.recordStatisticsJoinClick).not.toHaveBeenCalled();
  });

  it("rejects secondary CTA statistics events without tracked membership", async () => {
    hoisted.context.userId = "t2_untracked";
    hoisted.isTrackedSubscriber.mockResolvedValue(false);
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.statisticsEvent)?.(
      {
        body: {
          type: "cta_click",
          eventId: "11111111-1111-4111-8111-111111111111",
        },
      } as unknown as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(hoisted.recordStatisticsCtaClick).not.toHaveBeenCalled();
  });

  it("reports init phase durations through Server-Timing", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();
    const setHeader = vi.fn();

    await routes.get(apiRoutes.init)?.(
      {} as Request,
      { json, setHeader } as unknown as Response,
    );

    expect(setHeader).toHaveBeenCalledOnce();
    const [name, value] = setHeader.mock.calls[0] as [string, string];
    expect(name).toBe("Server-Timing");
    expect(value).toMatch(/goal_data;dur=\d+\.\d/);
    expect(value).toMatch(/blacklist;dur=\d+\.\d/);
    expect(value).toMatch(/subreddit;dur=\d+\.\d/);
    expect(value).toMatch(/user;dur=\d+\.\d/);
    expect(value).toMatch(/subscriber_status;dur=\d+\.\d/);
    expect(value).toMatch(/icon;dur=\d+\.\d/);
    expect(value).toMatch(/total;dur=\d+\.\d/);
  });

  it("fails open when moderator promotion eligibility cannot be loaded", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.reddit.getCurrentUser.mockRejectedValue(
      new Error("moderator status unavailable"),
    );
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.init)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as InitResponse;
    expect(response.state).toMatchObject({
      moderatorInstallPromoEligible: false,
      user: { id: "t2_user", username: "TinyUser" },
    });
  });

  it("maps the Devvit nsfw flag to the client-facing isNsfw field", async () => {
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      nsfw: true,
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.init)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as InitResponse;
    expect(response.state.subreddit.isNsfw).toBe(true);
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
      trackCtaClicks: false,
      ctaActivity: { kind: "posts", count: 1, period: "week" },
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

  it("initializes CTA-only posts without subscriber state", async () => {
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "cta-only-v1",
      subredditDisplayName: "ExampleSub",
      colorTheme: "blue",
      postHeight: "cta",
      language: "en",
      afterSubscribeAction: {
        type: "link",
        buttonText: "Create a New Post",
        url: "https://www.reddit.com/r/ExampleSub/submit/",
        colorTheme: "blue",
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
      colorTheme: "blue",
      postHeight: "cta",
      promoSubreddit: "SubGoal",
      language: "en",
      afterSubscribeAction: {
        type: "link",
        buttonText: "Create a New Post",
        url: "https://www.reddit.com/r/ExampleSub/submit/",
        colorTheme: "blue",
      },
      trackCtaClicks: false,
      ctaActivity: { kind: "posts", count: 1, period: "week" },
      subreddit: {
        name: "ExampleSub",
        subscribers: 100,
        growth: { count: 5, period: "today" },
      },
    });
    expect(hoisted.isTrackedSubscriber).not.toHaveBeenCalled();
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

  it("rate-limits private-subreddit permission diagnostics across post IDs", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    hoisted.reddit.getCurrentSubreddit.mockRejectedValue(
      new Error("7 PERMISSION_DENIED: 403 Forbidden: private"),
    );
    const routes = createRouteHarness();
    const firstJson = vi.fn();
    const firstStatus = vi.fn(() => ({ json: firstJson }));

    await routes.get(apiRoutes.refresh)?.(
      { query: {} } as Request,
      { status: firstStatus } as unknown as Response,
    );
    hoisted.context.postId = "t3_another_post";
    const secondJson = vi.fn();
    const secondStatus = vi.fn(() => ({ json: secondJson }));
    await routes.get(apiRoutes.refresh)?.(
      { query: {} } as Request,
      { status: secondStatus } as unknown as Response,
    );

    expect(firstStatus).toHaveBeenCalledWith(503);
    expect(secondStatus).toHaveBeenCalledWith(503);
    expect(firstJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        messageKey: "errors.api.refreshFailed",
      }),
    );
    expect(secondJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        messageKey: "errors.api.refreshFailed",
      }),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns exact-attempt confirmation bound to the current user and post", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.hasSubscriptionAttemptReceipt.mockResolvedValue(true);
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.refresh)?.(
      { query: { attemptId } } as unknown as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.hasSubscriptionAttemptReceipt).toHaveBeenCalledWith(
      hoisted.redis,
      attemptId,
      "t3_post",
      "t2_user",
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionAttemptConfirmed: true }),
    );
  });

  it("does not treat historical tracking as exact-attempt confirmation", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.hasSubscriptionAttemptReceipt.mockResolvedValue(false);
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.refresh)?.(
      { query: { attemptId } } as unknown as Request,
      { json } as unknown as Response,
    );

    const response = json.mock.calls[0]?.[0] as RefreshResponse;
    expect(response.state).toMatchObject({ subscribed: true });
    expect(response.subscriptionAttemptConfirmed).toBe(false);
  });

  it("keeps refresh responses backward-compatible without an attempt ID", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.refresh)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    expect(json.mock.calls[0]?.[0]).not.toHaveProperty(
      "subscriptionAttemptConfirmed",
    );
    expect(hoisted.hasSubscriptionAttemptReceipt).not.toHaveBeenCalled();
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

  it.each([
    { postHeight: "regular", shareUsername: true },
    { postHeight: "regular", shareUsername: false },
    { postHeight: "short", shareUsername: true },
    { postHeight: "short", shareUsername: false },
  ])(
    "honors the SFW $postHeight checkbox (shareUsername=$shareUsername)",
    async ({ postHeight, shareUsername }) => {
      hoisted.context.userId = "t2_user";
      const goalData = await hoisted.getSubGoalData();
      hoisted.getSubGoalData.mockResolvedValue({ ...goalData, postHeight });
      const routes = createRouteHarness();
      const json = vi.fn();
      await routes.get(apiRoutes.subscribe)?.(
        { body: { shareUsername } } as Request,
        { json } as unknown as Response,
      );
      expect(hoisted.persistAcceptedSubscriberTracking).toHaveBeenCalledWith(
        hoisted.redis,
        expect.objectContaining({ shareUsername }),
      );
      expect(hoisted.setNewSubscriber).toHaveBeenCalledWith(
        hoisted.redis,
        "t3_post",
        101,
        { id: "t2_user", username: "TinyUser" },
        shareUsername,
      );
      expect(hoisted.realtime.send).toHaveBeenCalledExactlyOnceWith(
        "subscriber_updates",
        {
          type: "sub",
          newSubscriberCount: 101,
          ...(shareUsername ? { recentSubscriber: "TinyUser" } : {}),
        },
      );
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "subscribe",
          state: expect.objectContaining({
            postHeight,
            recentSubscriber: shareUsername ? "TinyUser" : null,
          }),
        }),
      );
    },
  );

  it.each([true, false])(
    "preserves the stored Tiny sharing decision on replay without a new announcement (stored=%s)",
    async (shareUsername) => {
      hoisted.context.userId = "t2_user";
      const goalData = await hoisted.getSubGoalData();
      hoisted.getSubGoalData.mockResolvedValue({
        ...goalData,
        postKind: "subscribe-only-v1",
        postHeight: "tiny",
        goal: 0,
      });
      const pending = {
        operationId: "historical-tiny-operation",
        userId: "t2_user",
        postId: "t3_post",
        username: "TinyUser",
        subscribers: 101,
        timestamp: Date.now(),
        shareUsername,
        erasureGeneration: "",
        phase: "pending",
        attempts: 0,
      };
      hoisted.getSubscriptionAcceptanceEvidence.mockResolvedValue({
        postId: "t3_post",
        userId: "t2_user",
        acceptedAt: pending.timestamp,
        expiresAt: pending.timestamp + 120_000,
      });
      hoisted.getPendingSubscriberTracking.mockResolvedValue(pending);
      const routes = createRouteHarness();
      const json = vi.fn();
      await routes.get(apiRoutes.subscribe)?.(
        { body: { attemptId, shareUsername: !shareUsername } } as Request,
        { json } as unknown as Response,
      );
      expect(hoisted.applySubscriberTracking).toHaveBeenCalledWith(
        hoisted.redis,
        pending,
      );
      expect(hoisted.setNewSubscriber).toHaveBeenCalledWith(
        hoisted.redis,
        "t3_post",
        101,
        { id: "t2_user", username: "TinyUser" },
        shareUsername,
      );
      expect(hoisted.persistAcceptedSubscriberTracking).not.toHaveBeenCalled();
      expect(hoisted.reddit.subscribeToCurrentSubreddit).not.toHaveBeenCalled();
      expect(hoisted.realtime.send).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "subscribe",
          state: expect.objectContaining({ postHeight: "tiny" }),
        }),
      );
    },
  );

  it.each([
    { nsfw: true, expected: null, scenario: "NSFW" },
    { nsfw: undefined, expected: null, scenario: "unknown safety" },
    { nsfw: false, expected: "EarlierUser", scenario: "confirmed SFW" },
  ])(
    "returns the expected stored subscriber on Init and Refresh for $scenario",
    async ({ nsfw, expected }) => {
      const data = await hoisted.getSubGoalData();
      hoisted.getSubGoalData.mockResolvedValue({
        ...data,
        recentSubscriber: "EarlierUser",
      });
      hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers: 100,
        ...(nsfw === undefined ? {} : { nsfw }),
      });
      const routes = createRouteHarness();

      for (const route of [apiRoutes.init, apiRoutes.refresh]) {
        const json = vi.fn();
        await routes.get(route)!(
          {} as Request,
          { json } as unknown as Response,
        );
        expect(json).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            state: expect.objectContaining({ recentSubscriber: expected }),
          }),
        );
      }
    },
  );

  it.each([true, undefined])(
    "keeps Join responses and realtime updates private when NSFW status is %s",
    async (nsfw) => {
      hoisted.context.userId = "t2_user";
      const data = await hoisted.getSubGoalData();
      hoisted.getSubGoalData.mockResolvedValue({
        ...data,
        postHeight: "regular",
        recentSubscriber: "EarlierUser",
      });
      hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
        id: "t5_example",
        name: "ExampleSub",
        numberOfSubscribers: 100,
        ...(nsfw === undefined ? {} : { nsfw }),
      });
      const routes = createRouteHarness();
      const json = vi.fn();

      await routes.get(apiRoutes.subscribe)?.(
        { body: { shareUsername: true } } as Request,
        { json } as unknown as Response,
      );

      expect(hoisted.setNewSubscriber).toHaveBeenCalledWith(
        hoisted.redis,
        "t3_post",
        101,
        { id: "t2_user", username: "TinyUser" },
        false,
      );
      expect(json).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: "subscribe",
          state: expect.objectContaining({ recentSubscriber: null }),
        }),
      );
      expect(hoisted.realtime.send).toHaveBeenCalledExactlyOnceWith(
        "subscriber_updates",
        {
          type: "sub",
          newSubscriberCount: 101,
        },
      );
    },
  );

  it("keeps SFW Tiny usernames private while tracking, confirming, and broadcasting counts", async () => {
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
      { body: { shareUsername: true, attemptId } } as Request,
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
      false,
    );
    expect(hoisted.persistAcceptedSubscriberTracking).toHaveBeenCalledWith(
      hoisted.redis,
      expect.objectContaining({ shareUsername: false, attemptId }),
    );
    expect(hoisted.storeSubscriptionAttemptReceipt).toHaveBeenCalledWith(
      hoisted.redis,
      attemptId,
      "t3_post",
      "t2_user",
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
    });
  });

  it("stores an exact-attempt receipt immediately after Reddit succeeds", async () => {
    hoisted.context.userId = "t2_user";
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.subscribe)?.(
      { body: { attemptId } } as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.storeSubscriptionAttemptReceipt).toHaveBeenCalledWith(
      hoisted.redis,
      attemptId,
      "t3_post",
      "t2_user",
    );
    expect(
      hoisted.reddit.subscribeToCurrentSubreddit.mock.invocationCallOrder[0],
    ).toBeLessThan(
      hoisted.storeSubscriptionAttemptReceipt.mock.invocationCallOrder[0]!,
    );
    expect(
      hoisted.storeSubscriptionAttemptReceipt.mock.invocationCallOrder[0],
    ).toBeLessThan(hoisted.setNewSubscriber.mock.invocationCallOrder[0]!);
  });

  it("returns a safe failure when an exact-attempt receipt cannot be stored", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.storeSubscriptionAttemptReceipt.mockRejectedValue(
      new Error("redis unavailable"),
    );
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.subscribe)?.(
      { body: { attemptId } } as Request,
      { status } as unknown as Response,
    );

    expect(hoisted.reddit.subscribeToCurrentSubreddit).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith(503);
    expect(hoisted.setNewSubscriber).not.toHaveBeenCalled();
  });

  it("surfaces ambiguity when Reddit accepts but durable tracking cannot be saved", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.persistAcceptedSubscriberTracking.mockRejectedValue(
      new Error("redis unavailable"),
    );
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.subscribe)?.(
      { body: { attemptId } } as Request,
      { status } as unknown as Response,
    );

    expect(hoisted.reddit.subscribeToCurrentSubreddit).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/^Reddit may have accepted the join/),
      }),
    );
    expect(hoisted.storeSubscriptionAttemptReceipt).not.toHaveBeenCalled();
    expect(hoisted.recordStatisticsConfirmedJoin).not.toHaveBeenCalled();
    expect(hoisted.setNewSubscriber).not.toHaveBeenCalled();
  });

  it("replays durable acceptance after a receipt write fails without rejoining", async () => {
    hoisted.context.userId = "t2_user";
    const pending = {
      operationId: "op-winner",
      userId: "t2_user",
      postId: "t3_post",
      username: "TinyUser",
      subscribers: 101,
      timestamp: Date.now(),
      shareUsername: true,
      erasureGeneration: "",
      phase: "pending" as const,
      attempts: 0,
    };
    hoisted.persistAcceptedSubscriberTracking.mockResolvedValue({
      operation: pending,
      created: true,
    });
    hoisted.storeSubscriptionAttemptReceipt.mockRejectedValueOnce(
      new Error("receipt unavailable"),
    );
    const routes = createRouteHarness();
    const firstJson = vi.fn();
    const firstStatus = vi.fn(() => ({ json: firstJson }));
    await routes.get(apiRoutes.subscribe)?.(
      { body: { attemptId } } as Request,
      { status: firstStatus } as unknown as Response,
    );

    hoisted.storeSubscriptionAttemptReceipt.mockResolvedValue(undefined);
    hoisted.getSubscriptionAcceptanceEvidence.mockResolvedValue({
      postId: "t3_post",
      userId: "t2_user",
      acceptedAt: pending.timestamp,
      expiresAt: pending.timestamp + 120_000,
    });
    hoisted.getPendingSubscriberTracking.mockResolvedValue(pending);
    const secondJson = vi.fn();
    await routes.get(apiRoutes.subscribe)?.(
      { body: { attemptId } } as Request,
      { json: secondJson } as unknown as Response,
    );

    expect(hoisted.reddit.subscribeToCurrentSubreddit).toHaveBeenCalledOnce();
    expect(hoisted.recordStatisticsConfirmedJoin).toHaveBeenCalledOnce();
    expect(hoisted.setNewSubscriber).toHaveBeenCalledOnce();
    expect(secondJson).toHaveBeenCalledWith(
      expect.objectContaining({ type: "subscribe", postId: "t3_post" }),
    );
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
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: expect.stringMatching(
          /^Could not join the community\. Reference: subscribe-/,
        ),
      }),
    );
    expect(hoisted.realtime.send).not.toHaveBeenCalled();
  });

  it("returns JSON service unavailable when Reddit subscription fails", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.reddit.subscribeToCurrentSubreddit.mockRejectedValue(
      new Error("reddit unavailable"),
    );
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.subscribe)?.(
      { body: {} } as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: expect.stringMatching(
          /^Could not join the community\. Reference: subscribe-/,
        ),
      }),
    );
    expect(hoisted.setNewSubscriber).not.toHaveBeenCalled();
    expect(hoisted.realtime.send).not.toHaveBeenCalled();
  });

  it("does not duplicate Tiny tracking or realtime for an existing subscriber", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.setNewSubscriber.mockResolvedValue(false);
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

    const response = json.mock.calls[0]?.[0] as SubscribeResponse;
    expect(response.state).toMatchObject({
      subscribed: true,
      subreddit: { subscribers: 100 },
    });
    expect(hoisted.reddit.subscribeToCurrentSubreddit).toHaveBeenCalledOnce();
    expect(hoisted.setNewSubscriber).toHaveBeenCalledOnce();
    expect(hoisted.realtime.send).not.toHaveBeenCalled();
    expect(hoisted.checkCompletionStatus).not.toHaveBeenCalled();
  });

  it("keeps Tiny subscription success when realtime publication fails", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.realtime.send.mockRejectedValue(new Error("realtime unavailable"));
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

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "subscribe",
        state: expect.objectContaining({ subscribed: true }),
      }),
    );
  });

  it("keeps regular subscription success when completion checking fails", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.checkCompletionStatus.mockRejectedValue(
      new Error("completion unavailable"),
    );
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "subscriber-goal-v1",
      goal: 101,
      recentSubscriber: null,
      completedTime: 0,
      subredditDisplayName: "ExampleSub",
      headerText: null,
      colorTheme: "red",
      postHeight: "regular",
      language: "en",
      afterSubscribeAction: { type: "disabled" },
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.subscribe)?.(
      { body: { shareUsername: true } } as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.checkCompletionStatus).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "subscribe",
        state: expect.objectContaining({
          subscribed: true,
          subreddit: expect.objectContaining({ subscribers: 101 }),
        }),
      }),
    );
  });

  it("records NSFW Tiny subscriptions without publicly sharing the username", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      nsfw: true,
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

  it("does not share a Tiny subscriber username when safety metadata is missing", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
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
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "Unable to resolve username.",
      }),
    );
    expect(hoisted.reddit.subscribeToCurrentSubreddit).not.toHaveBeenCalled();
    expect(hoisted.setNewSubscriber).not.toHaveBeenCalled();
    expect(hoisted.realtime.send).not.toHaveBeenCalled();
  });

  function seedAutomaticCard(
    type: "top-post-day" | "newest-post" | "link" = "top-post-day",
  ) {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    const data = {
      postKind: "subscriber-goal-v1",
      postHeight: "regular",
      completedTime: 0,
      goal: 200,
      colorTheme: "red",
      language: "en",
      afterSubscribeAction: {
        type,
        buttonText: "A custom configured label",
        colorTheme: "blue",
        ...(type === "link" ? { url: "https://example.com/" } : {}),
      },
    };
    hoisted.getSubGoalData.mockResolvedValue(data);
    return data;
  }
  async function requestAction(query?: Record<string, unknown>) {
    const json = vi.fn();
    const res = { json, status: vi.fn(() => res) };
    await createRouteHarness().get(apiRoutes.afterSubscribeTarget)?.(
      { query } as Request,
      res as unknown as Response,
    );
    return res;
  }

  it.each(["top-post-day", "newest-post", "link"] as const)(
    "resolves only the automatic partner of configured %s",
    async (type) => {
      seedAutomaticCard(type);
      const target = {
        id: "t3_target",
        authorName: "CommunityMember",
        url: "https://www.reddit.com/r/ExampleSub/comments/target",
      };
      hoisted.reddit.getTopPosts.mockReturnValue({
        all: vi.fn(async () => [target]),
      });
      hoisted.reddit.getNewPosts.mockReturnValue({
        all: vi.fn(async () => [target]),
      });
      const selector = type === "top-post-day" ? "newest-post" : "top-post-day";
      const res = await requestAction({
        automaticAction: selector,
        type: "link",
        url: "https://forged.example/",
      });
      expect(res.json).toHaveBeenCalledWith({ target: { url: target.url } });
      expect(hoisted.reddit.getTopPosts).toHaveBeenCalledTimes(
        selector === "top-post-day" ? 1 : 0,
      );
      expect(hoisted.reddit.getNewPosts).toHaveBeenCalledTimes(
        selector === "newest-post" ? 1 : 0,
      );
      expect(hoisted.recordCtaClick).not.toHaveBeenCalled();
      expect(hoisted.recordStatisticsCtaClick).not.toHaveBeenCalled();
    },
  );

  it.each([
    "link",
    "disabled",
    "",
    "top-post-day",
    ["newest-post", "newest-post"],
    ["newest-post"],
    { type: "newest-post" },
    42,
    null,
    undefined,
  ])(
    "rejects unsupported, mismatched or malformed automatic selector %j",
    async (selector) => {
      seedAutomaticCard();
      const res = await requestAction({ automaticAction: selector });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(hoisted.reddit.getTopPosts).not.toHaveBeenCalled();
      expect(hoisted.reddit.getNewPosts).not.toHaveBeenCalled();
    },
  );

  it.each([
    "logged out",
    "untracked",
    "CTA-only",
    "Tiny",
    "completed",
    "blacklisted",
    "NSFW",
    "disabled",
  ])(
    "rejects automatic actions for %s before any listing lookup",
    async (reason) => {
      const data = seedAutomaticCard();
      if (reason === "logged out") hoisted.context.userId = null;
      if (reason === "untracked")
        hoisted.isTrackedSubscriber.mockResolvedValue(false);
      if (reason === "CTA-only") {
        data.postKind = "cta-only-v1";
        data.postHeight = "cta";
      }
      if (reason === "Tiny") {
        data.postKind = "subscribe-only-v1";
        data.postHeight = "tiny";
      }
      if (reason === "completed") data.completedTime = 1_000;
      if (reason === "disabled")
        hoisted.getSubGoalData.mockResolvedValue({
          ...data,
          afterSubscribeAction: { type: "disabled" },
        });
      if (reason === "blacklisted")
        hoisted.isSubredditBlacklisted.mockResolvedValue(true);
      if (reason === "NSFW")
        hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
          name: "ExampleSub",
          nsfw: true,
        });
      const res = await requestAction({ automaticAction: "newest-post" });
      expect(res.status).toHaveBeenCalledWith(
        reason === "disabled" ? 400 : 403,
      );
      expect(hoisted.reddit.getTopPosts).not.toHaveBeenCalled();
      expect(hoisted.reddit.getNewPosts).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalledWith(
        expect.objectContaining({ target: expect.anything() }),
      );
    },
  );

  it.each(["automaticAction[]", "automaticAction[type]"])(
    "rejects malformed selector key %s before fetching listings",
    async (key) => {
      seedAutomaticCard();
      const res = await requestAction({ [key]: "newest-post" });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(hoisted.reddit.getTopPosts).not.toHaveBeenCalled();
      expect(hoisted.reddit.getNewPosts).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "unknown"])(
    "permits automatic actions when community safety metadata is %j",
    async (nsfw) => {
      seedAutomaticCard();
      hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
        name: "ExampleSub",
        nsfw,
      });
      hoisted.reddit.getNewPosts.mockReturnValue({
        all: vi.fn(async () => [
          {
            id: "t3_recent",
            url: "https://reddit.com/r/ExampleSub/comments/recent",
          },
        ]),
      });
      const res = await requestAction({ automaticAction: "newest-post" });
      expect(res.json).toHaveBeenCalledWith({
        target: { url: "https://reddit.com/r/ExampleSub/comments/recent" },
      });
    },
  );

  it.each([false, true])(
    "filters app authors from configured and automatic Most Recent, except in promo (promo=%s)",
    async (promo) => {
      for (const automatic of [false, true]) {
        seedAutomaticCard(automatic ? "top-post-day" : "newest-post");
        hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
          name: promo ? "SubGoal" : "ExampleSub",
          nsfw: false,
        });
        hoisted.reddit.getNewPosts.mockReturnValue({
          all: vi.fn(async () => [
            {
              id: "t3_post",
              authorName: "CommunityMember",
              url: "https://reddit.com/current",
            },
            {
              id: "t3_app",
              authorName: "u/Subscriber-Goal",
              url: "https://reddit.com/app",
            },
            {
              id: "t3_user",
              authorName: "CommunityMember",
              url: "https://reddit.com/user",
            },
          ]),
        });
        const res = await requestAction(
          automatic ? { automaticAction: "newest-post" } : undefined,
        );
        expect(res.json).toHaveBeenCalledWith({
          target: {
            url: promo ? "https://reddit.com/app" : "https://reddit.com/user",
          },
        });
      }
      expect(hoisted.reddit.getTopPosts).not.toHaveBeenCalled();
    },
  );

  it("does not prefetch either dynamic target while loading a subscribed active card", async () => {
    seedAutomaticCard();
    const json = vi.fn();
    const res = { json, setHeader: vi.fn() };
    await createRouteHarness().get(apiRoutes.init)?.(
      { headers: {} } as Request,
      res as unknown as Response,
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ subscribed: true }),
      }),
    );
    expect(hoisted.reddit.getTopPosts).not.toHaveBeenCalled();
    expect(hoisted.reddit.getNewPosts).not.toHaveBeenCalled();
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
      limit: 25,
      pageSize: 25,
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

  it("falls back through broader timeframes until it finds an eligible top post", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.context.postId = "t3_current";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.getSubGoalData.mockResolvedValue({
      afterSubscribeAction: {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "red",
      },
    });
    hoisted.reddit.getTopPosts
      .mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([
          {
            id: "t3_current",
            authorName: "CommunityMember",
            url: "https://www.reddit.com/r/ExampleSub/comments/current",
          },
          {
            id: "t3_app",
            authorName: "subscriber-goal",
            url: "https://www.reddit.com/r/ExampleSub/comments/app",
          },
          {
            id: "t3_invalid",
            authorName: "CommunityMember",
            url: "not a URL",
          },
        ]),
      })
      .mockReturnValueOnce({ all: vi.fn().mockResolvedValue([]) })
      .mockReturnValueOnce({ all: vi.fn().mockResolvedValue([]) })
      .mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([
          {
            id: "t3_all_time",
            authorName: "CommunityMember",
            url: "https://www.reddit.com/r/ExampleSub/comments/all_time",
            permalink: "/r/ExampleSub/comments/all_time",
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
    ).toEqual(["day", "week", "month", "all"]);
    expect(json).toHaveBeenCalledWith({
      target: {
        url: "https://www.reddit.com/r/ExampleSub/comments/all_time",
        permalink: "/r/ExampleSub/comments/all_time",
      },
    });
  });

  it("allows app-authored crossposts in the promo subreddit and skips the current post", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.context.postId = "t3_current";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_subgoal",
      name: "sUbGoAl",
      numberOfSubscribers: 100,
      nsfw: false,
    });
    hoisted.getSubGoalData.mockResolvedValue({
      afterSubscribeAction: {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "red",
      },
    });
    hoisted.reddit.getTopPosts.mockReturnValue({
      all: vi.fn().mockResolvedValue([
        {
          id: "t3_current",
          authorName: "subscriber-goal",
          url: "https://www.reddit.com/r/SubGoal/comments/current",
          permalink: "/r/SubGoal/comments/current",
        },
        {
          id: "t3_crosspost",
          authorName: "/u/SUBSCRIBER-GOAL",
          crosspostParentId: "t3_source",
          url: "/r/SourceSub/comments/source",
          permalink: "/r/SubGoal/comments/crosspost",
        },
      ]),
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.reddit.getTopPosts).toHaveBeenCalledWith({
      subredditName: "sUbGoAl",
      timeframe: "day",
      limit: 25,
      pageSize: 25,
    });
    expect(hoisted.reddit.getTopPosts).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({
      target: {
        url: "https://www.reddit.com/r/SubGoal/comments/crosspost",
        permalink: "/r/SubGoal/comments/crosspost",
      },
    });
  });

  it("skips app-authored posts outside the promo subreddit", async () => {
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
      all: vi.fn().mockResolvedValue([
        {
          id: "t3_app_post",
          authorName: "Subscriber-Goal",
          url: "https://www.reddit.com/r/ExampleSub/comments/app",
          permalink: "/r/ExampleSub/comments/app",
        },
        {
          id: "t3_malformed",
          authorName: "AnotherMember",
          url: "not a URL",
          permalink: "https://example.com/not-a-reddit-post",
        },
        {
          id: "t3_other_post",
          authorName: "CommunityMember",
          url: "https://i.redd.it/image.png",
          permalink: "/r/ExampleSub/comments/other",
        },
      ]),
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    expect(hoisted.reddit.getTopPosts).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({
      target: {
        url: "https://www.reddit.com/r/ExampleSub/comments/other",
        permalink: "/r/ExampleSub/comments/other",
      },
    });
  });

  it("returns the most recent eligible post regardless of age without trusting a client action", async () => {
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
    const all = vi.fn().mockResolvedValue([
      {
        id: "t3_post",
        createdAt: new Date("2026-09-08T12:00:00.000Z"),
        url: "https://www.reddit.com/r/ExampleSub/comments/current",
      },
      {
        id: "t3_invalid",
        createdAt: new Date("2026-09-08T11:00:00.000Z"),
        url: "not a URL",
      },
      {
        id: "t3_old",
        createdAt: new Date("2026-09-07T23:59:59.999Z"),
        url: "https://www.reddit.com/r/ExampleSub/comments/old",
      },
      {
        id: "t3_newest",
        createdAt: new Date("2026-09-08T10:00:00.000Z"),
        url: "https://www.reddit.com/r/ExampleSub/comments/newest",
      },
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
      limit: 25,
      pageSize: 25,
    });
    expect(json).toHaveBeenCalledWith({
      target: {
        url: "https://www.reddit.com/r/ExampleSub/comments/old",
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
      all: vi.fn().mockResolvedValue([
        {
          id: "t3_invalid",
          createdAt: new Date("2026-09-08T10:00:00.000Z"),
          url: "not a URL",
        },
        {
          id: "t3_post",
          createdAt: new Date("2026-09-07T23:59:59.999Z"),
          url: "https://www.reddit.com/r/ExampleSub/comments/current",
        },
      ]),
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
    expect(hoisted.getSubGoalData).toHaveBeenCalledOnce();
    expect(hoisted.reddit.getTopPosts).not.toHaveBeenCalled();
  });

  it("allows anonymous CTA-only posts to resolve a dynamic target", async () => {
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "cta-only-v1",
      afterSubscribeAction: {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "blue",
      },
    });
    hoisted.reddit.getTopPosts.mockReturnValue({
      all: vi.fn().mockResolvedValue([
        {
          id: "t3_target",
          authorName: "member",
          url: "https://www.reddit.com/r/ExampleSub/comments/target",
          permalink: "/r/ExampleSub/comments/target",
        },
      ]),
    });
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { status, json } as unknown as Response,
    );

    expect(status).not.toHaveBeenCalledWith(403);
    expect(hoisted.isTrackedSubscriber).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({
      target: {
        url: "https://www.reddit.com/r/ExampleSub/comments/target",
        permalink: "/r/ExampleSub/comments/target",
      },
    });
  });

  it("rejects subscription attempts for CTA-only posts before authentication", async () => {
    hoisted.getSubGoalData.mockResolvedValue({ postKind: "cta-only-v1" });
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.subscribe)?.(
      { body: {} } as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "This post does not support joining.",
      }),
    );
    expect(hoisted.reddit.subscribeToCurrentSubreddit).not.toHaveBeenCalled();
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

  it("returns unavailable when every timeframe contains only excluded candidates", async () => {
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
      all: vi.fn().mockResolvedValue(
        Array.from({ length: 25 }, (_, index) => ({
          id: `t3_app_${index}`,
          authorName: "subscriber-goal",
          url: `https://www.reddit.com/r/ExampleSub/comments/app_${index}`,
          permalink: `/r/ExampleSub/comments/app_${index}`,
        })),
      ),
    });
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(hoisted.reddit.getTopPosts).toHaveBeenCalledTimes(4);
    expect(
      hoisted.reddit.getTopPosts.mock.calls.map(
        ([options]) => options.timeframe,
      ),
    ).toEqual(["day", "week", "month", "all"]);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "No post is currently available.",
      }),
    );
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
      limit: 25,
      pageSize: 25,
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
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "The post target could not be loaded.",
      }),
    );
  });

  it("returns Create Post without loading dynamic listings in NSFW communities", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.isTrackedSubscriber.mockResolvedValue(true);
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      nsfw: true,
    });
    hoisted.getSubGoalData.mockResolvedValue({
      afterSubscribeAction: {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "blue",
      },
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(apiRoutes.afterSubscribeTarget)?.(
      {} as Request,
      { json } as unknown as Response,
    );

    expect(json).toHaveBeenCalledWith({
      target: { url: "https://www.reddit.com/r/ExampleSub/submit/" },
    });
    expect(hoisted.reddit.getTopPosts).not.toHaveBeenCalled();
    expect(hoisted.reddit.getNewPosts).not.toHaveBeenCalled();
  });

  it.each(["subscriber-goal-v1", "subscribe-only-v1"])(
    "requires a tracked subscriber for %s public activity",
    async (postKind) => {
      hoisted.getSubGoalData.mockResolvedValue({
        postKind,
        afterSubscribePreset: "discord",
        afterSubscribeAction: { type: "link" },
      });
      hoisted.isClickActivityPreset.mockReturnValue(true);
      const routes = createRouteHarness();
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      const request = {
        header: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        body: { userId: "t2_forged", postId: "t3_forged" },
      } as unknown as Request;
      for (const userId of [null, "t2_untracked"]) {
        hoisted.context.userId = userId;
        await routes.get(apiRoutes.ctaClick)?.(request, {
          json,
          status,
        } as unknown as Response);
        expect(status).toHaveBeenLastCalledWith(400);
      }
      expect(hoisted.recordCtaClick).not.toHaveBeenCalled();
      hoisted.context.userId = "t2_tracked";
      hoisted.isTrackedSubscriber.mockResolvedValue(true);
      await routes.get(apiRoutes.ctaClick)?.(request, {
        json,
        status,
      } as unknown as Response);
      expect(hoisted.isTrackedSubscriber).toHaveBeenLastCalledWith(
        hoisted.redis,
        "t2_tracked",
      );
      expect(hoisted.recordCtaClick).toHaveBeenCalledExactlyOnceWith(
        hoisted.redis,
        "t3_post",
        "user:t2_tracked",
      );
      expect(json).toHaveBeenLastCalledWith({ status: "ok" });
    },
  );

  it.each([
    {
      visitor: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      identity: "visitor:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
    { visitor: undefined, identity: undefined },
    { visitor: "invalid", identity: undefined },
    { visitor: "t2_forged", identity: undefined },
  ])(
    "allows anonymous CTA-only navigation and records only usable visitor identity ($visitor)",
    async ({ visitor, identity }) => {
      hoisted.getSubGoalData.mockResolvedValue({
        postKind: "cta-only-v1",
        afterSubscribePreset: "discord",
        afterSubscribeAction: { type: "link" },
      });
      hoisted.isClickActivityPreset.mockReturnValue(true);
      const routes = createRouteHarness();
      const json = vi.fn();
      await routes.get(apiRoutes.ctaClick)?.(
        { header: () => visitor } as unknown as Request,
        { json } as unknown as Response,
      );
      if (identity)
        expect(hoisted.recordCtaClick).toHaveBeenCalledExactlyOnceWith(
          hoisted.redis,
          "t3_post",
          identity,
        );
      else expect(hoisted.recordCtaClick).not.toHaveBeenCalled();
      expect(hoisted.isTrackedSubscriber).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith({ status: "ok" });
    },
  );

  it("uses the trusted signed-in identity on CTA-only posts even if the visitor header changes", async () => {
    hoisted.getSubGoalData.mockResolvedValue({
      postKind: "cta-only-v1",
      afterSubscribePreset: "wiki",
      afterSubscribeAction: { type: "link" },
    });
    hoisted.isClickActivityPreset.mockReturnValue(true);
    hoisted.context.userId = "t2_viewer";
    const routes = createRouteHarness();
    const json = vi.fn();
    for (const visitor of [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]) {
      await routes.get(apiRoutes.ctaClick)?.(
        { header: () => visitor } as unknown as Request,
        { json } as unknown as Response,
      );
    }
    expect(hoisted.recordCtaClick).toHaveBeenCalledTimes(2);
    expect(
      hoisted.recordCtaClick.mock.calls.every(
        (call) => call[2] === "user:t2_viewer",
      ),
    ).toBe(true);
    expect(hoisted.isTrackedSubscriber).not.toHaveBeenCalled();
  });

  it("rejects click recording for post-activity CTAs", async () => {
    hoisted.getSubGoalData.mockResolvedValue({
      afterSubscribePreset: "create-post",
      afterSubscribeAction: {
        type: "link",
        buttonText: "Create a New Post",
        url: "https://www.reddit.com/r/ExampleSub/submit/",
        colorTheme: "blue",
      },
    });
    const routes = createRouteHarness();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    await routes.get(apiRoutes.ctaClick)?.(
      {} as Request,
      { status } as unknown as Response,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(hoisted.recordCtaClick).not.toHaveBeenCalled();
  });
});

describe("notification settings routes", () => {
  const createHarness = () => {
    let getHandler: RouteHandler | undefined;
    let postHandler: RouteHandler | undefined;
    const router = {
      get: (path: string, handler: RouteHandler) => {
        if (path === apiRoutes.notificationSettings) getHandler = handler;
      },
      post: (path: string, handler: RouteHandler) => {
        if (path === apiRoutes.notificationSettings) postHandler = handler;
      },
    } as unknown as Router;
    registerPublicApiRoutes(router);
    return { getHandler, postHandler };
  };

  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.context.userId = null;
    hoisted.notifications.isOptedIn.mockResolvedValue(false);
    hoisted.notifications.optInCurrentUser.mockResolvedValue({ success: true });
    hoisted.notifications.optOutCurrentUser.mockResolvedValue({
      success: true,
    });
  });

  it("returns a disabled signed-out state without calling Devvit", async () => {
    const { getHandler } = createHarness();
    const json = vi.fn();
    await getHandler?.({} as Request, { json } as unknown as Response);
    expect(json).toHaveBeenCalledWith({
      type: "notification-settings",
      authenticated: false,
      enabled: false,
    });
    expect(hoisted.notifications.isOptedIn).not.toHaveBeenCalled();
  });

  it("reads the current Devvit opt-in state", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.notifications.isOptedIn.mockResolvedValue(true);
    const { getHandler } = createHarness();
    const json = vi.fn();
    await getHandler?.({} as Request, { json } as unknown as Response);
    expect(hoisted.notifications.isOptedIn).toHaveBeenCalledWith("t2_user");
    expect(json).toHaveBeenCalledWith({
      type: "notification-settings",
      authenticated: true,
      enabled: true,
    });
  });

  it("opts in and confirms the authoritative state", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.notifications.isOptedIn
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { postHandler } = createHarness();
    const json = vi.fn();
    await postHandler?.(
      { body: { enabled: true } } as Request,
      { json } as unknown as Response,
    );
    expect(hoisted.notifications.optInCurrentUser).toHaveBeenCalledOnce();
    expect(hoisted.notifications.optOutCurrentUser).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({
      type: "notification-settings",
      authenticated: true,
      enabled: true,
    });
  });

  it("does not repeat an already-satisfied mutation", async () => {
    hoisted.context.userId = "t2_user";
    hoisted.notifications.isOptedIn.mockResolvedValue(true);
    const { postHandler } = createHarness();
    await postHandler?.(
      { body: { enabled: true } } as Request,
      { json: vi.fn() } as unknown as Response,
    );
    expect(hoisted.notifications.optInCurrentUser).not.toHaveBeenCalled();
    expect(hoisted.notifications.optOutCurrentUser).not.toHaveBeenCalled();
  });

  it("rejects logged-out and malformed mutations", async () => {
    const { postHandler } = createHarness();
    const loggedOutJson = vi.fn();
    const loggedOutStatus = vi.fn(() => ({ json: loggedOutJson }));
    await postHandler?.(
      { body: { enabled: true } } as Request,
      { status: loggedOutStatus } as unknown as Response,
    );
    expect(loggedOutStatus).toHaveBeenCalledWith(401);

    hoisted.context.userId = "t2_user";
    const invalidJson = vi.fn();
    const invalidStatus = vi.fn(() => ({ json: invalidJson }));
    await postHandler?.(
      { body: { enabled: "yes" } } as unknown as Request,
      { status: invalidStatus } as unknown as Response,
    );
    expect(invalidStatus).toHaveBeenCalledWith(400);
  });
});
