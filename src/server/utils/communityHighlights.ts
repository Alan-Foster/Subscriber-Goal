import type { HighlightLabelType, HighlightedPostInfo } from "@devvit/reddit";
import { logDiagnostic } from "../../shared/diagnostics";
import type { LinkId, RedditClient } from "../types";
import { deadlineFrom, remainingMs } from "./timeBudget";

export const communityHighlightLimit = 6;
export const highlightVerificationMaxWaitMs = 8_000;
export const highlightVerificationIntervalMs = 500;
const highlightTotalBudgetMs = 8_000;
const requestCleanupReserveMs = 1_000;
const rollbackReserveMs = 2_000;
const budgetError = "Community Highlight verification ran out of time.";

export type HighlightFailureCategory =
  | "permission"
  | "post_state"
  | "capacity"
  | "write"
  | "verification"
  | "cleanup"
  | "rollback"
  | "concurrency";

export type HighlightIssue = {
  category: HighlightFailureCategory;
  message: string;
  postId?: LinkId;
};

export type HighlightResult = {
  status: "highlighted" | "not_highlighted";
  selectedPostId: LinkId;
  verifiedHighlighted: boolean;
  selectedPosition?: number;
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
  rollbackOutcome: "not_needed" | "restored" | "expired" | "failed";
};

export type HighlightVerificationOptions = {
  maxWaitMs: number;
  intervalMs: number;
  deadlineMs?: number;
};

type HighlightablePost = {
  id: LinkId;
  archived?: boolean;
  locked?: boolean;
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
};

type RemovedHighlight = {
  info: HighlightedPostInfo;
  post: HighlightablePost;
};

type TimedHighlightOptions = HighlightVerificationOptions & {
  budget: { deadlineMs: number; snapshot: HighlightedPostInfo[] };
};

function canContinue(options: TimedHighlightOptions, reserveMs = 0): boolean {
  return remainingMs(options.budget.deadlineMs, reserveMs) > 0;
}

function requireTime(options: TimedHighlightOptions): void {
  if (!canContinue(options)) throw new Error(budgetError);
}

async function readSnapshot(
  subreddit: HighlightableSubreddit,
  options: TimedHighlightOptions,
): Promise<HighlightedPostInfo[]> {
  if (canContinue(options)) {
    options.budget.snapshot = await subreddit.getHighlightedPosts();
  }
  return options.budget.snapshot;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function idsOf(snapshot: HighlightedPostInfo[]): LinkId[] {
  return snapshot.map(({ postId }) => postId);
}

function highlightMetadata(info: HighlightedPostInfo | undefined): {
  highlightLabel?: HighlightLabelType;
  highlightedUntil?: number;
} {
  return {
    ...(info?.highlightLabel ? { highlightLabel: info.highlightLabel } : {}),
    ...(info?.highlightedUntil
      ? { highlightedUntil: info.highlightedUntil.getTime() }
      : {}),
  };
}

function sameHighlightMetadata(
  expected: HighlightedPostInfo | undefined,
  actual: HighlightedPostInfo | undefined,
): boolean {
  const expectedMetadata = highlightMetadata(expected);
  const actualMetadata = highlightMetadata(actual);
  return (
    expectedMetadata.highlightLabel === actualMetadata.highlightLabel &&
    expectedMetadata.highlightedUntil === actualMetadata.highlightedUntil
  );
}

export function isArchivedPostMutationError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return /(?:post|thing).*(?:is|was) archived|archived posts? (?:cannot|can(?:not|'t))|cannot .* archived post/i.test(
    message,
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

export function isCapacityOnlyHighlightFailure(
  result: HighlightResult,
): boolean {
  return (
    result.issues.length > 0 &&
    result.issues.every(({ category }) => category === "capacity")
  );
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
  options: TimedHighlightOptions,
  reserveMs = 0,
): Promise<{
  matches: boolean;
  listed: boolean;
  snapshot: HighlightedPostInfo[];
  errorMessage?: string;
}> {
  if (typeof post.isHighlighted !== "function") {
    const snapshot = await readSnapshot(subreddit, options);
    return {
      matches: false,
      listed: snapshot.some(({ postId }) => postId === post.id),
      snapshot,
      errorMessage:
        "Reddit did not provide post.isHighlighted(), so the Community Highlight state could not be independently verified.",
    };
  }
  const waitDeadline = deadlineFrom(Date.now(), options.maxWaitMs);
  let lastError: string | undefined;
  while (canContinue(options, reserveMs)) {
    try {
      const snapshot = await readSnapshot(subreddit, options);
      if (!canContinue(options, reserveMs)) break;
      const listed = snapshot.some(({ postId }) => postId === post.id);
      const postState = await post.isHighlighted();
      if (listed === expectedHighlighted && postState === expectedHighlighted) {
        return { matches: true, listed, snapshot };
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
    const wait = Math.min(
      remainingMs(waitDeadline),
      remainingMs(options.budget.deadlineMs, reserveMs),
    );
    if (wait === 0) break;
    await sleep(Math.min(Math.max(1, options.intervalMs), wait));
  }
  const snapshot = options.budget.snapshot;
  return {
    matches: false,
    listed: snapshot.some(({ postId }) => postId === post.id),
    snapshot,
    ...(!canContinue(options, reserveMs)
      ? { errorMessage: budgetError }
      : lastError
        ? { errorMessage: lastError }
        : {}),
  };
}

async function restoreRemovedHighlights(
  subreddit: HighlightableSubreddit,
  removed: RemovedHighlight[],
  options: TimedHighlightOptions,
): Promise<"not_needed" | "restored" | "expired" | "failed"> {
  if (removed.length === 0) return "not_needed";
  let expired = false;
  try {
    for (const { info, post } of removed) {
      requireTime(options);
      const current = await readSnapshot(subreddit, options);
      if (!current.some(({ postId }) => postId === info.postId)) {
        if (
          info.highlightedUntil &&
          info.highlightedUntil.getTime() <= Date.now()
        ) {
          expired = true;
          continue;
        }
        if (current.length >= communityHighlightLimit) return "failed";
        if (typeof post.isHighlighted !== "function") return "failed";
        requireTime(options);
        await post.highlight({
          ...(info.highlightedUntil
            ? { highlightUntil: info.highlightedUntil }
            : {}),
          ...(info.highlightLabel
            ? { highlightLabelType: info.highlightLabel }
            : {}),
        });
      }
      const verification = await pollForState(subreddit, post, true, options);
      if (!verification.matches) return "failed";
      const restored = (await readSnapshot(subreddit, options)).find(
        ({ postId }) => postId === info.postId,
      );
      if (!restored || !sameHighlightMetadata(info, restored)) {
        logDiagnostic("warn", "highlight_metadata_changed", {
          workflow: "community_highlights",
          phase: "rollback_verification",
          postId: info.postId,
          expected: JSON.stringify(highlightMetadata(info)),
          actual: JSON.stringify(highlightMetadata(restored)),
        });
        return "failed";
      }
    }
    return expired ? "expired" : "restored";
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
  return await reddit.getPostById(postId);
}

async function rollbackUnverifiedReplacement(
  subreddit: HighlightableSubreddit,
  post: HighlightablePost,
  removed: RemovedHighlight[],
  options: TimedHighlightOptions,
): Promise<HighlightResult["rollbackOutcome"]> {
  try {
    if (typeof post.unhighlight !== "function") {
      throw new Error("Unable to remove an unverified Community Highlight.");
    }
    requireTime(options);
    await post.unhighlight();
    if (!(await pollForState(subreddit, post, false, options)).matches) {
      throw new Error(
        "Reddit did not confirm removal of the unverified Community Highlight.",
      );
    }
    return await restoreRemovedHighlights(subreddit, removed, options);
  } catch (error) {
    logDiagnostic(
      "error",
      "highlight_operation_failed",
      {
        workflow: "community_highlights",
        phase: "unverified_replacement_rollback",
        postId: post.id,
      },
      error,
    );
    return "failed";
  }
}

type HighlightAttemptOptions = Partial<HighlightVerificationOptions> & {
  removableManagedPostIds?: readonly LinkId[];
  rollbackUnverifiedReplacement?: boolean;
};

type HighlightAttempt = {
  reddit: RedditClient;
  subreddit: HighlightableSubreddit;
  post: HighlightablePost & Required<Pick<HighlightablePost, "isHighlighted">>;
  options: HighlightAttemptOptions & TimedHighlightOptions;
  initialIds: LinkId[];
  removableIds: ReadonlySet<LinkId>;
  removed: RemovedHighlight[];
  issues: HighlightIssue[];
  capacityOutcome: HighlightResult["capacityOutcome"];
  cleanupOutcome: HighlightResult["cleanupOutcome"];
  rollbackOutcome: HighlightResult["rollbackOutcome"];
};

export async function highlightAndVerifyPost(
  reddit: RedditClient,
  subreddit: HighlightableSubreddit,
  post: HighlightablePost,
  requested: HighlightAttemptOptions = {},
): Promise<HighlightResult> {
  const options = {
    ...requested,
    maxWaitMs: requested.maxWaitMs ?? highlightVerificationMaxWaitMs,
    intervalMs: requested.intervalMs ?? highlightVerificationIntervalMs,
    budget: {
      deadlineMs: Math.min(
        deadlineFrom(Date.now(), highlightTotalBudgetMs),
        (requested.deadlineMs ?? Infinity) - requestCleanupReserveMs,
      ),
      snapshot: [] as HighlightedPostInfo[],
    },
  };
  if (!canContinue(options))
    return createFailedHighlightResult(post.id, "verification", budgetError);
  const initial = await readSnapshot(subreddit, options);
  const initialIds = idsOf(initial);
  const removableIds = new Set(options.removableManagedPostIds ?? []);
  const removed: RemovedHighlight[] = [];
  const issues: HighlightIssue[] = [];
  const capacityOutcome: HighlightResult["capacityOutcome"] = "not_needed";
  const cleanupOutcome: HighlightResult["cleanupOutcome"] = "not_needed";
  const rollbackOutcome: HighlightResult["rollbackOutcome"] = "not_needed";

  const current = await readSnapshot(subreddit, options);
  if (!canContinue(options))
    return createFailedHighlightResult(post.id, "verification", budgetError);
  const targetPresent = current.some(({ postId }) => postId === post.id);

  if (typeof post.isHighlighted !== "function") {
    issues.push({
      category: "verification",
      postId: post.id,
      message:
        "Reddit did not provide post.isHighlighted(), so no Community Highlight changes were attempted.",
    });
    return resultWithIssues({
      status: targetPresent ? "highlighted" : "not_highlighted",
      selectedPostId: post.id,
      verifiedHighlighted: false,
      issues,
      capacityOutcome,
      cleanupOutcome,
      removedManagedHighlightIds: [],
      preservedHighlightIds: idsOf(current).filter(
        (postId) => postId !== post.id,
      ),
      rollbackOutcome,
    });
  }

  const attempt: HighlightAttempt = {
    reddit,
    subreddit,
    post: post as HighlightAttempt["post"],
    options,
    initialIds,
    removableIds,
    removed,
    issues,
    capacityOutcome,
    cleanupOutcome,
    rollbackOutcome,
  };
  const earlyResult = targetPresent
    ? await verifyExistingHighlight(attempt)
    : await addAndVerifyHighlight(attempt, current);
  if (earlyResult) return earlyResult;
  await cleanObsoleteHighlights(attempt);
  return verifyFinalHighlight(attempt);
}

async function verifyExistingHighlight(
  attempt: HighlightAttempt,
): Promise<HighlightResult | undefined> {
  const {
    subreddit,
    post,
    options,
    issues,
    capacityOutcome,
    cleanupOutcome,
    rollbackOutcome,
  } = attempt;
  const verification = await pollForState(subreddit, post, true, options);
  if (!verification.matches) {
    issues.push({
      category: "verification",
      postId: post.id,
      message: "Reddit did not confirm the existing Community Highlight.",
    });
    return resultWithIssues({
      status: verification.listed ? "highlighted" : "not_highlighted",
      selectedPostId: post.id,
      verifiedHighlighted: false,
      issues,
      capacityOutcome,
      cleanupOutcome,
      removedManagedHighlightIds: [],
      preservedHighlightIds: idsOf(verification.snapshot),
      rollbackOutcome,
    });
  }
}

async function addAndVerifyHighlight(
  attempt: HighlightAttempt,
  current: HighlightedPostInfo[],
): Promise<HighlightResult | undefined> {
  const { subreddit, post, options } = attempt;
  const blocked = await makeRoomForHighlight(attempt, current);
  if (blocked) return blocked;
  // Use the last snapshot before writing as the displacement baseline.
  const preWrite = await readSnapshot(subreddit, options);
  const reserveMs =
    attempt.removed.length > 0 ||
    preWrite.length === communityHighlightLimit - 1
      ? rollbackReserveMs
      : 0;
  if (!canContinue(options, reserveMs))
    return reportUnverifiedWrite(
      attempt,
      {
        matches: false,
        listed: false,
        snapshot: preWrite,
        errorMessage: budgetError,
      },
      undefined,
    );
  if (preWrite.length >= communityHighlightLimit)
    return reportCapacityChange(attempt);
  const writeError = await writeHighlight(attempt);
  // A rejected write gets one immediate observation. Do not wait during
  // rollback either, but still restore the previous pin when it is safe.
  const verificationOptions =
    writeError === undefined ? options : { ...options, maxWaitMs: 0 };
  const verification = await pollForState(
    subreddit,
    post,
    true,
    verificationOptions,
    writeError === undefined ? reserveMs : 0,
  );
  if (writeError !== undefined || !verification.matches)
    return reportUnverifiedWrite(
      { ...attempt, options: verificationOptions },
      verification,
      writeError,
    );
  return rollbackConcurrentDisplacement(
    attempt,
    preWrite,
    verification.snapshot,
  );
}

async function makeRoomForHighlight(
  attempt: HighlightAttempt,
  current: HighlightedPostInfo[],
): Promise<HighlightResult | undefined> {
  const {
    subreddit,
    post,
    options,
    initialIds,
    removableIds,
    issues,
    removed,
    cleanupOutcome,
    rollbackOutcome,
  } = attempt;
  attempt.capacityOutcome =
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
          "All six Community Highlight slots are occupied and no obsolete app-managed highlight can be safely removed.",
      });
      return resultWithIssues({
        status: "not_highlighted",
        selectedPostId: post.id,
        verifiedHighlighted: false,
        issues,
        capacityOutcome: attempt.capacityOutcome,
        cleanupOutcome,
        removedManagedHighlightIds: [],
        preservedHighlightIds: initialIds,
        rollbackOutcome,
      });
    }

    try {
      await removeManagedHighlightForCapacity(attempt, removableInfo);
      attempt.cleanupOutcome = "completed";
      attempt.capacityOutcome = "managed_slot_freed";
    } catch (error) {
      logDiagnostic(
        "warn",
        "highlight_operation_failed",
        {
          workflow: "community_highlights",
          phase: "capacity_cleanup",
          postId: removableInfo.postId,
        },
        error,
      );
      issues.push({
        category: "cleanup",
        postId: removableInfo.postId,
        message: toErrorMessage(error),
      });
      const rollbackOutcome = await restoreRemovedHighlights(
        subreddit,
        removed,
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
        removedManagedHighlightIds: removed.map(({ info }) => info.postId),
        preservedHighlightIds: idsOf(await readSnapshot(subreddit, options)),
        rollbackOutcome,
      });
    }
  }
}

async function removeManagedHighlightForCapacity(
  attempt: HighlightAttempt,
  removableInfo: HighlightedPostInfo,
): Promise<void> {
  const { reddit, subreddit, options, removed } = attempt;
  requireTime(options);
  const removablePost = await fetchHighlightablePost(
    reddit,
    removableInfo.postId,
  );
  if (
    typeof removablePost.unhighlight !== "function" ||
    typeof removablePost.isHighlighted !== "function"
  ) {
    throw new Error(
      `Unable to safely remove and verify obsolete Community Highlight ${removableInfo.postId}.`,
    );
  }
  requireTime(options);
  await removablePost.unhighlight();
  const removal = await pollForState(
    subreddit,
    removablePost,
    false,
    options,
    rollbackReserveMs,
  );
  if (!removal.matches || removal.snapshot.length >= communityHighlightLimit) {
    if (
      !canContinue(options, rollbackReserveMs) ||
      !removal.snapshot.some(({ postId }) => postId === removableInfo.postId)
    ) {
      removed.push({ info: removableInfo, post: removablePost });
    }
    throw new Error(
      `Reddit did not confirm that obsolete Community Highlight ${removableInfo.postId} freed a slot.`,
    );
  }
  removed.push({ info: removableInfo, post: removablePost });
}

async function reportCapacityChange(
  attempt: HighlightAttempt,
): Promise<HighlightResult> {
  const { subreddit, post, options, issues, removed, cleanupOutcome } = attempt;
  const capacityOutcome = "concurrent_change";
  issues.push({
    category: "concurrency",
    postId: post.id,
    message:
      "Community Highlight capacity changed before the Subscriber Goal could be highlighted.",
  });
  const rollbackOutcome = await restoreRemovedHighlights(
    subreddit,
    removed,
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
    removedManagedHighlightIds: removed.map(({ info }) => info.postId),
    preservedHighlightIds: idsOf(await readSnapshot(subreddit, options)),
    rollbackOutcome,
  });
}

async function writeHighlight(
  attempt: HighlightAttempt,
): Promise<string | undefined> {
  const { post, issues } = attempt;
  let writeError: string | undefined;
  try {
    await post.highlight();
  } catch (error) {
    writeError = toErrorMessage(error);
    const response = error as { status?: number; statusCode?: number } | null;
    const status = response?.status ?? response?.statusCode;
    const permissionDenied =
      status === 403 ||
      /\b(?:PERMISSION_DENIED|403\s+Forbidden)\b/i.test(writeError);
    issues.push({
      category:
        post.archived && isArchivedPostMutationError(error)
          ? "post_state"
          : permissionDenied
            ? "permission"
            : "write",
      postId: post.id,
      message: writeError,
    });
    logDiagnostic(
      "warn",
      "highlight_operation_failed",
      { workflow: "community_highlights", phase: "write", postId: post.id },
      error,
    );
  }
  return writeError;
}

async function reportUnverifiedWrite(
  attempt: HighlightAttempt,
  verification: Awaited<ReturnType<typeof pollForState>>,
  writeError: string | undefined,
): Promise<HighlightResult> {
  const {
    subreddit,
    post,
    options,
    issues,
    removed,
    cleanupOutcome,
    capacityOutcome,
    rollbackOutcome,
  } = attempt;
  if (!writeError) {
    issues.push({
      category: "verification",
      postId: post.id,
      message:
        verification.errorMessage ??
        "Reddit did not confirm the Community Highlight write.",
    });
  }
  const mustUndoReplacement =
    verification.listed &&
    options.rollbackUnverifiedReplacement &&
    removed.length > 0;
  if (verification.listed && !mustUndoReplacement) {
    return resultWithIssues({
      status: "highlighted",
      selectedPostId: post.id,
      verifiedHighlighted: false,
      issues,
      capacityOutcome,
      cleanupOutcome,
      removedManagedHighlightIds: removed.map(({ info }) => info.postId),
      preservedHighlightIds: idsOf(verification.snapshot).filter(
        (postId) => postId !== post.id,
      ),
      rollbackOutcome,
    });
  }
  const restored = mustUndoReplacement
    ? await rollbackUnverifiedReplacement(subreddit, post, removed, options)
    : await restoreRemovedHighlights(subreddit, removed, options);
  if (restored === "failed") {
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
    removedManagedHighlightIds: removed.map(({ info }) => info.postId),
    preservedHighlightIds: idsOf(options.budget.snapshot).filter(
      (postId) => postId !== post.id,
    ),
    rollbackOutcome: restored,
  });
}

async function rollbackConcurrentDisplacement(
  attempt: HighlightAttempt,
  preWrite: HighlightedPostInfo[],
  afterWrite: HighlightedPostInfo[],
): Promise<HighlightResult | undefined> {
  const { subreddit, post, issues, removed, cleanupOutcome, options } = attempt;
  const afterWriteIds = new Set(idsOf(afterWrite));
  const displaced = preWrite.filter(({ postId }) => !afterWriteIds.has(postId));
  const preWriteIds = new Set(idsOf(preWrite));
  const unexpected = afterWrite.filter(
    ({ postId }) => postId !== post.id && !preWriteIds.has(postId),
  );
  const plausibleCapacityEviction =
    preWrite.length === communityHighlightLimit - 1 &&
    afterWrite.length === communityHighlightLimit &&
    displaced.length > 0 &&
    unexpected.length > 0;
  if (plausibleCapacityEviction) {
    const capacityOutcome = "concurrent_change";
    let rollbackOutcome: HighlightResult["rollbackOutcome"];
    issues.push({
      category: "concurrency",
      postId: post.id,
      message:
        "A concurrent sixth highlight made the app write unsafe; the Subscriber Goal was rolled back.",
    });
    try {
      rollbackOutcome = await restoreDisplacedHighlights(attempt, displaced);
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
    const finalSnapshot = await readSnapshot(subreddit, options);
    const finalTargetPresent = finalSnapshot.some(
      ({ postId }) => postId === post.id,
    );
    let finalPostState = false;
    try {
      if (canContinue(options)) finalPostState = await post.isHighlighted();
    } catch (error) {
      logDiagnostic(
        "warn",
        "highlight_operation_failed",
        {
          workflow: "community_highlights",
          phase: "rollback_verification",
          postId: post.id,
        },
        error,
      );
    }
    return resultWithIssues({
      status: finalTargetPresent ? "highlighted" : "not_highlighted",
      selectedPostId: post.id,
      verifiedHighlighted: finalTargetPresent && finalPostState,
      issues,
      capacityOutcome,
      cleanupOutcome,
      removedManagedHighlightIds: removed.map(({ info }) => info.postId),
      preservedHighlightIds: idsOf(finalSnapshot).filter(
        (postId) => postId !== post.id,
      ),
      rollbackOutcome,
    });
  }
}

async function restoreDisplacedHighlights(
  attempt: HighlightAttempt,
  displaced: HighlightedPostInfo[],
): Promise<HighlightResult["rollbackOutcome"]> {
  const { reddit, subreddit, post, options, removed } = attempt;
  const displacedPosts: RemovedHighlight[] = [];
  if (typeof post.unhighlight !== "function") {
    throw new Error(
      "The Subscriber Goal could not be removed during rollback.",
    );
  }
  requireTime(options);
  await post.unhighlight();
  if (!(await pollForState(subreddit, post, false, options)).matches) {
    throw new Error("Reddit did not confirm Subscriber Goal rollback.");
  }
  const rollbackSnapshot = await readSnapshot(subreddit, options);
  if (rollbackSnapshot.length >= communityHighlightLimit) {
    throw new Error(
      "Community Highlight capacity became full during rollback.",
    );
  }
  for (const info of displaced) {
    requireTime(options);
    displacedPosts.push({
      info,
      post: await fetchHighlightablePost(reddit, info.postId),
    });
  }
  return restoreRemovedHighlights(
    subreddit,
    [...removed, ...displacedPosts],
    options,
  );
}

async function cleanObsoleteHighlights(
  attempt: HighlightAttempt,
): Promise<void> {
  const { reddit, subreddit, post, options, removableIds, issues, removed } =
    attempt;
  const cleanupSnapshot = await readSnapshot(subreddit, options);
  const cleanupTargets = cleanupSnapshot.filter(
    ({ postId }) => postId !== post.id && removableIds.has(postId),
  );
  if (cleanupTargets.length > 0) attempt.cleanupOutcome = "completed";
  for (const info of cleanupTargets) {
    try {
      requireTime(options);
      const obsoletePost = await fetchHighlightablePost(reddit, info.postId);
      if (
        typeof obsoletePost.unhighlight !== "function" ||
        typeof obsoletePost.isHighlighted !== "function"
      ) {
        throw new Error(
          `Unable to remove and verify obsolete Community Highlight ${info.postId}.`,
        );
      }
      requireTime(options);
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
      attempt.cleanupOutcome = "failed";
      issues.push({
        category: "cleanup",
        postId: info.postId,
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
}

async function verifyFinalHighlight(
  attempt: HighlightAttempt,
): Promise<HighlightResult> {
  const {
    subreddit,
    post,
    options,
    issues,
    removed,
    capacityOutcome,
    cleanupOutcome,
    rollbackOutcome,
  } = attempt;
  const finalVerification = await pollForState(subreddit, post, true, options);
  const finalSnapshot = finalVerification.snapshot;
  const selectedPosition = finalSnapshot.findIndex(
    ({ postId }) => postId === post.id,
  );
  if (!finalVerification.matches) {
    issues.push({
      category:
        finalVerification.listed || !canContinue(options)
          ? "verification"
          : "concurrency",
      postId: post.id,
      message:
        finalVerification.errorMessage ??
        (finalVerification.listed
          ? "Reddit did not independently confirm the final Community Highlight state."
          : "The selected Subscriber Goal disappeared from Community Highlights during reconciliation."),
    });
  }
  return resultWithIssues({
    status: finalVerification.listed ? "highlighted" : "not_highlighted",
    selectedPostId: post.id,
    verifiedHighlighted: finalVerification.matches,
    ...(selectedPosition >= 0 ? { selectedPosition } : {}),
    issues,
    capacityOutcome,
    cleanupOutcome,
    removedManagedHighlightIds: removed.map(({ info }) => info.postId),
    preservedHighlightIds: idsOf(finalSnapshot).filter(
      (postId) => postId !== post.id,
    ),
    rollbackOutcome,
  });
}
