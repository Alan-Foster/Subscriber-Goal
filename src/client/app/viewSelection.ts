import type {
  CtaOnlyState,
  SubGoalState,
  SubscribeOnlyState,
  SubscriberGoalState,
} from "../../shared/types/api";

export type PageName =
  | "subGoal"
  | "thanks"
  | "completed"
  | "tinyConfirmation"
  | "notificationConfirmation"
  | "notifications"
  | "statistics";

export type TinySubscribeViewPhase =
  "subscribe" | "confirmation" | "subscribed" | "notifications";

type GoalView =
  | { page: "statistics" | "notifications"; state: SubGoalState }
  | {
      page: "cta";
      state: CtaOnlyState;
      action: Exclude<
        CtaOnlyState["afterSubscribeAction"],
        { type: "disabled" }
      >;
    }
  | { page: "tinyConfirmation"; state: SubscribeOnlyState }
  | {
      page: "thanks" | "subGoal";
      state: SubscriberGoalState | SubscribeOnlyState;
    }
  | {
      page: "notificationConfirmation" | "completed";
      state: SubscriberGoalState;
    };

export function selectGoalView(
  page: PageName,
  state: SubGoalState | null,
): GoalView | null {
  if (!state) return null;
  if (page === "statistics" || page === "notifications") return { page, state };
  if (state.postHeight === "cta") {
    const action = state.afterSubscribeAction;
    return action.type === "disabled" ? null : { page: "cta", state, action };
  }
  if (page === "thanks") return { page, state };
  if (state.postHeight === "tiny") {
    return page === "tinyConfirmation"
      ? { page, state }
      : { page: "subGoal", state };
  }
  if (page === "completed" || page === "notificationConfirmation")
    return { page, state };
  return { page: "subGoal", state };
}

export function getGoalFrameColor(
  page: PageName,
  state: SubGoalState | null,
  notificationSettingsEnabled: boolean,
): SubGoalState["colorTheme"] | undefined {
  if (!state) return undefined;
  if (
    page === "notifications" ||
    state.afterSubscribeAction.type === "disabled"
  )
    return state.colorTheme;
  if (
    state.postHeight === "cta" ||
    (state.subscribed === true &&
      page !== "completed" &&
      page !== "tinyConfirmation" &&
      (page !== "thanks" || !notificationSettingsEnabled) &&
      page !== "notificationConfirmation")
  )
    return state.afterSubscribeAction.colorTheme;
  return state.colorTheme;
}

export function getGoalFrameHeight(
  postHeight: SubGoalState["postHeight"] | undefined,
): string {
  if (postHeight === "tiny" || postHeight === "cta") return "h-[100px]";
  return postHeight === "short" ? "h-[234px]" : "h-[320px]";
}

export function selectSubscribeOnlyPhase(
  phase: TinySubscribeViewPhase,
  subscribed: boolean,
  interactionStarted: boolean,
): TinySubscribeViewPhase {
  if (phase !== "subscribe") return phase;
  return subscribed && !interactionStarted ? "subscribed" : "subscribe";
}
