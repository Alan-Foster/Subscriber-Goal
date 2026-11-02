import { describe, expect, it, vi } from "vitest";
import type { RedditClient } from "../types";
import { canViewCurrentSubredditStatistics } from "./statisticsAuthorization";

const createReddit = (moderators: string[] = []) =>
  ({
    getCurrentUser: vi.fn(),
    getModerators: vi.fn(() => ({
      all: vi.fn(async () => moderators.map((username) => ({ username }))),
    })),
  }) as unknown as RedditClient;

describe("statistics authorization", () => {
  it("allows an exact current-subreddit moderator", async () => {
    const reddit = createReddit(["CurrentMod"]);
    await expect(
      canViewCurrentSubredditStatistics(reddit, "t2_mod", "Example", {
        username: "CurrentMod",
        isModerator: true,
      }),
    ).resolves.toBe(true);
  });

  it("rejects moderators who do not moderate the current subreddit", async () => {
    const reddit = createReddit([]);
    await expect(
      canViewCurrentSubredditStatistics(reddit, "t2_mod", "Example", {
        username: "OtherMod",
        isModerator: true,
      }),
    ).resolves.toBe(false);
  });

  it("allows Alan-Foster case-insensitively without a moderator lookup", async () => {
    const reddit = createReddit();
    await expect(
      canViewCurrentSubredditStatistics(reddit, "t2_dev", "Example", {
        username: "ALAN-FOSTER",
        isModerator: false,
      }),
    ).resolves.toBe(true);
    expect(reddit.getModerators).not.toHaveBeenCalled();
  });

  it("rejects anonymous and ordinary users", async () => {
    const reddit = createReddit();
    await expect(
      canViewCurrentSubredditStatistics(reddit, null, "Example"),
    ).resolves.toBe(false);
    await expect(
      canViewCurrentSubredditStatistics(reddit, "t2_user", "Example", {
        username: "user",
        isModerator: false,
      }),
    ).resolves.toBe(false);
  });
});
