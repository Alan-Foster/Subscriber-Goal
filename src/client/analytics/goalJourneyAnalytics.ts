import {
  telemetry,
  type TelemetryClient,
} from "@devvit/analytics/client/reddit";
import type { AfterSubscribeAction } from "../../shared/afterSubscribeAction";
import {
  createGoalJourneyDetails,
  journeyIdHeader,
  type GoalJourneyActionType,
  type GoalJourneyContext,
  type GoalJourneyFailureResult,
} from "../../shared/goalJourneyAnalytics";
import type { SubGoalState } from "../../shared/types/api";

export type JourneyClient = Pick<
  TelemetryClient,
  | "appReady"
  | "startJourney"
  | "interaction"
  | "progress"
  | "endJourney"
  | "getActiveJourneyId"
>;

type ReceiptResponse = Awaited<ReturnType<JourneyClient["interaction"]>>;

const logReceipt = (event: string, response: ReceiptResponse): void => {
  const { receipt } = response;
  if (
    receipt.status !== "JOURNEY_RECEIPT_VALID" &&
    receipt.status !== "JOURNEY_RECEIPT_DENIED_DUPLICATE"
  ) {
    console.info(`[journeys] ${event}: ${receipt.status} - ${receipt.message}`);
  }
};

export function getGoalJourneyContext(state: SubGoalState): GoalJourneyContext {
  const completed = state.postHeight !== "tiny" && state.completedTime !== null;
  return {
    goalSize: state.postHeight,
    entryState: completed
      ? "completed"
      : state.subscribed
        ? "subscribed"
        : "unsubscribed",
    hasFollowupCta: state.afterSubscribeAction.type !== "disabled",
  };
}

export class GoalJourneyAnalytics {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly client: JourneyClient) {}

  appReady(): void {
    this.enqueue("app_ready", async () => this.client.appReady());
  }

  celebrationTriggered(context: GoalJourneyContext): void {
    this.interaction("celebration_triggered", context);
  }

  committedInteraction(): void {
    this.enqueue("journey_start", async () => this.client.startJourney());
  }

  subscribeActivated(context: GoalJourneyContext): void {
    this.interaction("subscribe_activated", context);
  }

  subscribeSucceeded(
    context: GoalJourneyContext,
    serverRecorded = false,
  ): void {
    if (serverRecorded) return;
    this.enqueue("subscribe_succeeded", async () => {
      await this.ensureJourney();
      const actionDetails = createGoalJourneyDetails(context, {
        result: "success",
      });
      if (context.hasFollowupCta) {
        return this.client.progress({
          progress: 0.5,
          action: "subscribe_succeeded",
          actionDetails,
        });
      }
      const response = await this.client.interaction({
        action: "subscribe_succeeded",
        actionDetails,
      });
      logReceipt("subscribe_succeeded", response);
      return this.client.endJourney({ complete: true });
    });
  }

  subscribeFailed(
    context: GoalJourneyContext,
    result: Extract<
      GoalJourneyFailureResult,
      "login_required" | "api_error" | "missing_result"
    >,
  ): void {
    this.interactionAndEnd("subscribe_failed", context, false, { result });
  }

  afterSubscribeCtaActivated(
    context: GoalJourneyContext,
    actionType: GoalJourneyActionType,
  ): void {
    this.interaction("after_subscribe_cta_activated", context, { actionType });
  }

  afterSubscribeCtaOpened(
    context: GoalJourneyContext,
    actionType: GoalJourneyActionType,
  ): void {
    this.interactionAndEnd("after_subscribe_cta_opened", context, true, {
      actionType,
      result: "success",
    });
  }

  afterSubscribeCtaFailed(
    context: GoalJourneyContext,
    actionType: GoalJourneyActionType,
    result: Extract<
      GoalJourneyFailureResult,
      "target_unavailable" | "target_error"
    >,
  ): void {
    this.interactionAndEnd("after_subscribe_cta_failed", context, false, {
      actionType,
      result,
    });
  }

  promoSubgoalActivated(context: GoalJourneyContext): void {
    this.interactionAndEnd("promo_subgoal_activated", context, true, {
      actionType: "promo",
      result: "success",
    });
  }

  journeyHeaders(): Record<string, string> {
    const journeyId = this.client.getActiveJourneyId();
    return journeyId ? { [journeyIdHeader]: journeyId } : {};
  }

  settled(): Promise<void> {
    return this.queue;
  }

  private interaction(
    action: string,
    context: GoalJourneyContext,
    options: Parameters<typeof createGoalJourneyDetails>[1] = {},
  ): void {
    this.enqueue(action, async () => {
      await this.ensureJourney();
      return this.client.interaction({
        action,
        actionDetails: createGoalJourneyDetails(context, options),
      });
    });
  }

  private interactionAndEnd(
    action: string,
    context: GoalJourneyContext,
    complete: boolean,
    options: Parameters<typeof createGoalJourneyDetails>[1] = {},
  ): void {
    this.enqueue(action, async () => {
      await this.ensureJourney();
      const response = await this.client.interaction({
        action,
        actionDetails: createGoalJourneyDetails(context, options),
      });
      logReceipt(action, response);
      return this.client.endJourney({ complete });
    });
  }

  private async ensureJourney(): Promise<void> {
    const response = await this.client.startJourney();
    logReceipt("journey_start", response);
  }

  private enqueue(
    event: string,
    operation: () => Promise<ReceiptResponse>,
  ): void {
    this.queue = this.queue
      .then(async () => {
        const response = await operation();
        logReceipt(event, response);
      })
      .catch((error: unknown) => {
        console.info(`[journeys] ${event} was not recorded.`, error);
      });
  }
}

export const goalJourneyAnalytics = new GoalJourneyAnalytics(telemetry);

export function getAfterSubscribeAnalyticsActionType(
  action: Exclude<AfterSubscribeAction, { type: "disabled" }>,
): GoalJourneyActionType {
  return action.type;
}
