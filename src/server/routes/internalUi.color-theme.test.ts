import type { Request, Response, Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formNames, internalRoutes } from "../../shared/routes";

const hoisted = vi.hoisted(() => ({
  redisValues: new Map<string, string>(),
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
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  },
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
  removeSubscriberGoalPost: vi.fn(),
  isSubredditBlacklisted: vi.fn(),
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

vi.mock("../data/subscriberGoalPostRegistry", () => ({
  removeSubscriberGoalPost: hoisted.removeSubscriberGoalPost,
}));

vi.mock("../utils/redditUtils", () => ({
  clearUserStickies: hoisted.clearUserStickies,
}));

vi.mock("../utils/subredditBlacklist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/subredditBlacklist")>()),
  isSubredditBlacklisted: hoisted.isSubredditBlacklisted,
}));

import { registerInternalUiRoutes } from "./internalUi";

type RouteHandler = (req: Request, res: Response) => void | Promise<void>;

function createRouteHarness(): Map<string, RouteHandler> {
  const userId = hoisted.context.userId;
  if (userId && !hoisted.redisValues.has(`create_goal_draft:${userId}`)) {
    seedCreateGoalDraft("regular", "en");
  }
  const routes = new Map<string, RouteHandler>();
  const router = {
    post: (path: string, handler: RouteHandler) => {
      routes.set(path, handler);
    },
  } as unknown as Router;
  registerInternalUiRoutes(router);
  return routes;
}

function seedCreateGoalDraft(
  postHeight: "regular" | "short" | "tiny",
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
    stage?: "details" | "follow-up";
    subredditDisplayName?: string;
  } = {},
): void {
  const base = {
    version: 4,
    stage: options.stage ?? "follow-up",
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
          afterSubscribePreset: options.afterSubscribePreset ?? "web-link",
        }
      : {
          kind: "subscriber-goal",
          postTitle: options.postTitle ?? "Welcome!",
          subscriberGoal: options.subscriberGoal ?? 200,
          colorTheme: options.colorTheme ?? "red",
          crosspost: options.crosspost ?? false,
          afterSubscribePreset: options.afterSubscribePreset ?? "web-link",
          autoCreateNextGoal: options.autoCreateNextGoal ?? true,
        };
  hoisted.redisValues.set(
    `create_goal_draft:${hoisted.context.userId}`,
    JSON.stringify(base.stage === "details" ? base : { ...base, details }),
  );
}

describe("internalUi color theme create goal routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.redisValues.clear();
    hoisted.redis.set.mockImplementation(async (key, value) => {
      hoisted.redisValues.set(key, value);
      return "OK";
    });
    hoisted.redis.get.mockImplementation(async (key) =>
      hoisted.redisValues.get(key),
    );
    hoisted.redis.del.mockImplementation(async (key) => {
      const existed = hoisted.redisValues.delete(key);
      return existed ? 1 : 0;
    });
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
    hoisted.isSubredditBlacklisted.mockResolvedValue(false);
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

  it("opens the numbered setup form with language, capitalization, and height", async () => {
    const routes = createRouteHarness();
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
        { label: "Regular", value: "regular" },
        { label: "Short (no logo)", value: "short" },
        { label: "Tiny (Only Subscribe Button)", value: "tiny" },
      ],
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
    expect(fields.map((field) => field.name)).toEqual([
      "language",
      "subredditDisplayName",
      "postHeight",
    ]);
    expect(hoisted.reddit.getCurrentSubreddit).toHaveBeenCalled();
    expect(hoisted.redis.del).toHaveBeenCalledWith("create_goal_draft:t2_mod");
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
    ).toMatchObject({ defaultValue: "¡Bienvenido a r/EXAMPLEsub!" });
    expect(
      response.showForm.form.fields.find(
        (field) => field.name === "subscriberGoal",
      ),
    ).toMatchObject({ defaultValue: 150 });
    expect(
      response.showForm.form.fields.find((field) => field.name === "crosspost"),
    ).toMatchObject({ defaultValue: true, disabled: false });
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
        { label: "Link to a Discord Server", value: "discord" },
        { label: "Link to a Webpage URL", value: "web-link" },
        { label: "Link to the Subreddit Wiki", value: "wiki" },
        { label: "Link to Create a New Text Post", value: "create-post" },
        { label: "Link to Create an Image Post", value: "share-picture" },
      ],
    });
    expect(
      response.showForm.form.fields.find(
        (field) => field.name === "autoCreateNextGoal",
      ),
    ).toMatchObject({ defaultValue: true });
    expect(hoisted.redis.set).toHaveBeenCalledWith(
      "create_goal_draft:t2_mod",
      JSON.stringify({
        version: 4,
        stage: "details",
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
      "Sub Goal - Step 3/3 - Settings for After Subscribing",
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
      label: "Button Text After a User Subscribes",
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
    expect(
      JSON.parse(hoisted.redisValues.get("create_goal_draft:t2_mod")!),
    ).toMatchObject({
      version: 4,
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
      "Sub Goal - Step 3/3 - Settings for After Subscribing",
    );
    expect(response.showForm.form.fields.map((field) => field.name)).toEqual([
      "afterSubscribeButtonText",
      "afterSubscribeColorTheme",
      "customDeveloperField",
    ]);
    expect(
      JSON.parse(hoisted.redisValues.get("create_goal_draft:t2_mod")!),
    ).toMatchObject({
      version: 4,
      stage: "follow-up",
      details: {
        kind: "subscribe-only",
        postTitle: "Subscribe Here",
        colorTheme: "pink",
        afterSubscribePreset: "top-post-day",
      },
    });
  });

  it.each([
    ["web-link", undefined, true, "pink"],
    ["discord", "Únete al Discord", true, "blue"],
    ["top-post-day", "Ver la publicación destacada de hoy", false, "pink"],
    ["wiki", "Leer la Wiki", true, "pink"],
    ["create-post", "Crear una publicación", false, "pink"],
    ["share-picture", "Compartir una imagen", false, "pink"],
    ["newest-post", "Ver la publicación más reciente de hoy", false, "pink"],
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
              fields: Array<{ name: string; defaultValue?: unknown }>;
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
        fields.find((field) => field.name === "afterSubscribeColorTheme")
          ?.defaultValue,
      ).toEqual([colorTheme]);
    },
  );

  it("disables goal crossposting when the source subreddit is NSFW", async () => {
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
      numberOfSubscribers: 100,
      isNsfw: true,
    });
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.createGoalSetup)?.(
      {
        body: {
          language: ["en"],
          subredditDisplayName: "ExampleSub",
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
      response.showForm.form.fields.find((field) => field.name === "crosspost"),
    ).toMatchObject({
      defaultValue: false,
      disabled: true,
      helpText: "Crossposting is disabled for NSFW source subreddits.",
    });
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

  it("reopens setup when a details draft is missing", async () => {
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

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        showToast: expect.stringContaining("expired"),
        showForm: expect.objectContaining({ name: formNames.createGoalSetup }),
      }),
    );
    expect(hoisted.createGoalPost).not.toHaveBeenCalled();
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

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        showForm: expect.objectContaining({ name: formNames.createGoalSetup }),
      }),
    );
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
    expect(hoisted.redisValues.has("create_goal_draft:t2_mod")).toBe(true);
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
    );
    expect(hoisted.cancelAllAutoCreateNextGoals).toHaveBeenCalledWith(
      hoisted.redis,
    );
    expect(hoisted.redis.del).toHaveBeenCalledWith("create_goal_draft:t2_mod");
    expect(hoisted.redisValues.has("create_goal_draft:t2_mod")).toBe(false);
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
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ showToast: "Subscriber Goal post created!" }),
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
    );
  });

  it("falls back to Top Post and warns when CTA data is invalid", async () => {
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

    expect(hoisted.registerNewSubscribeOnlyPost).toHaveBeenCalledWith(
      hoisted.redis,
      expect.anything(),
      expect.objectContaining({ id: "t3_newpost" }),
      "ExampleSub",
      "blue",
      "en",
      {
        type: "top-post-day",
        buttonText: "View the Top Post Today",
        colorTheme: "pink",
      },
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        showToast:
          "Subscriber Goal post created! The after-subscribed button configuration was invalid, so it now defaults to View the Top Post Today.",
      }),
    );
  });

  it.each([
    ["web-link", { afterSubscribeButtonText: "Read the rules" }],
    ["discord", {}],
    ["wiki", {}],
  ] as const)(
    "falls back to Top Post when the %s preset has no URL",
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
          colorTheme: "red",
        },
      );
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
          colorTheme: "pink",
        },
      );
    },
  );

  it.each([
    ["top-post-day", "View the Top Post Today"],
    ["newest-post", "View the Most Recent Post Today"],
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
        { type: afterSubscribePreset, buttonText, colorTheme: "green" },
      );
    },
  );

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
        colorTheme: "red",
      },
    );
    expect(hoisted.registerNewSubGoalPost).not.toHaveBeenCalled();
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
    expect(hoisted.clearUserStickies).not.toHaveBeenCalled();
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
      showToast:
        "Experimental selfPost to r/u_ExampleMod failed: user feed denied",
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
        colorTheme: "red",
      },
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
        colorTheme: "red",
      },
    );
  });

  it("notifies moderators and returns a partial-success toast when the new goal cannot be pinned", async () => {
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
      sticky: vi.fn(),
      isStickied: vi.fn(() => false),
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
        "Subscriber Goal post created, but it could not be pinned. Manual moderator action is required.",
      navigateTo: "https://reddit.com/r/ExampleSub/comments/t3_newpost",
    });
  });
});
