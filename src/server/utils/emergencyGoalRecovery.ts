import type { RedisClient } from "../types";
import { logDiagnostic } from "../../shared/diagnostics";
import { getLastKnownSubscriberCount } from "../data/subscriberDailyStats";
import { getDefaultSubscriberGoal } from "./numberUtils";

export type EmergencySubscriberCountSource =
  | "current"
  | "last_known"
  | "zero_default";

export type EmergencyGoalRecovery = {
  goal: number;
  subscribers: number;
  subscriberCountSource: EmergencySubscriberCountSource;
};

const isSubscriberCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const isUsableSubscriberGoal = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export async function recoverEmergencySubscriberGoal({
  redis,
  postId,
  workflow,
  route,
  currentSubscribers,
  completed,
}: {
  redis: RedisClient;
  postId: string;
  workflow: string;
  route?: string;
  currentSubscribers: unknown;
  completed: boolean;
}): Promise<EmergencyGoalRecovery> {
  let subscribers: number;
  let subscriberCountSource: EmergencySubscriberCountSource;

  if (isSubscriberCount(currentSubscribers)) {
    subscribers = currentSubscribers;
    subscriberCountSource = "current";
  } else {
    const lastKnownSubscribers = await getLastKnownSubscriberCount(redis);
    if (lastKnownSubscribers !== null) {
      subscribers = lastKnownSubscribers;
      subscriberCountSource = "last_known";
    } else {
      subscribers = 0;
      subscriberCountSource = "zero_default";
    }
  }

  const goal = completed
    ? Math.max(1, subscribers)
    : getDefaultSubscriberGoal(subscribers);

  logDiagnostic("error", "subscriber_goal_emergency_fallback", {
    ...(route ? { route } : {}),
    workflow,
    phase: completed ? "completed" : "active",
    postId,
    category: "missing_or_invalid_goal",
    subscriberCountSource,
    recoveredSubscribers: subscribers,
    recoveredGoal: goal,
  });

  return { goal, subscribers, subscriberCountSource };
}
