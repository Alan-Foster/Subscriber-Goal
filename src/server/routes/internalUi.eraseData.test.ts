import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formNames, internalRoutes } from "../../shared/routes";
import { captureUiRoutes } from "./internalUi.testHelpers";
import { registerEraseDataRoutes } from "./internalUi.eraseData";

const hoisted = vi.hoisted(() => ({
  context: {
    postId: "t3_post",
    subredditName: "ExampleSub",
    userId: "t2_mod",
  },
  reddit: {
    getCurrentSubreddit: vi.fn(),
    getCurrentUsername: vi.fn(),
    getCurrentUser: vi.fn(),
    getModerators: vi.fn(),
    getUserById: vi.fn(),
    getUserByUsername: vi.fn(),
  },
  redis: {
    hGet: vi.fn(),
  },
  eraseFromRecentSubscribers: vi.fn(),
  untrackSubscriberById: vi.fn(),
  untrackSubscriberByUsername: vi.fn(),
}));

vi.mock("@devvit/web/server", () => ({
  context: hoisted.context,
  reddit: hoisted.reddit,
  redis: hoisted.redis,
}));

vi.mock("../data/subGoalData", () => ({
  eraseFromRecentSubscribers: hoisted.eraseFromRecentSubscribers,
}));

vi.mock("../data/subscriberStats", () => ({
  untrackSubscriberById: hoisted.untrackSubscriberById,
  untrackSubscriberByUsername: hoisted.untrackSubscriberByUsername,
}));

function createRouteHarness() {
  return captureUiRoutes(registerEraseDataRoutes);
}

describe("internalUi eraseData routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.reddit.getCurrentSubreddit.mockResolvedValue({
      id: "t5_example",
      name: "ExampleSub",
    });
    hoisted.redis.hGet.mockResolvedValue(undefined);

    hoisted.context.subredditName = "ExampleSub";
    hoisted.context.postId = "t3_post";
    hoisted.context.userId = "t2_mod";
    hoisted.reddit.getCurrentUsername.mockResolvedValue("ExampleMod");
    hoisted.reddit.getCurrentUser.mockResolvedValue({
      id: "t2_mod",
      username: "ExampleMod",
    });
    hoisted.reddit.getModerators.mockReturnValue({
      all: vi.fn(async () => [
        {
          id: "t2_mod",
          username: "ExampleMod",
          moderatorInfo: { modPermissions: ["all"] },
        },
      ]),
    });
    hoisted.reddit.getUserById.mockResolvedValue(undefined);
    hoisted.reddit.getUserByUsername.mockResolvedValue(undefined);
    hoisted.untrackSubscriberById.mockResolvedValue({
      status: "complete",
      userIds: ["t2_mod"],
    });
    hoisted.untrackSubscriberByUsername.mockResolvedValue({
      status: "complete",
      userIds: ["t2_user"],
    });
    hoisted.eraseFromRecentSubscribers.mockResolvedValue(undefined);
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
    expect(response.showForm.form.title).toBe("Sub Goal - Remove My Own Data");
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
        "You did not confirm removal. Please enable the confirmation toggle before proceeding.",
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
      showToast: "Please log in to remove your Sub Goal user data.",
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
      "t2_mod",
    );
    expect(json).toHaveBeenCalledWith({
      showToast: "Your Sub Goal user data has been removed.",
    });
  });

  it("responds once after moderator erasure continues past an identity lookup failure", async () => {
    hoisted.reddit.getUserById.mockRejectedValue(
      new Error("identity service unavailable"),
    );
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.eraseData)?.(
      { body: { userId: "user", confirm: true } } as Request,
      res,
    );

    expect(hoisted.untrackSubscriberById).toHaveBeenCalledWith(
      hoisted.redis,
      "t2_user",
      undefined,
    );
    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({
      showToast: expect.stringContaining(
        "Some Subscriber Goal data was removed",
      ),
    });
  });

  it.each([
    {
      lookup: "missing",
      status: "complete",
      fails: false,
      expected: "User data has been erased successfully.",
    },
    {
      lookup: "throws",
      status: "complete",
      fails: false,
      expected: "Some Subscriber Goal data was removed",
    },
    {
      lookup: "missing",
      status: "partial",
      fails: false,
      expected: "To finish, try again",
    },
    {
      lookup: "throws",
      status: "partial",
      fails: false,
      expected: "To finish, try again",
    },
    {
      lookup: "missing",
      status: "complete",
      fails: true,
      expected: "could not be fully erased",
    },
    {
      lookup: "throws",
      status: "complete",
      fails: true,
      expected: "could not be fully erased",
    },
  ])(
    "reports $status erasure when username lookup $lookup (failure=$fails)",
    async ({ lookup, status, fails, expected }) => {
      if (lookup === "throws")
        hoisted.reddit.getUserByUsername.mockRejectedValue(
          new Error("Reddit unavailable"),
        );
      else hoisted.reddit.getUserByUsername.mockResolvedValue(undefined);
      hoisted.untrackSubscriberByUsername.mockResolvedValue({
        status,
        userIds: status === "complete" ? ["t2_user"] : [],
      });
      if (fails)
        hoisted.untrackSubscriberByUsername.mockRejectedValue(
          new Error("Redis unavailable"),
        );
      const routes = createRouteHarness();
      const json = vi.fn();
      await routes.get(internalRoutes.forms.eraseData)?.(
        { body: { username: "AlIcE", confirm: true } } as Request,
        { json } as unknown as Response,
      );
      expect(hoisted.untrackSubscriberByUsername).toHaveBeenCalledWith(
        hoisted.redis,
        "AlIcE",
      );
      expect(json).toHaveBeenCalledExactlyOnceWith({
        showToast: expect.stringContaining(expected),
      });
    },
  );

  it("blocks moderator erasure after membership is revoked", async () => {
    hoisted.reddit.getModerators.mockReturnValue({
      all: vi.fn(async () => []),
    });
    const routes = createRouteHarness();
    const json = vi.fn();

    await routes.get(internalRoutes.forms.eraseData)?.(
      { body: { userId: "t2_user", confirm: true } } as Request,
      { json } as unknown as Response,
    );

    expect(json).toHaveBeenCalledWith({
      showToast: expect.stringContaining("moderator of this community"),
    });
    expect(hoisted.reddit.getUserById).not.toHaveBeenCalled();
    expect(hoisted.untrackSubscriberById).not.toHaveBeenCalled();
    expect(hoisted.eraseFromRecentSubscribers).not.toHaveBeenCalled();
  });

  it("responds once with a failure when moderator erasure throws", async () => {
    hoisted.untrackSubscriberById.mockRejectedValue(
      new Error("redis unavailable"),
    );
    const routes = createRouteHarness();
    const json = vi.fn();
    const res = { json } as unknown as Response;

    await routes.get(internalRoutes.forms.eraseData)?.(
      { body: { userId: "t2_user", confirm: true } } as Request,
      res,
    );

    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({
      showToast:
        "User data could not be fully erased. Please try again with the user ID.",
    });
  });
});
