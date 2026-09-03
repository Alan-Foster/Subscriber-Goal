import { telemetry } from "@devvit/analytics/server/reddit";
import type { Request } from "express";
import {
  createGoalJourneyDetails,
  journeyIdHeader,
} from "../../shared/goalJourneyAnalytics";
import type { SubGoalState } from "../../shared/types/api";

export function getRequestJourneyId(req: Request): string | undefined {
  const value =
    typeof req.header === "function"
      ? req.header(journeyIdHeader)?.trim()
      : undefined;
  return value ? value : undefined;
}

export function recordServerSubscribeSuccess(
  journeyId: string | undefined,
  state: SubGoalState,
): boolean {
  if (!journeyId) return false;

  const hasFollowupCta =
    state.afterSubscribeAction !== undefined &&
    state.afterSubscribeAction.type !== "disabled";
  const actionDetails = createGoalJourneyDetails(
    {
      goalSize: state.postHeight,
      entryState: "unsubscribed",
      hasFollowupCta,
    },
    { result: "success" },
  );

  void (async () => {
    const response = hasFollowupCta
      ? await telemetry.journeyProgress({
          journeyId,
          progress: 0.5,
          action: "subscribe_succeeded",
          actionDetails,
        })
      : await telemetry.journeyInteraction({
          journeyId,
          action: "subscribe_succeeded",
          actionDetails,
        });
    if (response.receipt.status !== "JOURNEY_RECEIPT_VALID") {
      console.info(
        `[journeys] subscribe_succeeded: ${response.receipt.status} - ${response.receipt.message}`,
      );
    }
    if (!hasFollowupCta) {
      await telemetry.endJourney({ journeyId, complete: true });
    }
  })().catch((error: unknown) => {
    console.info(
      "[journeys] Server subscription result was not recorded.",
      error,
    );
  });

  return true;
}
