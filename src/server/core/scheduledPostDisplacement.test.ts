import { watchTestString } from "../testing/testHashWatch";
import type { ModAction } from "@devvit/reddit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  subscriberGoalPostKind,
  subscribeOnlyPostKind,
} from "../../shared/postKind";
import { getSubGoalData } from "../data/subGoalData";
import type { RedditClient, RedisClient } from "../types";
import { retiredSubscriberGoalKeyPrefix } from "./postRetirement";
import {
  processDueScheduledPostDisplacementChecks,
  scheduledPostDisplacementKey,
} from "./scheduledPostDisplacement";

vi.mock("../data/subGoalData", () => ({ getSubGoalData: vi.fn() }));

const unpinnedAt = Date.parse("2026-11-18T12:00:00Z");
const atMinute = (minutes: number) => unpinnedAt + minutes * 60_000;
const postId = "t3_goal";
const subredditId = "t5_example";
const goal = { postKind: subscriberGoalPostKind, goal: 200, completedTime: 0 };

function logEntry(
  minute: number,
  type: ModAction["type"] = "submit_scheduled_post",
) {
  return {
    type,
    id: `action_${minute}`,
    createdAt: new Date(atMinute(minute)),
  };
}

function fixture(entries = [logEntry(0)]) {
  const checks = new Map<string, string>([[postId, String(unpinnedAt)]]);
  const values = new Map<string, string>();
  const watchDisplacement = vi.fn(async (_key: string) => ({
    unwatch: vi.fn(),
    multi: vi.fn(),
    discard: vi.fn(),
    hDel: vi.fn(async (_key: string, fields: string[]) => {
      for (const field of fields) checks.delete(field);
    }),
    exec: vi.fn().mockResolvedValue([1]),
  }));
  const redis = {
    get: vi.fn(async (key: string) => values.get(key)),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    hGetAll: vi.fn(async () => Object.fromEntries(checks)),
    hGet: vi.fn(async (_key: string, id: string) => checks.get(id)),
    watch: async (key: string) =>
      values.has(key) ? watchTestString(redis, key) : watchDisplacement(key),
  };
  const keep = [{ postId: "t3_sticky" }, { postId: "t3_announcement" }];
  const highlights = [...keep];
  const post = {
    id: postId,
    subredditId,
    authorId: "t2_app",
    removed: false,
    highlight: vi.fn(async () => {
      highlights.push({ postId });
    }),
    unhighlight: vi.fn(),
  };
  const subreddit = {
    id: subredditId,
    name: "ExampleSub",
    numberOfSubscribers: 100,
    getHighlightedPosts: vi.fn(async () => highlights),
    reorderHighlightedPosts: vi.fn(),
  };
  const getLog = vi.fn().mockResolvedValue(entries);
  const reddit = {
    getModerationLog: vi.fn(() => ({ get: getLog })),
    getPostById: vi.fn(async () => post),
    getAppUser: vi.fn().mockResolvedValue({ id: "t2_app" }),
    sendModMail: vi.fn(),
  };
  const run = (minute: number) =>
    processDueScheduledPostDisplacementChecks({
      reddit: reddit as unknown as RedditClient,
      redis: redis as unknown as RedisClient,
      subreddit: subreddit as unknown as Parameters<
        typeof processDueScheduledPostDisplacementChecks
      >[0]["subreddit"],
      nowMs: atMinute(minute),
    });
  return {
    checks,
    values,
    redis,
    watchDisplacement,
    reddit,
    getLog,
    post,
    subreddit,
    highlights,
    keep,
    run,
  };
}

describe("scheduled post displacement", () => {
  beforeEach(() => {
    vi.mocked(getSubGoalData)
      .mockReset()
      .mockResolvedValue(goal as Awaited<ReturnType<typeof getSubGoalData>>);
  });

  it.each([-15, 15])(
    "re-pins for a publication at minute %i after the unpin",
    async (minute) => {
      const { run, reddit, getLog, post, checks, highlights, keep, subreddit } =
        fixture([logEntry(minute)]);
      await run(14);
      expect(reddit.getModerationLog).not.toHaveBeenCalled();
      await run(15);
      await run(16);

      expect(reddit.getModerationLog).toHaveBeenCalledExactlyOnceWith({
        subredditName: "ExampleSub",
        type: "submit_scheduled_post",
        limit: 25,
        pageSize: 25,
      });
      expect(getLog).toHaveBeenCalledExactlyOnceWith(25);
      expect(post.highlight).toHaveBeenCalledOnce();
      expect(highlights).toEqual([...keep, { postId }]);
      expect(post.unhighlight).not.toHaveBeenCalled();
      expect(subreddit.reorderHighlightedPosts).not.toHaveBeenCalled();
      expect(reddit.sendModMail).not.toHaveBeenCalled();
      expect(checks.has(postId)).toBe(false);
    },
  );

  it.each([
    ["no scheduled submission", []],
    [
      "timestamps outside the unpin window",
      [logEntry(-16), logEntry(16), logEntry(45)],
    ],
    ["a new schedule", [logEntry(0, "create_scheduled_post")]],
  ] as const)("does nothing with %s", async (_case, entries) => {
    const { run, post, checks } = fixture([...entries]);
    await run(50);
    expect(post.highlight).not.toHaveBeenCalled();
    expect(checks.has(postId)).toBe(false);
  });

  it("uses the unpin time even when the scheduler runs late", async () => {
    const { run, post } = fixture([logEntry(45), logEntry(-12)]);
    await run(50);
    expect(post.highlight).toHaveBeenCalledOnce();
  });

  it.each([
    "full",
    "already highlighted",
    "completed",
    "retired",
    "removed",
    "deleted",
    "not classic",
  ])("does not write when the goal or list is %s", async (state) => {
    const { run, post, subreddit, reddit, checks, values } = fixture();
    switch (state) {
      case "full":
        subreddit.getHighlightedPosts.mockResolvedValue(
          Array.from({ length: 6 }, (_, index) => ({
            postId: `t3_post${index}`,
          })),
        );
        break;
      case "already highlighted":
        subreddit.getHighlightedPosts.mockResolvedValue([{ postId }]);
        break;
      case "completed":
        vi.mocked(getSubGoalData).mockResolvedValueOnce({
          ...goal,
          completedTime: atMinute(1),
        } as Awaited<ReturnType<typeof getSubGoalData>>);
        break;
      case "retired":
        values.set(`${retiredSubscriberGoalKeyPrefix}:${postId}`, "retired");
        break;
      case "removed":
        post.removed = true;
        break;
      case "deleted":
        reddit.getPostById.mockRejectedValueOnce(
          Object.assign(new Error("Not Found"), { status: 404 }),
        );
        break;
      case "not classic":
        vi.mocked(getSubGoalData).mockResolvedValueOnce({
          ...goal,
          postKind: subscribeOnlyPostKind,
        } as Awaited<ReturnType<typeof getSubGoalData>>);
        break;
    }
    await run(15);
    expect(post.highlight).not.toHaveBeenCalled();
    expect(checks.has(postId)).toBe(false);
  });

  it("keeps a check on log read failure and drops it an hour after it was due", async () => {
    const { run, getLog, post, checks, watchDisplacement } = fixture();
    getLog.mockRejectedValue(new Error("moderation log unavailable"));
    await run(15);
    await run(74);
    expect(checks.has(postId)).toBe(true);
    await run(75);
    expect(checks.has(postId)).toBe(false);
    expect(watchDisplacement).toHaveBeenCalledExactlyOnceWith(
      scheduledPostDisplacementKey,
    );
    expect(getLog).toHaveBeenCalledTimes(2);
    expect(post.highlight).not.toHaveBeenCalled();
  });

  it("leaves a newer unpin queued when it arrives during a log read", async () => {
    const { run, getLog, post, checks } = fixture();
    getLog.mockImplementationOnce(async () => {
      checks.set(postId, String(atMinute(15)));
      return [logEntry(0)];
    });
    await run(15);
    expect(checks.get(postId)).toBe(String(atMinute(15)));
    expect(post.highlight).not.toHaveBeenCalled();
  });

  it("does not repeat a highlight attempt after a write error", async () => {
    const { run, getLog, post, checks } = fixture();
    post.highlight.mockRejectedValueOnce(new Error("highlight write failed"));
    await run(15);
    await run(16);
    expect(post.highlight).toHaveBeenCalledOnce();
    expect(getLog).toHaveBeenCalledOnce();
    expect(checks.has(postId)).toBe(false);
  });
});
