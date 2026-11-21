import {
  autoCreateNextGoalDelayMs,
  autoCreateNextGoalSuccessorsKey,
  postAutoCreateNextGoalSuffix,
  subscriberGoalsKey,
} from "../data/subGoalData";
import { isLinkId, type RedisClient } from "../types";
import type { OnboardingGoalCandidate } from "./onboardingSubscriberGoal";

const successorHighlightGraceMs = 30 * 60 * 1000;

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

async function goalsWaitingForSuccessor(
  redis: RedisClient,
  classicGoals: readonly OnboardingGoalCandidate[],
  nowMs: number,
): Promise<Set<string>> {
  const postIds = classicGoals
    .filter(
      ({ autoCreateNextGoal, completedTime }) =>
        autoCreateNextGoal &&
        completedTime &&
        completedTime + autoCreateNextGoalDelayMs + successorHighlightGraceMs >
          nowMs,
    )
    .map(({ postId }) => postId);
  if (postIds.length === 0) return new Set();

  // The effective AutoGoal flag is always on for numeric goals. The saved
  // setting can still opt out of the extra highlight time.
  const [settings, successors] = await Promise.all([
    redis.hMGet(
      subscriberGoalsKey,
      postIds.map((postId) => `${postId}${postAutoCreateNextGoalSuffix}`),
    ),
    redis.hMGet(autoCreateNextGoalSuccessorsKey, postIds),
  ]);
  return new Set(
    postIds.filter(
      (_, index) =>
        settings[index] !== "false" && !isLinkId(successors[index] ?? ""),
    ),
  );
}

export async function selectManagedGoalHighlight(
  redis: RedisClient,
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
  const waitingForSuccessor = activeGoals.length
    ? new Set<string>()
    : await goalsWaitingForSuccessor(redis, classicGoals, nowMs);
  const celebrationEnd = ({
    postId,
    completedTime,
  }: OnboardingGoalCandidate) =>
    completedTime
      ? completedTime +
        autoCreateNextGoalDelayMs +
        (waitingForSuccessor.has(postId) ? successorHighlightGraceMs : 0)
      : undefined;
  const recentCompletedGoals = classicGoals.filter(
    (candidate) => (celebrationEnd(candidate) ?? 0) > nowMs,
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
    celebrationEndsAt: selected ? celebrationEnd(selected) : undefined,
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
