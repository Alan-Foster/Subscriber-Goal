import { describe, expect, it, vi } from "vitest";
import { getSubscriberGoalCandidatePostIds } from "./subscriberGoalCandidates";
import {
  subscriberGoalPostRegistryKey,
} from "./subscriberGoalPostRegistry";
import { postsKey, updatesKey } from "./updaterData";

describe("getSubscriberGoalCandidatePostIds", () => {
  it("unifies registry, tracked, queued, and persisted goal identities", async () => {
    const redis = {
      zRange: vi.fn(async (key: string) => {
        if (key === subscriberGoalPostRegistryKey)
          return [{ member: "t3_registry", score: 1 }];
        if (key === postsKey) return [{ member: "t3_tracked", score: 1 }];
        if (key === updatesKey) return [{ member: "t3_queued", score: 1 }];
        return [];
      }),
      hScan: vi.fn(async () => ({
        cursor: 0,
        fieldValues: [
          { field: "t3_persisted_post_kind", value: "subscribe-only-v1" },
          { field: "t3_registry_post_height", value: "tiny" },
        ],
      })),
    };

    await expect(
      getSubscriberGoalCandidatePostIds(redis as never),
    ).resolves.toEqual([
      "t3_registry",
      "t3_tracked",
      "t3_queued",
      "t3_persisted",
    ]);
  });
});
