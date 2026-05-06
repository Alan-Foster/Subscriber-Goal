import type { Request, Response, Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internalRoutes } from "../../shared/routes";

const hoisted = vi.hoisted(() => ({
  context: {
    subredditName: "ExampleSub",
    userId: "t2_mod",
  },
  reddit: {
    getCurrentSubreddit: vi.fn(),
    getAppUser: vi.fn(),
    getPostById: vi.fn(),
  },
  redis: {},
  getAppSettings: vi.fn(),
  getSavedSubredditDisplayName: vi.fn(),
  setSavedSubredditDisplayName: vi.fn(),
  createGoalPost: vi.fn(),
  registerNewSubGoalPost: vi.fn(),
  setSubredditDisplayNameForPost: vi.fn(),
  cancelAllAutoCreateNextGoals: vi.fn(),
  getTrackedPosts: vi.fn(),
  getQueuedUpdates: vi.fn(),
  queueUpdate: vi.fn(),
  clearUserStickies: vi.fn(),
  applyTextFallback: vi.fn(),
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
  createGoalPost: hoisted.createGoalPost,
}));

vi.mock("../data/subGoalData", () => ({
  cancelAllAutoCreateNextGoals: hoisted.cancelAllAutoCreateNextGoals,
  eraseFromRecentSubscribers: vi.fn(),
  registerNewSubGoalPost: hoisted.registerNewSubGoalPost,
  setSubredditDisplayNameForPost: hoisted.setSubredditDisplayNameForPost,
}));

vi.mock("../data/subredditDisplayNameData", () => ({
  getSavedSubredditDisplayName: hoisted.getSavedSubredditDisplayName,
  setSavedSubredditDisplayName: hoisted.setSavedSubredditDisplayName,
}));

vi.mock("../data/subscriberStats", () => ({
  untrackSubscriberById: vi.fn(),
  untrackSubscriberByUsername: vi.fn(),
}));

vi.mock("../data/updaterData", () => ({
  cancelUpdates: vi.fn(),
  getQueuedUpdates: hoisted.getQueuedUpdates,
  getTrackedPosts: hoisted.getTrackedPosts,
  queueUpdate: hoisted.queueUpdate,
  untrackPost: vi.fn(),
}));

vi.mock("../utils/redditUtils", () => ({
  clearUserStickies: hoisted.clearUserStickies,
}));

vi.mock("../utils/textFallback", () => ({
  applyTextFallback: hoisted.applyTextFallback,
}));

import { registerInternalUiRoutes } from "./internalUi";

type RouteHandler = (req: Request, res: Response) => void | Promise<void>;

function createRouteHarness(): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>();
  const router = {
    post: (path: string, handler: RouteHandler) => {
      routes.set(path, handler);
    },
  } as unknown as Router;
  registerInternalUiRoutes(router);
  return routes;
}

describe("internalUi color theme create goal routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      isNsfw: false,
    });
    hoisted.reddit.getAppUser.mockResolvedValue({
      username: "subscriber-goal",
    });
    hoisted.getAppSettings.mockReturnValue({ promoSubreddit: "SubGoal" });
    hoisted.getSavedSubredditDisplayName.mockResolvedValue(undefined);
    hoisted.createGoalPost.mockResolvedValue({
      id: "t3_newpost",
      subredditName: "ExampleSub",
      subredditId: "t5_example",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      approve: vi.fn(),
      sticky: vi.fn(),
    });
    hoisted.registerNewSubGoalPost.mockResolvedValue({ status: "skipped" });
    hoisted.getTrackedPosts.mockResolvedValue([]);
    hoisted.getQueuedUpdates.mockResolvedValue([]);
  });

  it("adds a red-default color theme select to the create goal form", async () => {
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.menu.createGoal)?.({} as Request, res);

    const response = json.mock.calls[0]?.[0] as {
      showForm: {
        form: {
          fields: Array<{
            name: string;
            type: string;
            defaultValue?: unknown;
            options?: Array<{ label: string; value: string }>;
          }>;
        };
      };
    };
    const fields = response.showForm.form.fields;
    expect(fields.find((field) => field.name === "colorTheme")).toMatchObject({
      type: "select",
      defaultValue: ["red"],
      options: [
        { label: "Red", value: "red" },
        { label: "Green", value: "green" },
        { label: "Purple", value: "purple" },
        { label: "Blue", value: "blue" },
      ],
    });
    expect(
      fields.find((field) => field.name === "autoCreateNextGoal"),
    ).toMatchObject({
      type: "boolean",
      defaultValue: true,
    });
    expect(fields.find((field) => field.name === "language")).toMatchObject({
      type: "select",
      defaultValue: ["en"],
      options: [
        { label: "Deutsch", value: "de" },
        { label: "English", value: "en" },
        { label: "Español", value: "es" },
        { label: "Français", value: "fr" },
        { label: "Italiano", value: "it" },
        { label: "Nederlands", value: "nl" },
        { label: "Português", value: "pt" },
        { label: "Română", value: "ro" },
      ],
    });
    expect(fields.map((field) => field.name)).toEqual([
      "subscriberGoal",
      "postTitle",
      "subredditDisplayName",
      "colorTheme",
      "language",
      "crosspost",
      "autoCreateNextGoal",
    ]);
  });

  it("passes the selected color theme when creating a goal post", async () => {
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoal)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome!",
          subredditDisplayName: "ExampleSub",
          crosspost: false,
          colorTheme: ["blue"],
          autoCreateNextGoal: false,
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
    );
    expect(hoisted.cancelAllAutoCreateNextGoals).toHaveBeenCalledWith(
      hoisted.redis,
    );
  });

  it("localizes the default post title when Spanish is selected", async () => {
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoal)?.(
      {
        body: {
          subscriberGoal: 200,
          postTitle: "Welcome to r/ExampleSub!",
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
    });
  });
});
