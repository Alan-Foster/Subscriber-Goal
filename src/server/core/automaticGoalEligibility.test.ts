import { describe, expect, it } from "vitest";
import { getCurrentSubredditNsfw } from "../utils/subredditSafety";
import {
  getAutomaticGoalEligibility,
  isAutomaticGoalEligibilityUncertain,
} from "./automaticGoalEligibility";

describe("automatic goal eligibility", () => {
  it.each([
    [false, "sfw"],
    [true, "nsfw"],
    [undefined, "unknown"],
  ] as const)(
    "accepts public subreddits and reports %s as %s",
    (nsfw, safetyStatus) => {
      const result = getAutomaticGoalEligibility({ type: "public", nsfw });
      expect(result).toEqual({
        eligible: true,
        subredditType: "public",
        isSfw: nsfw === false,
        safetyStatus,
      });
      expect(isAutomaticGoalEligibilityUncertain(result)).toBe(false);
    },
  );

  it("rejects non-public subreddits and retries only an unknown type", () => {
    for (const type of ["private", "restricted", undefined]) {
      const result = getAutomaticGoalEligibility({ type, nsfw: true });
      expect(result).toMatchObject({
        eligible: false,
        reason: "subreddit_not_public",
      });
      expect(isAutomaticGoalEligibilityUncertain(result)).toBe(
        type === undefined,
      );
    }
  });

  it("reads the Devvit current-subreddit nsfw property", () => {
    expect(getCurrentSubredditNsfw({ nsfw: false })).toBe(false);
    expect(getCurrentSubredditNsfw({ nsfw: true })).toBe(true);
    expect(getCurrentSubredditNsfw({})).toBeUndefined();
    expect(getCurrentSubredditNsfw({ nsfw: "false" })).toBeUndefined();
  });
});
