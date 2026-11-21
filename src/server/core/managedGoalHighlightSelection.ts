import { autoCreateNextGoalDelayMs } from "../data/subGoalData";
import type { OnboardingGoalCandidate } from "./onboardingSubscriberGoal";

export function newestGoalCandidate(
  candidates: readonly OnboardingGoalCandidate[],
): OnboardingGoalCandidate {
  return [...candidates].sort(
    (a, b) =>
      (b.createdAtMs ?? Number.NEGATIVE_INFINITY) -
        (a.createdAtMs ?? Number.NEGATIVE_INFINITY) ||
      a.discoveryOrder - b.discoveryOrder,
  )[0]!;
}

export function selectManagedGoalHighlight(
  candidates: readonly OnboardingGoalCandidate[],
  nowMs: number,
) {
  const classicCandidates = candidates.filter(
    (candidate) =>
      candidate.classification === "classic" &&
      candidate.classificationConfidence !== "ambiguous",
  );
  const classicGoals = classicCandidates.filter(({ goal }) => (goal ?? 0) > 0);
  const activeGoals = classicGoals.filter(
    ({ completedTime }) => !completedTime,
  );
  const completedGoals = candidates.filter(
    ({ goal, completedTime }) => (goal ?? 0) > 0 && completedTime,
  );
  const compactGoals = candidates.filter(
    (candidate) =>
      candidate.classificationConfidence !== "ambiguous" &&
      (candidate.classification === "tiny" ||
        candidate.classification === "cta"),
  );
  const recentCompletedGoals = classicGoals.filter(
    ({ completedTime }) =>
      completedTime && completedTime + autoCreateNextGoalDelayMs > nowMs,
  );
  const latestCompleted = completedGoals.length
    ? newestGoalCandidate(completedGoals)
    : undefined;
  const choices = [activeGoals, recentCompletedGoals, compactGoals].find(
    (group) => group.length > 0,
  );
  const selected = choices ? newestGoalCandidate(choices) : undefined;
  return {
    selected,
    latestCompleted,
    completedGoals,
    activeGoals,
    celebrationEndsAt: selected?.completedTime
      ? selected.completedTime + autoCreateNextGoalDelayMs
      : undefined,
    removableManagedPostIds: [...classicCandidates, ...compactGoals]
      .filter((candidate) => candidate.postId !== selected?.postId)
      .map(({ postId }) => postId),
    // This inventory also serves AutoGoal. Keep deliberately unpinned goals
    // and compact surfaces visible to its successor suppression checks.
    eligiblePostIds: [...activeGoals, ...compactGoals]
      .sort(
        (left, right) =>
          (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0) ||
          left.postId.localeCompare(right.postId),
      )
      .map(({ postId }) => postId),
  };
}
