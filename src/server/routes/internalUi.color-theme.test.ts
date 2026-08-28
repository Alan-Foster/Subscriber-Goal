import type { Request, Response, Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formNames, internalRoutes } from "../../shared/routes";

const hoisted = vi.hoisted(() => ({
  context: {
    subredditName: "ExampleSub",
    userId: "t2_mod",
  },
  reddit: {
    getCurrentSubreddit: vi.fn(),
    getAppUser: vi.fn(),
    getPostById: vi.fn(),
    getCurrentUsername: vi.fn(),
    submitPost: vi.fn(),
    modMail: {
      createModNotification: vi.fn(),
    },
    sendPrivateMessage: vi.fn(),
  },
  redis: {},
  getAppSettings: vi.fn(),
  getSavedSubredditDisplayName: vi.fn(),
  setSavedSubredditDisplayName: vi.fn(),
  createGoalPost: vi.fn(),
  registerNewSubGoalPost: vi.fn(),
  registerNewSubscribeOnlyPost: vi.fn(),
  setSubredditDisplayNameForPost: vi.fn(),
  cancelAllAutoCreateNextGoals: vi.fn(),
  eraseFromRecentSubscribers: vi.fn(),
  untrackSubscriberById: vi.fn(),
  untrackSubscriberByUsername: vi.fn(),
  getTrackedPosts: vi.fn(),
  getQueuedUpdates: vi.fn(),
  queueUpdate: vi.fn(),
  clearUserStickies: vi.fn(),
  applyGoalPostFrameStyle: vi.fn(),
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
  cancelUpdates: vi.fn(),
  getQueuedUpdates: hoisted.getQueuedUpdates,
  getTrackedPosts: hoisted.getTrackedPosts,
  queueUpdate: hoisted.queueUpdate,
  untrackPost: vi.fn(),
}));

vi.mock("../utils/redditUtils", () => ({
  clearUserStickies: hoisted.clearUserStickies,
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
    hoisted.context.subredditName = "ExampleSub";
    hoisted.context.userId = "t2_mod";
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      isNsfw: false,
    });
    hoisted.reddit.getAppUser.mockResolvedValue({
      username: "subscriber-goal",
    });
    hoisted.reddit.getCurrentUsername.mockResolvedValue("ExampleMod");
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
      sticky: vi.fn(),
      isStickied: vi.fn(() => true),
    });
    hoisted.registerNewSubGoalPost.mockResolvedValue({ status: "skipped" });
    hoisted.registerNewSubscribeOnlyPost.mockResolvedValue({
      status: "skipped",
    });
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
    expect(response.showForm.form.title).toBe("Sub Goal - Erase My User Data");
    expect(response.showForm.form.fields).toEqual([
      expect.objectContaining({
        name: "confirm",
        type: "boolean",
        label: "Remove all of my Sub Goal user data",
      }),
    ]);
  });

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
          fields: Array<{ name: string }>;
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
        "You did not confirm the erasure. Please enable the confirmation toggle before proceeding.",
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
      showToast: "Please log in to erase your Sub Goal user data.",
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
      showToast: "Your Sub Goal user data has been erased.",
    });
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
    expect(fields.find((field) => field.name === "postHeight")).toMatchObject({
      type: "select",
      defaultValue: ["regular"],
      options: [
        { label: "Regular", value: "regular" },
        { label: "Short (no logo)", value: "short" },
        { label: "Tiny (Only Subscribe Button)", value: "tiny" },
      ],
    });
    expect(
      fields.find((field) => field.name === "subscriberGoal"),
    ).toMatchObject({
      required: false,
      helpText: expect.stringContaining("ignored for Tiny posts"),
    });
    expect(fields.find((field) => field.name === "language")).toMatchObject({
      type: "select",
      defaultValue: ["en"],
      options: [
        { label: "Bahasa Indonesia", value: "id" },
        { label: "Bosanski", value: "bs" },
        { label: "Català", value: "ca" },
        { label: "Dansk", value: "da" },
        { label: "Deutsch", value: "de" },
        { label: "English", value: "en" },
        { label: "Español", value: "es" },
        { label: "Eesti", value: "et" },
        { label: "Français", value: "fr" },
        { label: "Hrvatski", value: "hr" },
        { label: "Íslenska", value: "is" },
        { label: "Italiano", value: "it" },
        { label: "Latviešu", value: "lv" },
        { label: "Lietuvių", value: "lt" },
        { label: "Magyar", value: "hu" },
        { label: "Nederlands", value: "nl" },
        { label: "Norsk Bokmål", value: "nb" },
        { label: "Polski", value: "pl" },
        { label: "Português", value: "pt" },
        { label: "Română", value: "ro" },
        { label: "Shqip", value: "sq" },
        { label: "Slovenčina", value: "sk" },
        { label: "Slovenščina", value: "sl" },
        { label: "Suomi", value: "fi" },
        { label: "Svenska", value: "sv" },
        { label: "Tagalog", value: "tl" },
        { label: "Türkçe", value: "tr" },
        { label: "Yorùbá", value: "yo" },
      ],
    });
    expect(
      fields.find((field) => field.name === "customDeveloperField"),
    ).toMatchObject({
      type: "string",
      label: "Custom Developer Field",
      helpText:
        "This field is for developers and testing only. Please leave this field empty",
    });
    expect(fields.map((field) => field.name)).toEqual([
      "language",
      "postHeight",
      "subscriberGoal",
      "postTitle",
      "subredditDisplayName",
      "colorTheme",
      "crosspost",
      "autoCreateNextGoal",
      "customDeveloperField",
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
          postHeight: ["short"],
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
      undefined,
      "short",
    );
    expect(hoisted.cancelAllAutoCreateNextGoals).toHaveBeenCalledWith(
      hoisted.redis,
    );
  });

  it("creates tiny posts without requiring or registering a subscriber goal", async () => {
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoal)?.(
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
    );
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
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
      textFallback: expect.stringContaining("100 / 200 suscriptores."),
      postHeight: "regular",
    });
  });

  it("passes submitAsUser when the custom developer field is exactly runAs", async () => {
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoal)?.(
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
      textFallback: expect.stringContaining("100 / 200 subscribers."),
      postHeight: "regular",
      submitAsUser: true,
    });
  });

  it("submits a selfPost to the executing user's personal feed and skips normal goal creation", async () => {
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoal)?.(
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
    expect(hoisted.clearUserStickies).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      showToast: "Experimental selfPost submitted to r/u_ExampleMod.",
      navigateTo:
        "https://reddit.com/user/ExampleMod/comments/selfpost/subscriber_goal_test/",
    });
  });

  it("returns a selfPost failure toast when the executing username is unavailable", async () => {
    hoisted.reddit.getCurrentUsername.mockResolvedValue(undefined);
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoal)?.(
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
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoal)?.(
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
      showToast:
        "Experimental selfPost to r/u_ExampleMod failed: user feed denied",
    });
  });

  it("passes submitAsUser and headerText when multiple developer commands are provided", async () => {
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoal)?.(
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
      textFallback: expect.stringContaining("100 / 200 subscribers."),
      postHeight: "regular",
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
    );
  });

  it("does not pass submitAsUser when the custom developer field is empty", async () => {
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoal)?.(
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
      textFallback: expect.stringContaining("100 / 200 subscribers."),
      postHeight: "regular",
    });
  });

  it("ignores wrong-case custom developer commands", async () => {
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoal)?.(
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
      textFallback: expect.stringContaining("100 / 200 subscribers."),
      postHeight: "regular",
    });
  });

  it("ignores unknown developer commands without blocking creation", async () => {
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoal)?.(
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
      textFallback: expect.stringContaining("100 / 200 subscribers."),
      postHeight: "regular",
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
    );
  });

  it("notifies moderators and returns a partial-success toast when the new goal cannot be pinned", async () => {
    vi.useFakeTimers();
    hoisted.createGoalPost.mockResolvedValue({
      id: "t3_newpost",
      subredditName: "ExampleSub",
      subredditId: "t5_example",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      title: "Welcome!",
      permalink: "/r/ExampleSub/comments/newpost/welcome/",
      approve: vi.fn(),
      sticky: vi.fn(),
      isStickied: vi.fn(() => false),
    });
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    const responsePromise = routes.get(internalRoutes.forms.createGoal)?.(
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
      subject: "Action Required - SubGoal Not Pinned in r/ExampleSub",
      bodyMarkdown: expect.stringContaining(
        "The new Subscriber Goal post was created successfully",
      ),
    });
    expect(hoisted.reddit.sendPrivateMessage).toHaveBeenCalledWith({
      to: "ExampleMod",
      subject: "Action Required - SubGoal Not Pinned in r/ExampleSub",
      text: expect.stringContaining(
        "https://reddit.com/r/ExampleSub/comments/newpost/welcome/",
      ),
    });
    expect(res.json).toHaveBeenCalledWith({
      showToast:
        "Subscriber Goal post created, but it could not be pinned. Manual moderator action is required.",
      navigateTo: "https://reddit.com/r/ExampleSub/comments/t3_newpost",
    });
  });

  it("logs notification failures without breaking partial-success creation", async () => {
    vi.useFakeTimers();
    hoisted.createGoalPost.mockResolvedValue({
      id: "t3_newpost",
      subredditName: "ExampleSub",
      subredditId: "t5_example",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      title: "Welcome!",
      approve: vi.fn(),
      sticky: vi.fn(() => {
        throw new Error("sticky slots full");
      }),
      isStickied: vi.fn(() => false),
    });
    hoisted.reddit.modMail.createModNotification.mockRejectedValue(
      new Error("modmail unavailable"),
    );
    hoisted.reddit.sendPrivateMessage.mockRejectedValue(
      new Error("dm unavailable"),
    );
    const routes = createRouteHarness();
    const res = { json: vi.fn() } as unknown as Response;

    const responsePromise = routes.get(internalRoutes.forms.createGoal)?.(
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
        "Subscriber Goal post created, but it could not be pinned. Manual moderator action is required.",
      navigateTo: "https://reddit.com/r/ExampleSub/comments/t3_newpost",
    });
  });
});
