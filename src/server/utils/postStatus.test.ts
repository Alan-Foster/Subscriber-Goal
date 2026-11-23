import { describe, expect, it } from "vitest";
import { getPostAvailability, isMissingPostError } from "./postStatus";

describe("post availability", () => {
  it.each(["deleted", "author"])(
    "only allowlists %s as terminal",
    (category) => {
      expect(getPostAvailability({ removedByCategory: category })).toEqual({
        status: "terminal",
        category,
      });
    },
  );
  it.each([
    "moderator",
    "automod_filtered",
    "reddit",
    "community_ops",
    "anti_evil_ops",
    "content_takedown",
    "copyright_takedown",
    "unknown_remover",
    "DELETED",
  ])("preserves %s removals as nonterminal", (category) => {
    expect(getPostAvailability({ removedByCategory: category })).toEqual({
      status: "temporarily_removed",
      category,
    });
  });
  it.each([undefined, null, "", "   "])(
    "treats an empty category %j as active when no removal flag is set",
    (category) => {
      expect(
        getPostAvailability({
          removedByCategory: category,
          removed: false,
          spam: false,
        }),
      ).toEqual({ status: "active" });
    },
  );
  it.each([
    { removed: true },
    { spam: true },
    { removedByCategory: 42 },
    null,
    undefined,
  ])("keeps unavailable or uncertain metadata %j nonterminal", (post) => {
    expect(getPostAvailability(post).status).toBe("temporarily_removed");
  });
  it("preserves confirmed missing versus transient lookup classification", () => {
    expect(
      isMissingPostError(
        Object.assign(new Error("missing"), { status: 404 }),
        "t3_post",
      ),
    ).toBe(true);
    expect(
      isMissingPostError(
        Object.assign(new Error("missing"), { status: 410 }),
        "t3_post",
      ),
    ).toBe(true);
    expect(
      isMissingPostError(
        new Error("permission check for deleted posts failed"),
        "t3_post",
      ),
    ).toBe(false);
  });
});
