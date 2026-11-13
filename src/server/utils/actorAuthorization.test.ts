import { describe, expect, it, vi } from "vitest";
import { getCurrentActorAuthority } from "./actorAuthorization";
import type { RedditClient } from "../types";

function redditWith({
  actor = { id: "t2_actor", username: "Alice" },
  moderators = [],
  lookupError,
}: {
  actor?: { id: string; username: string } | undefined;
  moderators?: Array<{
    id: string;
    username: string;
    moderatorInfo?: { modPermissions: string[] };
  }>;
  lookupError?: Error;
}) {
  const all = lookupError
    ? vi.fn().mockRejectedValue(lookupError)
    : vi.fn().mockResolvedValue(moderators);
  return {
    getCurrentUser: vi.fn().mockResolvedValue(actor),
    getModerators: vi.fn().mockReturnValue({ all }),
  } as unknown as RedditClient;
}

describe("getCurrentActorAuthority", () => {
  it.each(["posts", "all"])(
    "authorizes Manage Posts through %s",
    async (permission) => {
      const result = await getCurrentActorAuthority({
        reddit: redditWith({
          moderators: [
            {
              id: "t2_actor",
              username: "alice",
              moderatorInfo: { modPermissions: [permission] },
            },
          ],
        }),
        actorUserId: "t2_actor",
        subredditName: "Example",
        requirement: "manage-posts",
      });
      expect(result.status).toBe("authorized");
    },
  );

  it("denies confirmed absence and unrelated permissions", async () => {
    for (const moderators of [
      [],
      [
        {
          id: "t2_actor",
          username: "Alice",
          moderatorInfo: { modPermissions: ["flair"] },
        },
      ],
    ]) {
      await expect(
        getCurrentActorAuthority({
          reddit: redditWith({ moderators }),
          actorUserId: "t2_actor",
          subredditName: "Example",
          requirement: "manage-posts",
        }),
      ).resolves.toMatchObject({ status: "denied" });
    }
  });

  it("accepts any well-formed moderator row for membership-only actions", async () => {
    await expect(
      getCurrentActorAuthority({
        reddit: redditWith({
          moderators: [
            {
              id: "t2_actor",
              username: "Alice",
              moderatorInfo: { modPermissions: [] },
            },
          ],
        }),
        actorUserId: "t2_actor",
        subredditName: "Example",
        requirement: "moderator",
      }),
    ).resolves.toMatchObject({ status: "authorized" });
  });

  it.each([
    [
      "authenticated account mismatch",
      { actor: { id: "t2_other", username: "Alice" } },
    ],
    [
      "lookup account mismatch",
      {
        moderators: [
          {
            id: "t2_other",
            username: "Alice",
            moderatorInfo: { modPermissions: ["all"] },
          },
        ],
      },
    ],
    ["malformed row", { moderators: [{ id: "t2_actor", username: "Alice" }] }],
    [
      "malformed permissions",
      {
        moderators: [
          {
            id: "t2_actor",
            username: "Alice",
            moderatorInfo: { modPermissions: ["unexpected"] },
          },
        ],
      },
    ],
    ["lookup failure", { lookupError: new Error("temporary") }],
  ])("treats %s as inconclusive", async (_label, setup) => {
    await expect(
      getCurrentActorAuthority({
        reddit: redditWith(setup),
        actorUserId: "t2_actor",
        subredditName: "Example",
        requirement: "manage-posts",
      }),
    ).resolves.toMatchObject({ status: "inconclusive" });
  });
});
