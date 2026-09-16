import { describe, expect, it } from "vitest";
import { getCurrentSubredditNsfw } from "../utils/subredditSafety";
import { getAutomaticGoalEligibility } from "./automaticGoalEligibility";

describe("automatic goal eligibility", () => {
  it("accepts only an explicitly SFW public subreddit", () => {
    expect(
      getAutomaticGoalEligibility({ type: "public", nsfw: false }),
    ).toEqual({
      eligible: true,
      subredditType: "public",
      isSfw: true,
      safetyStatus: "sfw",
    });
  });

  it("rejects NSFW, unknown-safety, and non-public subreddits", () => {
    expect(
      getAutomaticGoalEligibility({ type: "public", nsfw: true }),
    ).toMatchObject({
      eligible: false,
      safetyStatus: "nsfw",
      reason: "subreddit_not_sfw",
    });
    expect(getAutomaticGoalEligibility({ type: "public" })).toMatchObject({
      eligible: false,
      safetyStatus: "unknown",
      reason: "subreddit_not_sfw",
    });
    for (const type of ["private", "restricted", undefined]) {
      expect(getAutomaticGoalEligibility({ type, nsfw: false })).toMatchObject({
        eligible: false,
        reason: "subreddit_not_public",
      });
    }
  });

  it("reads the Devvit current-subreddit nsfw property", () => {
    expect(getCurrentSubredditNsfw({ nsfw: false })).toBe(false);
    expect(getCurrentSubredditNsfw({ nsfw: true })).toBe(true);
    expect(getCurrentSubredditNsfw({})).toBeUndefined();
    expect(getCurrentSubredditNsfw({ nsfw: "false" })).toBeUndefined();
  });
});
