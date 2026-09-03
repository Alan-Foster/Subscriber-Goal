import type { AfterSubscribeActionType } from "./afterSubscribeAction";
import type { SubGoalPostHeight } from "./subGoalPostHeight";

export const journeyIdHeader = "x-devvit-journey-id";

export type GoalJourneyEntryState = "unsubscribed" | "subscribed" | "completed";

export type GoalJourneyContext = {
  goalSize: SubGoalPostHeight;
  entryState: GoalJourneyEntryState;
  hasFollowupCta: boolean;
};

export type GoalJourneyActionType =
  | Exclude<AfterSubscribeActionType, "disabled">
  | "promo";

export type GoalJourneyFailureResult =
  | "login_required"
  | "api_error"
  | "missing_result"
  | "target_unavailable"
  | "target_error";

type GoalJourneyDetails = {
  goal_size: SubGoalPostHeight;
  entry_state: GoalJourneyEntryState;
  has_followup_cta: boolean;
  action_type?: GoalJourneyActionType;
  result?: "success" | GoalJourneyFailureResult;
};

export function createGoalJourneyDetails(
  context: GoalJourneyContext,
  options: {
    actionType?: GoalJourneyActionType;
    result?: "success" | GoalJourneyFailureResult;
  } = {},
): string {
  const details: GoalJourneyDetails = {
    goal_size: context.goalSize,
    entry_state: context.entryState,
    has_followup_cta: context.hasFollowupCta,
    ...(options.actionType ? { action_type: options.actionType } : {}),
    ...(options.result ? { result: options.result } : {}),
  };
  return JSON.stringify(details);
}
