import { FakeRedisImpl, Gate } from "../testing/faultHarness";
import { dispatchDueJobs } from "../jobs/runner";
import { dueJobsKey } from "../jobs/queue";
import { displacementPendingKey } from "../data/scheduledPostDisplacementQueue";
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
  createScheduledPostDisplacementJob,
  recordScheduledPostDisplacementCheck,
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
  const redis = new FakeRedisImpl();
  redis.hashes.set(scheduledPostDisplacementKey, checks);
  const saveLock = redis.set.bind(redis);
  vi.spyOn(redis, "set").mockImplementation((key, value, options) =>
    saveLock(
      key,
      value,
      options?.nx === undefined ? undefined : { nx: options.nx },
    ),
  );
  const deleteCheck = vi.spyOn(redis, "hDel");
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
  const client = redis as unknown as RedisClient;
  const job = createScheduledPostDisplacementJob(
    reddit as unknown as RedditClient,
    client,
    subreddit as unknown as Parameters<
      typeof createScheduledPostDisplacementJob
    >[2],
  );
  const run = (minute: number) =>
    dispatchDueJobs(client, [job], { now: () => atMinute(minute) });
  return {
    checks,
    values: redis.strings,
    redis,
    client,
    job,
    deleteCheck,
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

  it("resumes a paged legacy migration and retains both original deadlines", async () => {
    const { redis, checks, run, post, getLog } = fixture();
    const second = "t3_second";
    checks.set(second, String(unpinnedAt));
    const scan = vi
      .spyOn(redis, "hScan")
      .mockResolvedValueOnce({
        cursor: 7,
        fieldValues: [{ field: postId, value: String(unpinnedAt) }],
      })
      .mockResolvedValueOnce({
        cursor: 0,
        fieldValues: [{ field: second, value: String(unpinnedAt) }],
      });
    await run(13);
    await run(14);
    expect(scan).toHaveBeenNthCalledWith(
      1,
      scheduledPostDisplacementKey,
      0,
      undefined,
      25,
    );
    expect(scan).toHaveBeenNthCalledWith(
      2,
      scheduledPostDisplacementKey,
      7,
      undefined,
      25,
    );
    expect(await redis.zScore(dueJobsKey, "scheduled_post_displacement")).toBe(
      atMinute(15),
    );
    expect(await redis.zScore(displacementPendingKey, postId)).toBe(
      atMinute(15),
    );
    expect(await redis.zScore(displacementPendingKey, second)).toBe(
      atMinute(15),
    );
    expect(getLog).not.toHaveBeenCalled();
    expect(checks.get(postId)).toBe(String(unpinnedAt));

    await run(15);
    await run(16);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(getLog).toHaveBeenCalledTimes(2);
    expect(post.highlight).toHaveBeenCalledOnce();
    expect(
      await redis.zScore(dueJobsKey, "scheduled_post_displacement"),
    ).toBeUndefined();
    expect(
      await redis.hGetAll("scheduled_post_displacement_job_v1_state"),
    ).toEqual({});
  });

  it("consumes a due check once across overlapping runner ticks", async () => {
    const { run, getLog, post } = fixture();
    const gate = new Gate();
    getLog.mockImplementationOnce(async () => {
      gate.arrive();
      await gate.released;
      return [logEntry(0)];
    });
    const first = run(15);
    try {
      await Promise.race([
        gate.reached,
        first.then(() => {
          throw new Error("Check did not start");
        }),
      ]);
      await run(15);
      expect(getLog).toHaveBeenCalledOnce();
    } finally {
      gate.release();
      await first;
    }
    await run(16);
    expect(post.highlight).toHaveBeenCalledOnce();
    expect(getLog).toHaveBeenCalledOnce();
  });

  it("retries an interrupted legacy scan without losing the unpin", async () => {
    const { redis, checks, run, getLog, post } = fixture();
    vi.spyOn(redis, "hScan").mockRejectedValueOnce(
      new Error("scan unavailable"),
    );
    expect((await run(14)).get("scheduled_post_displacement")).toBe("retry");
    expect(checks.get(postId)).toBe(String(unpinnedAt));
    expect(getLog).not.toHaveBeenCalled();
    await run(15);
    await run(16);
    expect(post.highlight).toHaveBeenCalledOnce();
    expect(checks.has(postId)).toBe(false);
  });

  it("keeps the next due check queued when a check spends the budget", async () => {
    const { checks, getLog, redis, client, job, run } = fixture();
    const second = "t3_second";
    checks.set(second, String(unpinnedAt));
    let now = atMinute(15);
    const deadlineMs = now + 1_000;
    getLog.mockImplementationOnce(async () => {
      now = deadlineMs;
      return [logEntry(0)];
    });
    await dispatchDueJobs(client, [job], { now: () => now, deadlineMs });
    expect(getLog).toHaveBeenCalledOnce();
    expect(checks.has(postId)).toBe(false);
    expect(checks.get(second)).toBe(String(unpinnedAt));
    expect(await redis.zScore(displacementPendingKey, second)).toBe(
      atMinute(15),
    );
    await run(16);
    expect(getLog).toHaveBeenCalledTimes(2);
    expect(checks.has(second)).toBe(false);
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
        values.set(`${retiredSubscriberGoalKeyPrefix}:${postId}`, {
          value: "retired",
        });
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
    const { run, getLog, post, checks, deleteCheck } = fixture();
    getLog.mockRejectedValue(new Error("moderation log unavailable"));
    await run(15);
    await run(74);
    expect(checks.has(postId)).toBe(true);
    await run(75);
    expect(checks.has(postId)).toBe(false);
    expect(deleteCheck).toHaveBeenCalledExactlyOnceWith(
      scheduledPostDisplacementKey,
      [postId],
    );
    expect(getLog).toHaveBeenCalledTimes(2);
    expect(post.highlight).not.toHaveBeenCalled();
  });

  it("leaves a newer unpin queued when it arrives during a log read", async () => {
    const { run, getLog, post, checks, client, redis } = fixture();
    getLog.mockImplementationOnce(async () => {
      await recordScheduledPostDisplacementCheck(
        client,
        postId,
        new Date(atMinute(15)).toISOString(),
      );
      return [logEntry(0)];
    });
    await run(15);
    expect(checks.get(postId)).toBe(String(atMinute(15)));
    expect(await redis.zScore(displacementPendingKey, postId)).toBe(
      atMinute(30),
    );
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
