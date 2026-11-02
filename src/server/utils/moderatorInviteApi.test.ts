import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  acceptModeratorInvite: vi.fn(),
  use: vi.fn(),
}));

vi.mock("@devvit/protos", () => ({
  ModerationDefinition: { name: "Moderation" },
}));

vi.mock("@devvit/shared-types/server/get-devvit-config.js", () => ({
  getDevvitConfig: () => ({ use: hoisted.use }),
}));

import {
  acceptModeratorInvite,
  ModeratorInviteRejectedError,
} from "./moderatorInviteApi";

describe("moderator invitation Devvit adapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.use.mockReturnValue({
      AcceptModeratorInvite: hoisted.acceptModeratorInvite,
    });
  });

  it("calls the narrow Moderation endpoint for the subreddit", async () => {
    hoisted.acceptModeratorInvite.mockResolvedValue({ json: { errors: [] } });

    await expect(acceptModeratorInvite("ExampleSub")).resolves.toBeUndefined();

    expect(hoisted.use).toHaveBeenCalledWith({ name: "Moderation" });
    expect(hoisted.acceptModeratorInvite).toHaveBeenCalledWith({
      subreddit: "ExampleSub",
    });
  });

  it("surfaces structured Reddit API errors as terminal rejections", async () => {
    hoisted.acceptModeratorInvite.mockResolvedValue({
      json: { errors: ["NO_INVITE"] },
    });

    await expect(acceptModeratorInvite("ExampleSub")).rejects.toEqual(
      expect.objectContaining<Partial<ModeratorInviteRejectedError>>({
        name: "ModeratorInviteRejectedError",
        errors: ["NO_INVITE"],
      }),
    );
  });
});
