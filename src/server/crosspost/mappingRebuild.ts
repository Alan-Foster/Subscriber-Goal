import { logDiagnostic } from "../../shared/diagnostics";
import {
  getCrosspostPendingByRevisionKey,
  parsePendingCrosspost,
} from "../data/crosspostData";
import {
  crosspostListByTimeKey,
  crosspostListKey,
  crosspostMappingRetentionMs,
  updateCrosspostMappings,
} from "../data/crosspostMappings";
import { isLinkId, type RedditClient, type RedisClient } from "../types";

// Keep the done marker for this migration until the rebuild is retired.
const rebuildKey = "crosspostMappingRebuildV1";
const progressKey = "crosspostMappingRebuildProgressV1";
const rebuildBatchSize = 25;

type Entry = { source: string; mirror: string; score: number };
const listingStopReasons = [
  "cutoff",
  "listing_exhausted",
  "cursor_stalled",
] as const;
type ListingStopReason = (typeof listingStopReasons)[number];
type Page = {
  entries: Entry[];
  next: string;
  phase: "listing" | "pending";
  oldestCrosspostMs?: number;
  listingStopReason?: ListingStopReason;
};
type Progress = {
  pagesRead: number;
  listingPagesRead: number;
  mappingsRestored: number;
  oldestCrosspostMs: number | undefined;
  listingStopReason: ListingStopReason | undefined;
};

export async function rebuildCrosspostMappings(
  reddit: RedditClient,
  redis: RedisClient,
  targetSubreddit: string,
  nowMs = Date.now(),
): Promise<void> {
  const state = await redis.get(rebuildKey);
  if (state === "done") return;
  const cutoff = nowMs - crosspostMappingRetentionMs;
  const page = state?.startsWith("pending:")
    ? await readPendingPage(
        redis,
        targetSubreddit,
        Number(state.slice(8)),
        cutoff,
      )
    : await readListingPage(reddit, targetSubreddit, state?.slice(8), cutoff);

  await commitPage(redis, targetSubreddit, state, page);
}

async function commitPage(
  redis: RedisClient,
  targetSubreddit: string,
  state: string | undefined,
  page: Page,
): Promise<void> {
  const committed: { progress?: Progress } = {};
  await updateCrosspostMappings(redis, async () => {
    if ((await redis.get(rebuildKey)) !== state) return;
    const [missing, saved] = await Promise.all([
      getMissingMappings(redis, page.entries),
      redis.hGetAll(progressKey),
    ]);
    const progress = advanceProgress(saved, page, missing.length);
    committed.progress = progress;
    return async (tx) => {
      if (missing.length > 0) {
        // WATCH + hMGet lets us insert only missing fields in a single hSet.
        await tx.hSet(
          crosspostListKey,
          Object.fromEntries(
            missing.map(({ source, mirror }) => [source, mirror]),
          ),
        );
        await tx.zAdd(
          crosspostListByTimeKey,
          ...missing.map(({ source, score }) => ({ member: source, score })),
        );
      }
      await tx.set(rebuildKey, page.next);
      if (page.next === "done") {
        await tx.del(progressKey);
      } else {
        await tx.hSet(progressKey, {
          pagesRead: String(progress.pagesRead),
          listingPagesRead: String(progress.listingPagesRead),
          mappingsRestored: String(progress.mappingsRestored),
          oldestCrosspostMs: String(progress.oldestCrosspostMs ?? ""),
          listingStopReason: progress.listingStopReason ?? "",
        });
      }
    };
  }, [rebuildKey, progressKey]);
  if (committed.progress) {
    logRebuildProgress(targetSubreddit, page, committed.progress);
  }
}

function oldestDate(
  previous: number | undefined,
  current: number | undefined,
): number | undefined {
  if (previous === undefined) return current;
  return current === undefined ? previous : Math.min(previous, current);
}

function advanceProgress(
  saved: Record<string, string>,
  page: Page,
  restored: number,
): Progress {
  const oldest = saved.oldestCrosspostMs
    ? new Date(Number(saved.oldestCrosspostMs)).getTime()
    : NaN;
  return {
    pagesRead: (Number(saved.pagesRead) || 0) + 1,
    listingPagesRead:
      (Number(saved.listingPagesRead) || 0) + Number(page.phase === "listing"),
    mappingsRestored: (Number(saved.mappingsRestored) || 0) + restored,
    oldestCrosspostMs: oldestDate(
      Number.isFinite(oldest) ? oldest : undefined,
      page.oldestCrosspostMs,
    ),
    listingStopReason:
      page.listingStopReason ??
      listingStopReasons.find((reason) => reason === saved.listingStopReason),
  };
}

function logRebuildProgress(
  targetSubreddit: string,
  page: Page,
  progress: Progress,
): void {
  const context = {
    workflow: "crosspost",
    targetSubreddit,
    pagesRead: progress.pagesRead,
    listingPagesRead: progress.listingPagesRead,
    mappingsRestored: progress.mappingsRestored,
    oldestCrosspostDate:
      progress.oldestCrosspostMs === undefined
        ? "none"
        : new Date(progress.oldestCrosspostMs).toISOString(),
    listingStopReason: progress.listingStopReason,
  };
  logDiagnostic("info", "crosspost_mapping_rebuild_page", {
    ...context,
    phase: page.phase,
  });
  if (page.next === "done") {
    logDiagnostic("info", "crosspost_mapping_rebuild_completed", context);
  }
}

async function getMissingMappings(redis: RedisClient, entries: Entry[]) {
  const bySource = new Map<string, Entry>();
  for (const entry of entries) {
    if (!bySource.has(entry.source)) bySource.set(entry.source, entry);
  }
  const unique = [...bySource.values()];
  if (unique.length === 0) return [];
  const mapped = await redis.hMGet(crosspostListKey, [...bySource.keys()]);
  return unique.filter((_, i) => mapped[i] == null);
}

async function readListingPage(
  reddit: RedditClient,
  subredditName: string,
  after: string | undefined,
  cutoff: number,
): Promise<Page> {
  const appUser = await reddit.getAppUser();
  if (!appUser)
    throw new Error(
      "Could not identify the app account for the crosspost rebuild.",
    );
  const listing = reddit.getNewPosts({
    subredditName,
    limit: rebuildBatchSize,
    pageSize: rebuildBatchSize,
    ...(after ? { after } : {}),
  });
  const entries: Entry[] = [];
  let lastId: string | undefined;
  let oldestCrosspostMs: number | undefined;
  for await (const post of listing) {
    const score = post.createdAt.getTime();
    const isAppCrosspost =
      post.authorId === appUser.id &&
      post.crosspostParentId &&
      isLinkId(post.crosspostParentId) &&
      isLinkId(post.id) &&
      Number.isFinite(score);
    if (isAppCrosspost)
      oldestCrosspostMs = oldestDate(oldestCrosspostMs, score);
    if (score < cutoff) {
      return {
        entries,
        phase: "listing",
        next: "pending:0",
        ...(oldestCrosspostMs === undefined ? {} : { oldestCrosspostMs }),
        listingStopReason: "cutoff",
      };
    }
    lastId = post.id;
    if (isAppCrosspost && post.crosspostParentId) {
      entries.push({ source: post.crosspostParentId, mirror: post.id, score });
    }
  }
  const page = {
    entries,
    phase: "listing" as const,
    ...(oldestCrosspostMs === undefined ? {} : { oldestCrosspostMs }),
  };
  if (listing.hasMore && lastId && lastId !== after) {
    return { ...page, next: `listing:${lastId}` };
  }
  return {
    ...page,
    next: "pending:0",
    listingStopReason:
      listing.hasMore && lastId ? "cursor_stalled" : "listing_exhausted",
  };
}

async function readPendingPage(
  redis: RedisClient,
  targetSubreddit: string,
  cursor: number,
  cutoff: number,
): Promise<Page> {
  const page = await redis.hScan(
    getCrosspostPendingByRevisionKey(targetSubreddit),
    cursor,
    undefined,
    rebuildBatchSize,
  );
  const pending = page.fieldValues.map(({ field, value }) =>
    parsePendingCrosspost(value, field),
  );
  const entries = pending.flatMap((item) =>
    item?.createdCrosspostId && item.firstSeenMs >= cutoff
      ? [
          {
            source: item.postId,
            mirror: item.createdCrosspostId,
            score: item.firstSeenMs,
          },
        ]
      : [],
  );
  return {
    entries,
    phase: "pending",
    next: page.cursor ? `pending:${page.cursor}` : "done",
  };
}
