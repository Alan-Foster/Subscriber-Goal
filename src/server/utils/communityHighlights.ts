import type { HighlightLabelType, HighlightedPostInfo } from "@devvit/reddit";
import { logDiagnostic } from "../../shared/diagnostics";
import type { LinkId, RedditClient } from "../types";

export const communityHighlightLimit = 6;
export const highlightVerificationMaxWaitMs = 30_000;
export const highlightVerificationIntervalMs = 5_000;

export type HighlightFailureCategory =
  | "capacity"
  | "write"
  | "verification"
  | "cleanup"
  | "rollback"
  | "concurrency"
  | "reorder";

export type HighlightIssue = {
  category: HighlightFailureCategory;
  message: string;
  postId?: LinkId;
};

export type HighlightResult = {
  status: "highlighted" | "not_highlighted";
  selectedPostId: LinkId;
  verifiedHighlighted: boolean;
  failureCategory?: HighlightFailureCategory;
  errorMessage?: string;
  issues: HighlightIssue[];
  capacityOutcome:
    | "not_needed"
    | "slot_available"
    | "managed_slot_freed"
    | "blocked"
    | "concurrent_change";
  cleanupOutcome: "not_needed" | "completed" | "failed";
  removedManagedHighlightIds: LinkId[];
  preservedHighlightIds: LinkId[];
  rollbackOutcome: "not_needed" | "restored" | "failed";
  reorderOutcome: "not_attempted" | "reordered" | "failed";
};

export type HighlightVerificationOptions = {
  maxWaitMs: number;
  intervalMs: number;
};

type HighlightablePost = {
  id: LinkId;
  highlight: (options?: {
    highlightUntil?: Date;
    highlightLabelType?: HighlightLabelType;
  }) => Promise<void>;
  unhighlight?: () => Promise<void>;
  isHighlighted?: () => Promise<boolean>;
};

type HighlightableSubreddit = {
  name: string;
  getHighlightedPosts: () => Promise<HighlightedPostInfo[]>;
  reorderHighlightedPosts: (postIds: readonly LinkId[]) => Promise<void>;
};

type RemovedHighlight = {
  info: HighlightedPostInfo;
  post: HighlightablePost;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function idsOf(snapshot: HighlightedPostInfo[]): LinkId[] {
  return snapshot.map(({ postId }) => postId as LinkId);
}

function sameOrder(
  actual: readonly LinkId[],
  expected: readonly LinkId[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((postId, index) => postId === expected[index])
  );
}

function resultWithIssues(
  result: Omit<HighlightResult, "failureCategory" | "errorMessage">,
): HighlightResult {
  const firstIssue = result.issues[0];
  return {
    ...result,
    ...(firstIssue
      ? {
          failureCategory: firstIssue.category,
          errorMessage: result.issues.map(({ message }) => message).join(" "),
        }
      : {}),
  };
}

export function createFailedHighlightResult(
  selectedPostId: LinkId,
  category: HighlightFailureCategory,
  message: string,
): HighlightResult {
  return resultWithIssues({
    status: "not_highlighted",
    selectedPostId,
    verifiedHighlighted: false,
    issues: [{ category, message, postId: selectedPostId }],
    capacityOutcome: "not_needed",
    cleanupOutcome: "not_needed",
    removedManagedHighlightIds: [],
    preservedHighlightIds: [],
    rollbackOutcome: "not_needed",
    reorderOutcome: "not_attempted",
  });
}

export async function getCommunityHighlights(
  subreddit: HighlightableSubreddit,
): Promise<HighlightedPostInfo[]> {
  return subreddit.getHighlightedPosts();
}

async function pollForState(
  subreddit: HighlightableSubreddit,
  post: HighlightablePost,
  expectedHighlighted: boolean,
  options: HighlightVerificationOptions,
): Promise<{
  matches: boolean;
  snapshot: HighlightedPostInfo[];
  errorMessage?: string;
}> {
  const startedAt = Date.now();
  let lastSnapshot: HighlightedPostInfo[] = [];
  let lastError: string | undefined;
  while (true) {
    try {
      lastSnapshot = await subreddit.getHighlightedPosts();
      const listed = lastSnapshot.some(({ postId }) => postId === post.id);
      const postState =
        typeof post.isHighlighted === "function"
          ? await post.isHighlighted()
          : listed;
      if (listed === expectedHighlighted && postState === expectedHighlighted) {
        return { matches: true, snapshot: lastSnapshot };
      }
    } catch (error) {
      lastError = toErrorMessage(error);
      logDiagnostic(
        "warn",
        "highlight_operation_failed",
        {
          workflow: "community_highlights",
          phase: expectedHighlighted ? "verification" : "removal_verification",
          postId: post.id,
        },
        error,
      );
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= options.maxWaitMs) break;
    await sleep(Math.min(options.intervalMs, options.maxWaitMs - elapsedMs));
  }
  return {
    matches: false,
    snapshot: lastSnapshot,
    ...(lastError ? { errorMessage: lastError } : {}),
  };
}

async function reorderTargetFirst(
  subreddit: HighlightableSubreddit,
  targetPostId: LinkId,
): Promise<{ outcome: "reordered" | "failed"; issue?: HighlightIssue }> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const current = await subreddit.getHighlightedPosts();
      if (!current.some(({ postId }) => postId === targetPostId)) {
        throw new Error(
          "The selected Subscriber Goal is no longer highlighted.",
        );
      }
      const intendedOrder = [
        targetPostId,
        ...idsOf(current).filter((postId) => postId !== targetPostId),
      ];
      await subreddit.reorderHighlightedPosts(intendedOrder);
      const verifiedOrder = idsOf(await subreddit.getHighlightedPosts());
      if (sameOrder(verifiedOrder, intendedOrder)) {
        return { outcome: "reordered" };
      }
      throw new Error("Reddit did not confirm the requested highlight order.");
    } catch (error) {
      logDiagnostic(
        "warn",
        "highlight_operation_failed",
        {
          workflow: "community_highlights",
          phase: "reorder",
          postId: targetPostId,
          attempt,
        },
        error,
      );
      if (attempt === 2) {
        return {
          outcome: "failed",
          issue: {
            category: "reorder",
            postId: targetPostId,
            message:
              "The Subscriber Goal is highlighted, but it could not be verified in the first position.",
          },
        };
      }
    }
  }
  return { outcome: "failed" };
}

async function restoreRemovedHighlights(
  subreddit: HighlightableSubreddit,
  removed: RemovedHighlight[],
  originalOrder: LinkId[],
  options: HighlightVerificationOptions,
): Promise<"not_needed" | "restored" | "failed"> {
  if (removed.length === 0) return "not_needed";
  try {
    for (const { info, post } of removed) {
      const current = await subreddit.getHighlightedPosts();
      if (current.some(({ postId }) => postId === info.postId)) continue;
      if (current.length >= communityHighlightLimit) return "failed";
      await post.highlight({
        ...(info.highlightedUntil
          ? { highlightUntil: info.highlightedUntil }
          : {}),
        ...(info.highlightLabel
          ? { highlightLabelType: info.highlightLabel }
          : {}),
      });
      if (!(await pollForState(subreddit, post, true, options)).matches) {
        return "failed";
      }
    }
    const current = await subreddit.getHighlightedPosts();
    const currentIds = new Set(idsOf(current));
    const restoredOrder = [
      ...originalOrder.filter((postId) => currentIds.has(postId)),
      ...idsOf(current).filter((postId) => !originalOrder.includes(postId)),
    ];
    await subreddit.reorderHighlightedPosts(restoredOrder);
    return sameOrder(
      idsOf(await subreddit.getHighlightedPosts()),
      restoredOrder,
    )
      ? "restored"
      : "failed";
  } catch (error) {
    logDiagnostic(
      "error",
      "highlight_operation_failed",
      { workflow: "community_highlights", phase: "rollback" },
      error,
    );
    return "failed";
  }
}

async function fetchHighlightablePost(
  reddit: RedditClient,
  postId: LinkId,
): Promise<HighlightablePost> {
  return (await reddit.getPostById(postId)) as unknown as HighlightablePost;
}

export async function highlightAndVerifyPost(
  reddit: RedditClient,
  subreddit: HighlightableSubreddit,
  post: HighlightablePost,
  options: HighlightVerificationOptions & {
    removableManagedPostIds?: readonly LinkId[];
  },
): Promise<HighlightResult> {
  const initial = await subreddit.getHighlightedPosts();
  const originalOrder = idsOf(initial);
  const removableIds = new Set(options.removableManagedPostIds ?? []);
  const removed: RemovedHighlight[] = [];
  const issues: HighlightIssue[] = [];
  let capacityOutcome: HighlightResult["capacityOutcome"] = "not_needed";
  let cleanupOutcome: HighlightResult["cleanupOutcome"] = "not_needed";
  let rollbackOutcome: HighlightResult["rollbackOutcome"] = "not_needed";

  let current = await subreddit.getHighlightedPosts();
  let targetPresent = current.some(({ postId }) => postId === post.id);

  if (!targetPresent) {
    capacityOutcome =
      current.length < communityHighlightLimit ? "slot_available" : "blocked";
    if (current.length >= communityHighlightLimit) {
      const removableInfo = current.find(({ postId }) =>
        removableIds.has(postId),
      );
      if (!removableInfo) {
        issues.push({
          category: "capacity",
          postId: post.id,
          message:
            "All six Community Highlight slots are occupied and no obsolete classic Subscriber Goal can be safely removed.",
        });
        return resultWithIssues({
          status: "not_highlighted",
          selectedPostId: post.id,
          verifiedHighlighted: false,
          issues,
          capacityOutcome,
          cleanupOutcome,
          removedManagedHighlightIds: [],
          preservedHighlightIds: originalOrder,
          rollbackOutcome,
          reorderOutcome: "not_attempted",
        });
      }

      try {
        const removablePost = await fetchHighlightablePost(
          reddit,
          removableInfo.postId as LinkId,
        );
        if (typeof removablePost.unhighlight !== "function") {
          throw new Error(
            `Unable to safely remove obsolete Community Highlight ${removableInfo.postId}.`,
          );
        }
        await removablePost.unhighlight();
        const removal = await pollForState(
          subreddit,
          removablePost,
          false,
          options,
        );
        if (
          !removal.matches ||
          removal.snapshot.length >= communityHighlightLimit
        ) {
          if (
            !removal.snapshot.some(
              ({ postId }) => postId === removableInfo.postId,
            )
          ) {
            removed.push({ info: removableInfo, post: removablePost });
          }
          throw new Error(
            `Reddit did not confirm that obsolete Community Highlight ${removableInfo.postId} freed a slot.`,
          );
        }
        removed.push({ info: removableInfo, post: removablePost });
        cleanupOutcome = "completed";
        current = removal.snapshot;
        capacityOutcome = "managed_slot_freed";
      } catch (error) {
        issues.push({
          category: "cleanup",
          postId: removableInfo.postId as LinkId,
          message: toErrorMessage(error),
        });
        rollbackOutcome = await restoreRemovedHighlights(
          subreddit,
          removed,
          originalOrder,
          options,
        );
        if (rollbackOutcome === "failed") {
          issues.push({
            category: "rollback",
            message:
              "The obsolete Community Highlight could not be safely restored.",
          });
        }
        return resultWithIssues({
          status: "not_highlighted",
          selectedPostId: post.id,
          verifiedHighlighted: false,
          issues,
          capacityOutcome: "blocked",
          cleanupOutcome: "failed",
          removedManagedHighlightIds: removed.map(
            ({ info }) => info.postId as LinkId,
          ),
          preservedHighlightIds: idsOf(await subreddit.getHighlightedPosts()),
          rollbackOutcome,
          reorderOutcome: "not_attempted",
        });
      }
    }

    // This is the last non-atomic capacity check available before Reddit writes.
    current = await subreddit.getHighlightedPosts();
    if (current.length >= communityHighlightLimit) {
      capacityOutcome = "concurrent_change";
      issues.push({
        category: "concurrency",
        postId: post.id,
        message:
          "Community Highlight capacity changed before the Subscriber Goal could be highlighted.",
      });
      rollbackOutcome = await restoreRemovedHighlights(
        subreddit,
        removed,
        originalOrder,
        options,
      );
      if (rollbackOutcome === "failed") {
        issues.push({
          category: "rollback",
          message:
            "The previously removed Community Highlight could not be safely restored.",
        });
      }
      return resultWithIssues({
        status: "not_highlighted",
        selectedPostId: post.id,
        verifiedHighlighted: false,
        issues,
        capacityOutcome,
        cleanupOutcome,
        removedManagedHighlightIds: removed.map(
          ({ info }) => info.postId as LinkId,
        ),
        preservedHighlightIds: idsOf(await subreddit.getHighlightedPosts()),
        rollbackOutcome,
        reorderOutcome: "not_attempted",
      });
    }

    const preWrite = current;
    let writeError: string | undefined;
    try {
      await post.highlight();
    } catch (error) {
      writeError = toErrorMessage(error);
      issues.push({ category: "write", postId: post.id, message: writeError });
      logDiagnostic(
        "warn",
        "highlight_operation_failed",
        { workflow: "community_highlights", phase: "write", postId: post.id },
        error,
      );
    }

    const verification = await pollForState(subreddit, post, true, options);
    targetPresent = verification.matches;
    if (!targetPresent) {
      if (!writeError) {
        issues.push({
          category: "verification",
          postId: post.id,
          message:
            verification.errorMessage ??
            "Reddit did not confirm the Community Highlight write.",
        });
      }
      rollbackOutcome = await restoreRemovedHighlights(
        subreddit,
        removed,
        originalOrder,
        options,
      );
      if (rollbackOutcome === "failed") {
        issues.push({
          category: "rollback",
          message:
            "The previously removed Community Highlight could not be safely restored.",
        });
      }
      return resultWithIssues({
        status: "not_highlighted",
        selectedPostId: post.id,
        verifiedHighlighted: false,
        issues,
        capacityOutcome,
        cleanupOutcome,
        removedManagedHighlightIds: removed.map(
          ({ info }) => info.postId as LinkId,
        ),
        preservedHighlightIds: idsOf(
          await subreddit.getHighlightedPosts(),
        ).filter((postId) => postId !== post.id),
        rollbackOutcome,
        reorderOutcome: "not_attempted",
      });
    }

    const afterWrite = verification.snapshot;
    const afterWriteIds = new Set(idsOf(afterWrite));
    const displaced = preWrite.filter(
      ({ postId }) => !afterWriteIds.has(postId),
    );
    if (displaced.length > 0) {
      capacityOutcome = "concurrent_change";
      issues.push({
        category: "concurrency",
        postId: post.id,
        message:
          "A concurrent Community Highlight change displaced an existing post; the Subscriber Goal was rolled back.",
      });
      const displacedPosts: RemovedHighlight[] = [];
      try {
        if (typeof post.unhighlight !== "function") {
          throw new Error(
            "The Subscriber Goal could not be removed during rollback.",
          );
        }
        await post.unhighlight();
        if (!(await pollForState(subreddit, post, false, options)).matches) {
          throw new Error("Reddit did not confirm Subscriber Goal rollback.");
        }
        for (const info of displaced) {
          displacedPosts.push({
            info,
            post: await fetchHighlightablePost(reddit, info.postId as LinkId),
          });
        }
        rollbackOutcome = await restoreRemovedHighlights(
          subreddit,
          [...removed, ...displacedPosts],
          originalOrder,
          options,
        );
      } catch (error) {
        rollbackOutcome = "failed";
        logDiagnostic(
          "error",
          "highlight_operation_failed",
          { workflow: "community_highlights", phase: "concurrent_rollback" },
          error,
        );
      }
      if (rollbackOutcome === "failed") {
        issues.push({
          category: "rollback",
          message:
            "The concurrently displaced Community Highlight could not be safely restored.",
        });
      }
      const finalSnapshot = await subreddit.getHighlightedPosts();
      const finalTargetPresent = finalSnapshot.some(
        ({ postId }) => postId === post.id,
      );
      return resultWithIssues({
        status: finalTargetPresent ? "highlighted" : "not_highlighted",
        selectedPostId: post.id,
        verifiedHighlighted: finalTargetPresent,
        issues,
        capacityOutcome,
        cleanupOutcome,
        removedManagedHighlightIds: removed.map(
          ({ info }) => info.postId as LinkId,
        ),
        preservedHighlightIds: idsOf(finalSnapshot).filter(
          (postId) => postId !== post.id,
        ),
        rollbackOutcome,
        reorderOutcome: "not_attempted",
      });
    }
  } else {
    const verification = await pollForState(subreddit, post, true, options);
    if (!verification.matches) {
      issues.push({
        category: "verification",
        postId: post.id,
        message: "Reddit did not confirm the existing Community Highlight.",
      });
      return resultWithIssues({
        status: "not_highlighted",
        selectedPostId: post.id,
        verifiedHighlighted: false,
        issues,
        capacityOutcome,
        cleanupOutcome,
        removedManagedHighlightIds: [],
        preservedHighlightIds: idsOf(verification.snapshot),
        rollbackOutcome,
        reorderOutcome: "not_attempted",
      });
    }
  }

  const cleanupSnapshot = await subreddit.getHighlightedPosts();
  const cleanupTargets = cleanupSnapshot.filter(
    ({ postId }) => postId !== post.id && removableIds.has(postId),
  );
  if (cleanupTargets.length > 0) cleanupOutcome = "completed";
  for (const info of cleanupTargets) {
    try {
      const obsoletePost = await fetchHighlightablePost(
        reddit,
        info.postId as LinkId,
      );
      if (typeof obsoletePost.unhighlight !== "function") {
        throw new Error(
          `Unable to remove obsolete Community Highlight ${info.postId}.`,
        );
      }
      await obsoletePost.unhighlight();
      if (
        !(await pollForState(subreddit, obsoletePost, false, options)).matches
      ) {
        throw new Error(
          `Reddit did not confirm removal of obsolete Community Highlight ${info.postId}.`,
        );
      }
      removed.push({ info, post: obsoletePost });
    } catch (error) {
      cleanupOutcome = "failed";
      issues.push({
        category: "cleanup",
        postId: info.postId as LinkId,
        message: toErrorMessage(error),
      });
      logDiagnostic(
        "warn",
        "highlight_operation_failed",
        {
          workflow: "community_highlights",
          phase: "obsolete_cleanup",
          postId: info.postId,
        },
        error,
      );
    }
  }

  const reorder = await reorderTargetFirst(subreddit, post.id);
  if (reorder.issue) issues.push(reorder.issue);
  const finalSnapshot = await subreddit.getHighlightedPosts();
  return resultWithIssues({
    status: "highlighted",
    selectedPostId: post.id,
    verifiedHighlighted: true,
    issues,
    capacityOutcome,
    cleanupOutcome,
    removedManagedHighlightIds: removed.map(
      ({ info }) => info.postId as LinkId,
    ),
    preservedHighlightIds: idsOf(finalSnapshot).filter(
      (postId) => postId !== post.id,
    ),
    rollbackOutcome,
    reorderOutcome: reorder.outcome,
  });
}
