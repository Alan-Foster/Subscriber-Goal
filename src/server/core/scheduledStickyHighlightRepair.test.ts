import type { ModAction } from "@devvit/reddit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logDiagnostic } from "../../shared/diagnostics";
import { getSubGoalData } from "../data/subGoalData";
import type { RedditClient, RedisClient } from "../types";
import { communityHighlightLimit } from "../utils/communityHighlights";
import { retiredSubscriberGoalKeyPrefix } from "./postRetirement";
import { processScheduledStickyHighlightRepair } from "./scheduledStickyHighlightRepair";

vi.mock("../../shared/diagnostics", () => ({ logDiagnostic: vi.fn() }));
vi.mock("../data/subGoalData", () => ({ getSubGoalData: vi.fn() }));

const start = Date.parse("2026-11-17T20:00:00Z");
const time = (minutes: number) => start + minutes * 60_000;
const goalId = "t3_goal";
const publishedId = "t3_recurring";
const appUser = { id: "t2_app", username: "subscriber-goal" };
const subredditId = "t5_current";

function entry(
  type: ModAction["type"],
  minute: number,
  postId: string,
  overrides: Partial<ModAction> = {},
): ModAction {
  return {
    id: `${type}_${minute}_${postId}`,
    type,
    createdAt: new Date(time(minute)),
    moderatorId: "t2_mod",
    moderatorName: "ScheduleCreator",
    subredditId,
    subredditName: "ExampleSub",
    target: { id: postId },
    ...(type === "unsticky" ? { details: "[highlight] replaced" } : {}),
    ...overrides,
  };
}

function fixture(entries: ModAction[] = []) {
  let nowMs = start;
  const values = new Map<string, { value: string; expiration?: Date }>();
  const get = vi.fn(async (key: string) => {
    const item = values.get(key);
    return item && (!item.expiration || item.expiration.getTime() > nowMs)
      ? item.value
      : undefined;
  });
  const redis = {
    get,
    set: vi.fn(
      async (
        key: string,
        value: string,
        options?: { nx?: boolean; expiration?: Date },
      ) => {
        if (!options?.nx || !(await get(key)))
          values.set(key, { value, expiration: options?.expiration });
      },
    ),
    del: vi.fn(async (key: string) => values.delete(key)),
  };
  const goalPost = {
    id: goalId,
    subredditId,
    authorId: appUser.id,
    createdAt: new Date(time(-60)),
    removed: false,
    highlight: vi.fn(),
  };
  const publication = {
    id: publishedId,
    subredditId,
    createdAt: new Date(time(10)),
  };
  const subreddit = {
    id: subredditId,
    name: "ExampleSub",
    numberOfSubscribers: 100,
    getHighlightedPosts: vi.fn().mockResolvedValue([{ postId: publishedId }]),
    reorderHighlightedPosts: vi.fn(),
  };
  const reddit = {
    getModerationLog: vi.fn(async function* ({
      type,
    }: {
      type: ModAction["type"];
    }) {
      yield* entries.filter((action) => action.type === type);
    }),
    getAppUser: vi.fn().mockResolvedValue(appUser),
    getPostById: vi.fn(async (id: string) =>
      id === publishedId ? publication : id === goalId ? goalPost : undefined,
    ),
    sendModMail: vi.fn(),
  };
  const scan = (
    minute: number,
    repairEnabled = true,
    capturePlaytestEvidence = false,
  ) => {
    nowMs = time(minute);
    return processScheduledStickyHighlightRepair({
      reddit: reddit as unknown as RedditClient,
      redis: redis as unknown as RedisClient,
      subreddit: subreddit as unknown as Parameters<
        typeof processScheduledStickyHighlightRepair
      >[0]["subreddit"],
      repairEnabled,
      capturePlaytestEvidence,
      nowMs,
    });
  };
  return { entries, scan, goalPost, publication, subreddit, reddit, redis };
}

const qualifyingEntries = () => [
  entry("unsticky", 0, goalId),
  entry("sticky", 10, publishedId),
  entry("submit_scheduled_post", 10, publishedId),
];

describe("scheduled Sticky highlight repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSubGoalData).mockResolvedValue({
      goal: 200,
      completedTime: 0,
    } as Awaited<ReturnType<typeof getSubGoalData>>);
  });

  it("repairs only the replaced goal 15 minutes after its unpin, with a publication 10 minutes later", async () => {
    const { scan, goalPost, subreddit, reddit } = fixture([
      ...qualifyingEntries(),
      entry("unsticky", 0, "t3_other", {
        target: { id: "t3_other", author: "OtherUser" },
      }),
    ]);

    await scan(10);
    expect(goalPost.highlight).not.toHaveBeenCalled();
    await scan(15);

    expect(goalPost.highlight).toHaveBeenCalledOnce();
    expect(subreddit.reorderHighlightedPosts).not.toHaveBeenCalled();
    expect(reddit.sendModMail).not.toHaveBeenCalled();
    expect(logDiagnostic).toHaveBeenCalledWith(
      "info",
      "scheduled_sticky_repair_applied",
      expect.objectContaining({
        postId: goalId,
        publishedPostId: publishedId,
        unpinAt: time(0),
        publishedAt: time(10),
      }),
    );
  });

  it.each(["unsticky", "submit_scheduled_post"])(
    "matches late %s entries on overlapping scans",
    async (lateType) => {
      const inputs = qualifyingEntries();
      const { scan, goalPost, entries, reddit } = fixture(
        inputs.filter(({ type }) => type !== lateType),
      );
      await scan(15);
      expect(goalPost.highlight).not.toHaveBeenCalled();

      entries.push(
        entry("unsticky", -40, "t3_expired"),
        ...inputs.filter(({ type }) => type === lateType),
      );
      const reads = reddit.getModerationLog.mock.calls.length;
      await scan(16);
      expect(reddit.getModerationLog).toHaveBeenCalledTimes(reads);
      await scan(20);
      expect(goalPost.highlight).toHaveBeenCalledOnce();
    },
  );

  it("deduplicates Sticky and Highlight rows, repeat scans, and a subsequent unpin for the same publication", async () => {
    const { scan, goalPost, entries, subreddit } = fixture([
      ...qualifyingEntries(),
      entry("unsticky", 0, goalId, {
        id: "traditional_unpin",
        details: "replaced",
      }),
      entry("sticky", 10, publishedId, {
        id: "highlight_pin",
        details: "[highlight]",
      }),
    ]);
    const otherHighlights = [{ postId: publishedId }, { postId: "t3_other" }];
    let highlights = [...otherHighlights];
    subreddit.getHighlightedPosts.mockImplementation(async () => highlights);
    goalPost.highlight.mockImplementation(async () => {
      highlights = [...highlights, { postId: goalId }];
    });
    await scan(15);
    expect(highlights).toEqual([...otherHighlights, { postId: goalId }]);
    highlights = [...otherHighlights];
    entries.unshift(entry("unsticky", 15, goalId));
    await scan(20);
    await scan(30);
    await scan(35);
    expect(goalPost.highlight).toHaveBeenCalledOnce();
    expect(highlights).toEqual(otherHighlights);
    expect(subreddit.reorderHighlightedPosts).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no matching publication",
      [entry("unsticky", 0, goalId), entry("sticky", 10, publishedId)],
    ],
    [
      "schedule creation, editing, or deletion",
      [
        entry("unsticky", 0, goalId),
        entry("sticky", 10, publishedId),
        entry("edit_scheduled_post", 10, publishedId),
        entry("create_scheduled_post", 10, publishedId),
        entry("delete_scheduled_post", 10, publishedId),
      ],
    ],
    [
      "a submission without a post target",
      [
        entry("unsticky", 0, goalId),
        entry("sticky", 10, publishedId),
        entry("submit_scheduled_post", 10, publishedId, { target: undefined }),
      ],
    ],
    [
      "a future occurrence",
      [
        entry("unsticky", 0, goalId),
        entry("sticky", 10, publishedId),
        entry("submit_scheduled_post", 10, "t3_next"),
      ],
    ],
    [
      "an unpin more than 15 minutes from publication",
      [...qualifyingEntries().slice(1), entry("unsticky", -6, goalId)],
    ],
    [
      "a different moderator",
      [
        ...qualifyingEntries().slice(1),
        entry("unsticky", 0, goalId, { moderatorId: "t2_other" }),
      ],
    ],
    [
      "a different subreddit",
      [
        ...qualifyingEntries().slice(1),
        entry("unsticky", 0, goalId, { subredditId: "t5_elsewhere" }),
      ],
    ],
  ] as const)("does not act on %s", async (_label, entries) => {
    const { scan, goalPost } = fixture([...entries]);
    await scan(20);
    expect(goalPost.highlight).not.toHaveBeenCalled();
  });

  it("accepts an unpin after the verified publication", async () => {
    const { scan, goalPost } = fixture([
      ...qualifyingEntries().slice(1),
      entry("unsticky", 12, goalId),
    ]);
    await scan(27);
    expect(goalPost.highlight).toHaveBeenCalledOnce();
  });

  it("does not treat a submission record for an older post as a new publication", async () => {
    const { scan, goalPost, publication } = fixture(qualifyingEntries());
    publication.createdAt = new Date(time(-10));
    await scan(20);
    expect(goalPost.highlight).not.toHaveBeenCalled();
  });

  it.each([
    "already highlighted",
    "full",
    "completed",
    "retired",
    "deleted",
    "removed",
    "foreign post",
    "foreign author",
  ])(
    "skips a goal that is %s without changing other highlights or sending Modmail",
    async (state) => {
      const { scan, goalPost, subreddit, reddit, redis } =
        fixture(qualifyingEntries());
      switch (state) {
        case "already highlighted":
          subreddit.getHighlightedPosts.mockResolvedValue([{ postId: goalId }]);
          break;
        case "full":
          subreddit.getHighlightedPosts.mockResolvedValue(
            Array.from({ length: communityHighlightLimit }, (_, index) => ({
              postId: `t3_other${index}`,
            })),
          );
          break;
        case "completed":
          vi.mocked(getSubGoalData).mockResolvedValueOnce({
            goal: 200,
            completedTime: time(12),
          } as Awaited<ReturnType<typeof getSubGoalData>>);
          break;
        case "retired":
          await redis.set(
            `${retiredSubscriberGoalKeyPrefix}:${goalId}`,
            "retired",
          );
          break;
        case "deleted":
          reddit.getPostById.mockImplementation(async (id) =>
            id === goalId
              ? undefined
              : { id, subredditId, createdAt: new Date(time(10)) },
          );
          break;
        case "removed":
          goalPost.removed = true;
          break;
        case "foreign post":
          goalPost.subredditId = "t5_elsewhere";
          break;
        case "foreign author":
          goalPost.authorId = "t2_moderator";
          break;
      }

      await scan(15);
      if (state === "full" || state === "already highlighted") {
        subreddit.getHighlightedPosts.mockResolvedValue([]);
        await scan(20);
      }
      expect(goalPost.highlight).not.toHaveBeenCalled();
      expect(subreddit.reorderHighlightedPosts).not.toHaveBeenCalled();
      expect(reddit.sendModMail).not.toHaveBeenCalled();
    },
  );

  it("logs the evidence in observation mode and leaves highlights untouched", async () => {
    const { scan, goalPost, subreddit } = fixture(qualifyingEntries());
    await scan(15, false);
    expect(goalPost.highlight).not.toHaveBeenCalled();
    expect(subreddit.getHighlightedPosts).not.toHaveBeenCalled();
    expect(logDiagnostic).toHaveBeenCalledWith(
      "info",
      "scheduled_sticky_repair_candidate",
      expect.objectContaining({
        postId: goalId,
        publishedPostId: publishedId,
        unpinAt: time(0),
        publishedAt: time(10),
      }),
    );
  });

  it("captures scheduled submission metadata even when there is no unpin in playtest", async () => {
    const { scan, goalPost } = fixture([
      entry("submit_scheduled_post", 10, publishedId, {
        target: undefined,
        description: "Submit scheduled post",
        details: "Next weekly occurrence",
      }),
    ]);
    await scan(15, false, true);
    expect(goalPost.highlight).not.toHaveBeenCalled();
    expect(logDiagnostic).toHaveBeenCalledWith(
      "info",
      "scheduled_sticky_playtest_scan",
      expect.objectContaining({
        unpinEntries: 0,
        stickyEntries: 0,
        submissionEntries: 1,
      }),
    );
    expect(logDiagnostic).toHaveBeenCalledWith(
      "info",
      "scheduled_sticky_playtest_action",
      expect.objectContaining({
        action: "submit_scheduled_post",
        actionAt: time(10),
        moderatorId: "t2_mod",
        targetId: undefined,
        description: "Submit scheduled post",
        details: "Next weekly occurrence",
        category: "no_post_target",
      }),
    );
  });

  it("reports individual mismatches in the playtest without writing a highlight", async () => {
    const { scan, goalPost } = fixture([
      ...qualifyingEntries().slice(1),
      entry("unsticky", 0, goalId, { details: "[highlight]" }),
      entry("unsticky", 1, goalId, { moderatorId: "t2_other" }),
      entry("unsticky", -6, goalId),
      entry("submit_scheduled_post", 11, "t3_automod", {
        moderatorName: "AutoModerator",
      }),
      entry("sticky", 11, "t3_automod", { moderatorName: "AutoModerator" }),
      entry("submit_scheduled_post", 11, "t3_missing"),
      entry("submit_scheduled_post", 11, "t3_actor"),
      entry("sticky", 11, "t3_actor", { moderatorId: "t2_other" }),
      entry("submit_scheduled_post", 11, "t3_time"),
      entry("sticky", -5, "t3_time"),
    ]);
    await scan(20, false, true);
    expect(goalPost.highlight).not.toHaveBeenCalled();
    expect(logDiagnostic).not.toHaveBeenCalledWith(
      "info",
      "scheduled_sticky_repair_candidate",
      expect.anything(),
    );
    for (const category of [
      "missing_replacement_detail",
      "unpin_actor_mismatch",
      "unpin_timestamp_mismatch",
    ]) {
      expect(logDiagnostic).toHaveBeenCalledWith(
        "info",
        "scheduled_sticky_unpin_unverified",
        expect.objectContaining({ category }),
      );
    }
    for (const category of [
      "automoderator",
      "sticky_target_mismatch",
      "sticky_actor_mismatch",
      "sticky_timestamp_mismatch",
    ]) {
      expect(logDiagnostic).toHaveBeenCalledWith(
        "info",
        "scheduled_sticky_publication_unverified",
        expect.objectContaining({ category }),
      );
    }
  });

  it("retries once the next scan is due after a log read failure", async () => {
    const { scan, goalPost, reddit } = fixture(qualifyingEntries());
    reddit.getModerationLog.mockImplementationOnce(() => {
      throw new Error("log API unavailable");
    });
    await expect(scan(15)).rejects.toThrow("log API unavailable");
    await scan(20);
    expect(goalPost.highlight).toHaveBeenCalledOnce();
  });
});
