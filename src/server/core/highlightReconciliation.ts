import { logDiagnostic } from "../../shared/diagnostics";
import type { LinkId, RedditClient, RedisClient } from "../types";
import {
  clearActiveHighlightFailureIncident,
  clearHighlightFailureIncident,
  getPostUrl,
  highlightPermissionIncidentKey,
  notifyHighlightFailureIncident,
  type HighlightNotificationOutcome,
} from "../utils/highlightFailureNotifications";
import {
  autoCreateNextGoalSuccessorsKey,
  cancelAutoCreateNextGoal,
  checkCompletionStatus,
  getSubGoalData,
} from "../data/subGoalData";
import {
  createFailedHighlightResult,
  isCapacityOnlyHighlightFailure,
  highlightAndVerifyPost,
  type HighlightResult,
  type HighlightVerificationOptions,
} from "../utils/communityHighlights";
import { checkAppAccountHealth } from "./appAccountHealth";
import {
  getCanonicalGoalPointer,
  saveCanonicalGoalPointer,
  type HighlightReconciliationContext,
} from "../data/highlightManagement";
import { checkCanonicalHighlightContradiction } from "./canonicalHighlightContradiction";
import {
  newestGoalCandidate,
  selectManagedGoalHighlight,
} from "./managedGoalHighlightSelection";
import {
  completedHighlightInventory,
  deferredCompletedHighlightInventory,
  highlightCandidateDetails,
} from "./managedGoalHighlightInventory";
import {
  appRepairStateKey,
  recurringHighlightRepairIntervalMs,
  scheduleHighlightRepair,
} from "../data/highlightRepair";
import {
  withCommunityGoalMutationLease,
  type CommunityGoalMutationLease,
} from "./communityGoalMutation";
import {
  clearPostOperationalState,
  getPostOperationalState,
  savePostOperationalState,
} from "../data/postOperationalState";
import {
  type OnboardingDetectionDiagnostics,
  type OnboardingGoalCandidate,
  type OnboardingHighlightEnsuranceResult,
  emptySummary,
  findValidSubscriberGoals,
} from "./goalDiscovery";

export const emptyHighlightEnsuranceResult =
  (): OnboardingHighlightEnsuranceResult => ({
    ...emptySummary(),
    status: "missing",
    candidateCount: 0,
    highlightedClassicCount: 0,
    highlightedProtectedCount: 0,
    highlightedAmbiguousCount: 0,
    classicPostsUnhighlighted: [],
    protectedHighlightsPreserved: [],
    eligiblePostIds: [],
    unhighlightedEligiblePostIds: [],
  });

export async function ensureExistingSubscriberGoalHighlighted({
  reddit,
  redis,
  nowMs = Date.now(),
  notifyOnFailure = false,
  scheduleRepairOnDegraded = true,
  highlightVerification,
  reconciliationContext = "onboarding",
  mutationLease,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs?: number;
  notifyOnFailure?: boolean;
  scheduleRepairOnDegraded?: boolean;
  highlightVerification?: Partial<HighlightVerificationOptions>;
  reconciliationContext?: HighlightReconciliationContext;
  mutationLease?: CommunityGoalMutationLease;
}): Promise<OnboardingHighlightEnsuranceResult> {
  return withCommunityGoalMutationLease(
    redis,
    (lease) =>
      ensureExistingSubscriberGoalHighlightedUnderLease({
        reddit,
        redis,
        nowMs,
        notifyOnFailure,
        scheduleRepairOnDegraded,
        ...(highlightVerification ? { highlightVerification } : {}),
        reconciliationContext,
        mutationLease: lease,
      }),
    mutationLease,
  );
}

async function ensureExistingSubscriberGoalHighlightedUnderLease({
  reddit,
  redis,
  nowMs,
  notifyOnFailure,
  scheduleRepairOnDegraded,
  highlightVerification,
  reconciliationContext,
  mutationLease,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs: number;
  notifyOnFailure: boolean;
  scheduleRepairOnDegraded: boolean;
  highlightVerification?: Partial<HighlightVerificationOptions>;
  reconciliationContext: HighlightReconciliationContext;
  mutationLease: CommunityGoalMutationLease;
}): Promise<OnboardingHighlightEnsuranceResult> {
  const discovery = await findValidSubscriberGoals(reddit, redis, nowMs);
  const { candidates, removedActiveGoals, ...diagnostics } = discovery;
  const newestLiveClassicAt = candidates
    .filter((candidate) => candidate.classification === "classic")
    .reduce(
      (newest, candidate) =>
        Math.max(newest, candidate.createdAtMs ?? Number.POSITIVE_INFINITY),
      Number.NEGATIVE_INFINITY,
    );
  // A newer live classic supersedes an older removed goal, even if the live
  // one is completed. Unknown removal dates remain conservative blockers.
  const blockingRemovedGoals = removedActiveGoals.filter(
    (candidate) =>
      candidate.createdAtMs === undefined ||
      candidate.createdAtMs > newestLiveClassicAt,
  );
  const liveResult = await reconcileLiveSubscriberGoalHighlights({
    reddit,
    redis,
    nowMs,
    notifyOnFailure,
    scheduleRepairOnDegraded,
    reconciliationContext,
    mutationLease,
    ...(highlightVerification ? { highlightVerification } : {}),
    candidates,
    diagnostics,
    pauseSuccessorMapping: blockingRemovedGoals.length > 0,
  });
  if (blockingRemovedGoals.length === 0) return liveResult;
  const selected =
    blockingRemovedGoals.find(({ createdAtMs }) => createdAtMs === undefined) ??
    newestGoalCandidate(blockingRemovedGoals);
  const blockerIds = blockingRemovedGoals.map(({ postId }) => postId);
  const result: OnboardingHighlightEnsuranceResult = {
    ...liveResult,
    ...(liveResult.status === "missing"
      ? {
          status: "existing_not_highlighted" as const,
          postId: selected.postId,
          source: selected.source,
          classification: selected.classification,
          classificationConfidence: selected.classificationConfidence,
          selectedWasAlreadyHighlighted: false,
          verificationResult: "not_highlighted" as const,
          notificationOutcome: "not_requested" as const,
        }
      : {}),
    pausedByRemovedGoal: true,
    removedGoalBlockerPostIds: blockerIds,
    candidateCount: liveResult.candidateCount + blockingRemovedGoals.length,
    eligiblePostIds: [...blockerIds, ...liveResult.eligiblePostIds],
    unhighlightedEligiblePostIds: [
      ...blockerIds,
      ...liveResult.unhighlightedEligiblePostIds,
    ],
  };
  logHighlightEnsurance(result.status, result, reconciliationContext);
  return result;
}

type HighlightInventory = Omit<
  OnboardingHighlightEnsuranceResult,
  "status" | "protectedHighlightsPreserved"
> & {
  protectedHighlightsPreserved: LinkId[];
};

async function reconcileLiveSubscriberGoalHighlights({
  reddit,
  redis,
  nowMs,
  notifyOnFailure,
  scheduleRepairOnDegraded,
  highlightVerification,
  reconciliationContext,
  mutationLease,
  candidates,
  diagnostics,
  pauseSuccessorMapping,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  nowMs: number;
  notifyOnFailure: boolean;
  scheduleRepairOnDegraded: boolean;
  highlightVerification?: Partial<HighlightVerificationOptions>;
  reconciliationContext: HighlightReconciliationContext;
  mutationLease: CommunityGoalMutationLease;
  candidates: OnboardingGoalCandidate[];
  diagnostics: OnboardingDetectionDiagnostics;
  pauseSuccessorMapping: boolean;
}): Promise<OnboardingHighlightEnsuranceResult> {
  await refreshCandidateCompletion(
    reddit,
    redis,
    candidates,
    nowMs,
    mutationLease,
  );
  const { base, highlighted, highlightedClassic } = buildHighlightInventory(
    candidates,
    diagnostics,
  );
  if (candidates.length === 0) {
    await clearActiveHighlightFailureIncident(redis);
    logHighlightEnsurance("missing", base, reconciliationContext);
    return { status: "missing", ...base };
  }

  const selection = await selectManagedGoalHighlight(redis, candidates, nowMs);
  base.eligiblePostIds.push(...selection.eligiblePostIds);
  if (selection.activeGoals.length > 0 && !pauseSuccessorMapping) {
    await mapCompletedGoalsToActiveClassic(redis, selection);
  }

  let result: OnboardingHighlightEnsuranceResult;
  if (selection.selected) {
    const highlighted = await reconcileSelectedManagedGoal({
      reddit,
      redis,
      selected: selection.selected,
      nowMs,
      notifyOnFailure,
      scheduleRepairOnDegraded,
      ...(highlightVerification ? { highlightVerification } : {}),
      removableManagedPostIds: selection.removableManagedPostIds,
      celebrationEndsAt: selection.celebrationEndsAt,
    });
    result = summarizeSelectedHighlight(
      base,
      selection,
      selection.selected,
      highlightedClassic,
      highlighted,
    );
  } else if (selection.latestCompleted) {
    result = completedHighlightInventory(
      base,
      selection.latestCompleted,
      selection.completedGoals,
    );
  } else {
    result = await summarizeUnselectedHighlight(
      redis,
      reconciliationContext,
      candidates,
      highlighted,
      base,
    );
  }
  logHighlightEnsurance(result.status, result, reconciliationContext);
  return result;
}

function buildHighlightInventory(
  candidates: OnboardingGoalCandidate[],
  diagnostics: OnboardingDetectionDiagnostics,
) {
  const highlighted = candidates.filter((candidate) => candidate.isHighlighted);
  const highlightedClassic = highlighted.filter(
    (candidate) =>
      candidate.classification === "classic" &&
      candidate.classificationConfidence !== "ambiguous",
  );
  const protectedHighlighted = highlighted.filter(
    (candidate) =>
      candidate.classification === "tiny" || candidate.classification === "cta",
  );
  const ambiguousHighlighted = highlighted.filter(
    (candidate) => candidate.classification === "ambiguous",
  );
  const base: HighlightInventory = {
    ...diagnostics,
    candidateCount: candidates.length,
    highlightedClassicCount: highlightedClassic.length,
    highlightedProtectedCount: protectedHighlighted.length,
    highlightedAmbiguousCount: ambiguousHighlighted.length,
    classicPostsUnhighlighted: [] as string[],
    protectedHighlightsPreserved: protectedHighlighted.map(
      (candidate) => candidate.postId,
    ),
    eligiblePostIds: [] as string[],
    unhighlightedEligiblePostIds: [] as string[],
  };
  return { base, highlighted, highlightedClassic };
}

async function summarizeUnselectedHighlight(
  redis: RedisClient,
  reconciliationContext: HighlightReconciliationContext,
  candidates: OnboardingGoalCandidate[],
  highlighted: OnboardingGoalCandidate[],
  base: HighlightInventory,
): Promise<OnboardingHighlightEnsuranceResult> {
  const repairState =
    reconciliationContext === "repair"
      ? await redis.hGetAll(appRepairStateKey)
      : {};
  const selected =
    candidates.find(({ postId }) => postId === repairState.targetPostId) ??
    newestGoalCandidate(highlighted.length ? highlighted : candidates);
  await clearActiveHighlightFailureIncident(redis);
  return {
    ...base,
    ...highlightCandidateDetails(selected),
    status: selected.isHighlighted ? "existing" : "existing_not_highlighted",
    ...(selected.isHighlighted
      ? {
          verificationResult: "highlighted",
          reconciliationOutcome: "complete",
        }
      : {}),
    notificationOutcome: "not_requested",
  };
}

async function refreshCandidateCompletion(
  reddit: RedditClient,
  redis: RedisClient,
  candidates: OnboardingGoalCandidate[],
  nowMs: number,
  mutationLease: CommunityGoalMutationLease,
): Promise<void> {
  let subscriberCount: number | undefined;
  for (const candidate of candidates) {
    if (
      candidate.classification === "tiny" ||
      candidate.classification === "cta"
    ) {
      continue;
    }
    const goalData = await getSubGoalData(
      redis,
      candidate.postId,
      candidate.post.postData ?? candidate.post.customPostData,
    );
    if (goalData.goal <= 0) continue;
    candidate.goal = goalData.goal;
    candidate.completedTime = goalData.completedTime;
    candidate.autoCreateNextGoal = goalData.autoCreateNextGoal;
    candidate.autoCreateNextGoalConfigured =
      goalData.autoCreateNextGoalConfigured;
    if (!candidate.completedTime && subscriberCount === undefined) {
      subscriberCount = (await reddit.getCurrentSubreddit())
        .numberOfSubscribers;
    }
    if (
      !candidate.completedTime &&
      subscriberCount !== undefined &&
      subscriberCount >= candidate.goal
    ) {
      candidate.completedTime = await checkCompletionStatus(
        reddit,
        redis,
        candidate.postId,
        {
          now: () => nowMs,
          scheduleAutomaticSuccessor: false,
          automaticSuccessorSuppression: "onboarding_reconciliation",
          mutationLease,
        },
      );
    }
  }
}

function summarizeSelectedHighlight(
  base: HighlightInventory,
  selection: Awaited<ReturnType<typeof selectManagedGoalHighlight>>,
  selected: OnboardingGoalCandidate,
  highlightedClassic: OnboardingGoalCandidate[],
  highlighted: Awaited<ReturnType<typeof reconcileSelectedManagedGoal>>,
): OnboardingHighlightEnsuranceResult {
  const removed = highlighted.highlightResult.removedManagedHighlightIds.filter(
    (postId) =>
      !highlighted.highlightResult.preservedHighlightIds.includes(postId),
  );
  base.classicPostsUnhighlighted.push(
    ...highlightedClassic
      .filter(({ postId }) => removed.includes(postId))
      .map(({ postId }) => postId),
  );
  base.protectedHighlightsPreserved = base.protectedHighlightsPreserved.filter(
    (postId) => !removed.includes(postId),
  );
  if (!highlighted.highlightResult.verifiedHighlighted) {
    base.unhighlightedEligiblePostIds.push(selected.postId);
  }
  const details = {
    ...reconciliationDetails(highlighted.highlightResult),
    notificationOutcome: highlighted.notificationOutcome,
    highlightSelectedPostId: selected.postId,
    managedHighlightsRemoved: removed,
  };
  return selection.latestCompleted && selection.eligiblePostIds.length === 0
    ? {
        ...completedHighlightInventory(
          base,
          selection.latestCompleted,
          selection.completedGoals,
        ),
        ...details,
      }
    : {
        ...base,
        ...highlightCandidateDetails(selected),
        status:
          highlighted.highlightResult.status === "highlighted"
            ? "existing"
            : "existing_not_highlighted",
        ...deferredCompletedHighlightInventory(selection),
        ...details,
      };
}

async function mapCompletedGoalsToActiveClassic(
  redis: RedisClient,
  {
    activeGoals,
    completedGoals,
  }: Awaited<ReturnType<typeof selectManagedGoalHighlight>>,
): Promise<void> {
  const newestActive = newestGoalCandidate(activeGoals);
  for (const completed of completedGoals) {
    if (await redis.hGet(autoCreateNextGoalSuccessorsKey, completed.postId))
      continue;
    await redis.hSet(autoCreateNextGoalSuccessorsKey, {
      [completed.postId]: newestActive.postId,
    });
    await cancelAutoCreateNextGoal(redis, completed.postId);
  }
}

async function reconcileSelectedManagedGoal(
  options: Parameters<typeof reconcileCanonicalClassicGoal>[0] & {
    celebrationEndsAt: number | undefined;
  },
) {
  const { redis, selected, nowMs, celebrationEndsAt } = options;
  if (celebrationEndsAt !== undefined) {
    await scheduleHighlightRepair(redis, {
      nowMs,
      delayMs: Math.min(
        celebrationEndsAt - nowMs,
        recurringHighlightRepairIntervalMs,
      ),
      force: true,
      reason: "completed_goal_highlight_window_ends",
    });
  }
  const result =
    selected.classification === "classic"
      ? await reconcileCanonicalClassicGoal(options)
      : await highlightExistingGoal(options);
  if (
    result.highlightResult.verifiedHighlighted &&
    result.highlightResult.issues.length === 0 &&
    (result.highlightResult.capacityOutcome === "slot_available" ||
      result.highlightResult.capacityOutcome === "managed_slot_freed")
  ) {
    await redis.del(highlightPermissionIncidentKey);
  }
  return result;
}

async function reconcileCanonicalClassicGoal({
  reddit,
  redis,
  selected,
  nowMs,
  notifyOnFailure,
  scheduleRepairOnDegraded,
  highlightVerification,
  removableManagedPostIds,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  selected: OnboardingGoalCandidate;
  nowMs: number;
  notifyOnFailure: boolean;
  scheduleRepairOnDegraded: boolean;
  highlightVerification?: Partial<HighlightVerificationOptions>;
  removableManagedPostIds: LinkId[];
}): Promise<{
  highlightResult: HighlightResult;
  notificationOutcome: HighlightNotificationOutcome;
}> {
  const pointer = await getCanonicalGoalPointer(redis);
  const sameCanonical = pointer?.canonicalPostId === selected.postId;
  const contradiction = await checkCanonicalHighlightContradiction({
    reddit,
    redis,
    selected,
    nowMs,
    notifyOnFailure,
    sameCanonical,
  });
  if (contradiction) return contradiction;

  const reconciliation = await highlightExistingGoal({
    reddit,
    redis,
    selected,
    notifyOnFailure,
    scheduleRepairOnDegraded,
    removableManagedPostIds,
    nowMs,
    ...(highlightVerification ? { highlightVerification } : {}),
  });
  if (
    reconciliation.highlightResult.status === "highlighted" &&
    reconciliation.highlightResult.issues.length === 0
  ) {
    await saveCanonicalGoalPointer(redis, {
      canonicalPostId: selected.postId,
      reconciledAt: nowMs,
    });
  }
  return reconciliation;
}

async function highlightExistingGoal({
  reddit,
  redis,
  selected,
  notifyOnFailure,
  scheduleRepairOnDegraded,
  highlightVerification,
  removableManagedPostIds,
  nowMs = Date.now(),
}: {
  reddit: RedditClient;
  redis: RedisClient;
  selected: OnboardingGoalCandidate;
  notifyOnFailure: boolean;
  scheduleRepairOnDegraded: boolean;
  highlightVerification?: Partial<HighlightVerificationOptions>;
  removableManagedPostIds?: LinkId[];
  nowMs?: number;
}): Promise<{
  highlightResult: HighlightResult;
  notificationOutcome: HighlightNotificationOutcome;
}> {
  const subreddit = await reddit.getCurrentSubreddit();
  const operationalState = await getPostOperationalState(
    redis,
    selected.postId,
  );
  if (selected.post.archived && operationalState?.highlightBlocked) {
    const highlightResult = createFailedHighlightResult(
      selected.postId,
      "post_state",
      "The archived Subscriber Goal cannot be highlighted until Reddit reports that it is eligible again.",
    );
    return { highlightResult, notificationOutcome: "not_requested" };
  }
  if (!selected.post.archived && operationalState?.highlightBlocked) {
    await clearPostOperationalState(redis, selected.postId);
  }
  const health = await checkAppAccountHealth({
    reddit,
    redis,
    subredditName: subreddit.name,
    subredditId: subreddit.id,
    language: subreddit.language,
    notify: false,
    nowMs,
  });
  const highlightResult =
    !health.healthy || health.status !== "healthy"
      ? createFailedHighlightResult(
          selected.postId,
          "permission",
          "Manage Posts permission could not be verified, so no Community Highlight changes were attempted.",
        )
      : typeof selected.post.highlight !== "function"
        ? createFailedHighlightResult(
            selected.postId,
            "write",
            "Unable to highlight the existing goal because post.highlight is unavailable.",
          )
        : await highlightAndVerifyPost(
            reddit,
            subreddit,
            {
              id: selected.postId,
              ...(selected.post.archived === undefined
                ? {}
                : { archived: selected.post.archived }),
              ...(selected.post.locked === undefined
                ? {}
                : { locked: selected.post.locked }),
              highlight: (options) => selected.post.highlight!(options),
              ...(selected.post.unhighlight
                ? { unhighlight: () => selected.post.unhighlight!() }
                : {}),
              ...(selected.post.isHighlighted
                ? { isHighlighted: () => selected.post.isHighlighted!() }
                : {}),
            },
            {
              ...highlightVerification,
              ...(removableManagedPostIds ? { removableManagedPostIds } : {}),
              rollbackUnverifiedReplacement: true,
            },
          );
  if (
    selected.post.archived &&
    highlightResult.issues.some(({ category }) => category === "post_state")
  ) {
    await savePostOperationalState(redis, {
      postId: selected.postId,
      archived: true,
      locked: selected.post.locked === true,
      highlightBlocked: true,
      updatedAt: nowMs,
    });
  }
  if (highlightResult.issues.length === 0) {
    await clearHighlightFailureIncident(redis, selected.postId);
    return { highlightResult, notificationOutcome: "not_requested" };
  }

  if (isCapacityOnlyHighlightFailure(highlightResult)) {
    return { highlightResult, notificationOutcome: "not_requested" };
  }

  if (scheduleRepairOnDegraded) {
    await scheduleHighlightRepair(redis, {
      delayMs: 5 * 60 * 1000,
      force: true,
      reason: "highlight_reconciliation_degraded",
      nowMs,
    });
  }

  const notificationOutcome = notifyOnFailure
    ? await notifyExistingHighlightFailure({
        reddit,
        redis,
        selected,
        highlightResult,
        nowMs,
      })
    : "not_requested";
  return { highlightResult, notificationOutcome };
}

async function notifyExistingHighlightFailure({
  reddit,
  redis,
  selected,
  highlightResult,
  nowMs,
  additionalPostUrls,
}: {
  reddit: RedditClient;
  redis: RedisClient;
  selected: OnboardingGoalCandidate;
  highlightResult: HighlightResult;
  nowMs: number;
  additionalPostUrls?: readonly string[];
}): Promise<HighlightNotificationOutcome> {
  try {
    const subreddit = await reddit.getCurrentSubreddit();
    return await notifyHighlightFailureIncident({
      reddit,
      redis,
      postId: selected.postId,
      result: highlightResult,
      subredditId: subreddit.id,
      subredditName: subreddit.name,
      postTitle: selected.post.title ?? "Subscriber Goal",
      postUrl:
        getPostUrl(selected.post) ??
        "https://www.reddit.com/comments/" + selected.postId.slice(3),
      additionalPostUrls,
      errorMessage: highlightResult.errorMessage,
      postOrigin: "existing",
      language: subreddit.language,
      nowMs,
    });
  } catch (error) {
    logDiagnostic(
      "warn",
      "onboarding_existing_goal_notification_failed",
      {
        workflow: "onboarding_highlight_ensurance",
        phase: "highlight_notification",
        postId: selected.postId,
      },
      error,
    );
    return "failed";
  }
}

function reconciliationDetails(
  highlightResult: HighlightResult,
): Pick<
  OnboardingHighlightEnsuranceResult,
  | "verificationResult"
  | "reconciliationOutcome"
  | "failureCategories"
  | "capacityOutcome"
  | "capacityOnly"
  | "cleanupOutcome"
  | "rollbackOutcome"
  | "errorMessage"
> {
  return {
    verificationResult:
      highlightResult.status === "highlighted"
        ? "highlighted"
        : "not_highlighted",
    reconciliationOutcome:
      highlightResult.status === "not_highlighted"
        ? "failed"
        : highlightResult.issues.length > 0
          ? "degraded"
          : "complete",
    failureCategories: highlightResult.issues.map(({ category }) => category),
    capacityOutcome: highlightResult.capacityOutcome,
    capacityOnly: isCapacityOnlyHighlightFailure(highlightResult),
    cleanupOutcome: highlightResult.cleanupOutcome,
    rollbackOutcome: highlightResult.rollbackOutcome,
    ...(highlightResult.errorMessage
      ? { errorMessage: highlightResult.errorMessage }
      : {}),
  };
}

function logHighlightEnsurance(
  status: OnboardingHighlightEnsuranceResult["status"],
  result:
    | Omit<OnboardingHighlightEnsuranceResult, "status">
    | OnboardingHighlightEnsuranceResult,
  reconciliationContext: HighlightReconciliationContext,
): void {
  logDiagnostic("info", "onboarding_goal_highlight_ensurance_completed", {
    workflow: "onboarding_highlight_ensurance",
    phase: "reconcile",
    reconciliationContext,
    outcome: status,
    candidateCount: result.candidateCount,
    selectedPostId: result.postId ?? "none",
    selectedType: result.classification ?? "none",
    highlightSelectedPostId: result.highlightSelectedPostId ?? "none",
    managedHighlightsRemoved:
      result.managedHighlightsRemoved?.join(",") || "none",
    highlightedClassicCount: result.highlightedClassicCount,
    highlightedProtectedCount: result.highlightedProtectedCount,
    highlightedAmbiguousCount: result.highlightedAmbiguousCount,
    classicPostsUnhighlighted:
      result.classicPostsUnhighlighted.join(",") || "none",
    protectedHighlightsPreserved:
      result.protectedHighlightsPreserved.join(",") || "none",
    eligiblePostIds: result.eligiblePostIds.join(",") || "none",
    unhighlightedEligiblePostIds:
      result.unhighlightedEligiblePostIds.join(",") || "none",
    verificationResult: result.verificationResult ?? "not_attempted",
    reconciliationOutcome: result.reconciliationOutcome ?? "not_attempted",
    failureCategories: result.failureCategories?.join(",") || "none",
    capacityOutcome: result.capacityOutcome ?? "not_attempted",
    cleanupOutcome: result.cleanupOutcome ?? "not_attempted",
    rollbackOutcome: result.rollbackOutcome ?? "not_attempted",
    notificationOutcome: result.notificationOutcome ?? "not_requested",
  });
}
