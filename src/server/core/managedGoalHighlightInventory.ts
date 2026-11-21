import type { selectManagedGoalHighlight } from "./managedGoalHighlightSelection";
import type {
  OnboardingGoalCandidate,
  OnboardingHighlightEnsuranceResult,
} from "./onboardingSubscriberGoal";

export function highlightCandidateDetails(candidate: OnboardingGoalCandidate) {
  return {
    postId: candidate.postId,
    source: candidate.source,
    classification: candidate.classification,
    classificationConfidence: candidate.classificationConfidence,
    selectedWasAlreadyHighlighted: candidate.isHighlighted,
  };
}

function supersededCompletedGoals(
  latest: OnboardingGoalCandidate,
  completedGoals: OnboardingGoalCandidate[],
): string[] {
  return completedGoals
    .filter(({ postId }) => postId !== latest.postId)
    .map(({ postId }) => postId);
}

export function completedHighlightInventory(
  base: Omit<OnboardingHighlightEnsuranceResult, "status">,
  latest: OnboardingGoalCandidate,
  completedGoals: OnboardingGoalCandidate[],
): OnboardingHighlightEnsuranceResult {
  const superseded = supersededCompletedGoals(latest, completedGoals);
  return {
    ...base,
    ...highlightCandidateDetails(latest),
    status: "completed",
    notificationOutcome: "not_requested",
    ...(latest.isHighlighted ? { verificationResult: "highlighted" } : {}),
    ...(superseded.length ? { supersededCompletedPostIds: superseded } : {}),
    ...(latest.goal === undefined ? {} : { goal: latest.goal }),
    ...(latest.completedTime === undefined
      ? {}
      : { completedTime: latest.completedTime }),
    ...(latest.autoCreateNextGoal === undefined
      ? {}
      : { autoCreateNextGoal: latest.autoCreateNextGoal }),
    ...(latest.autoCreateNextGoalConfigured === undefined
      ? {}
      : { autoCreateNextGoalConfigured: latest.autoCreateNextGoalConfigured }),
  };
}

export function deferredCompletedHighlightInventory({
  activeGoals,
  latestCompleted,
  completedGoals,
}: ReturnType<typeof selectManagedGoalHighlight>) {
  if (activeGoals.length || !latestCompleted?.completedTime) return {};
  const superseded = supersededCompletedGoals(latestCompleted, completedGoals);
  return {
    deferredCompletedGoal: {
      postId: latestCompleted.postId,
      completedTime: latestCompleted.completedTime,
      autoCreateNextGoal: latestCompleted.autoCreateNextGoal ?? false,
    },
    ...(superseded.length ? { supersededCompletedPostIds: superseded } : {}),
  };
}
