import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JourneyReceipt } from "@devvit/analytics/shared/reddit";
import {
  GoalJourneyAnalytics,
  type JourneyClient,
} from "./goalJourneyAnalytics";
import type { GoalJourneyContext } from "../../shared/goalJourneyAnalytics";

const validReceipt: JourneyReceipt = {
  status: "JOURNEY_RECEIPT_VALID",
  message: "recorded",
};

const context: GoalJourneyContext = {
  goalSize: "tiny",
  entryState: "unsubscribed",
  hasFollowupCta: true,
};

const createClient = () => {
  let journeyId: string | undefined;
  const client = {
    appReady: vi.fn(async () => ({ receipt: validReceipt })),
    startJourney: vi.fn(async () => {
      journeyId = "journey-1";
      return { journeyId, receipt: validReceipt };
    }),
    interaction: vi.fn(async () => ({ receipt: validReceipt })),
    progress: vi.fn(async () => ({ receipt: validReceipt })),
    endJourney: vi.fn(async () => {
      journeyId = undefined;
      return { receipt: validReceipt };
    }),
    getActiveJourneyId: vi.fn(() => journeyId),
  } satisfies JourneyClient;
  return client;
};

describe("GoalJourneyAnalytics", () => {
  let client: ReturnType<typeof createClient>;
  let analytics: GoalJourneyAnalytics;

  beforeEach(() => {
    client = createClient();
    analytics = new GoalJourneyAnalytics(client);
  });

  it("reports App.Ready without starting a journey", async () => {
    analytics.appReady();
    await analytics.settled();

    expect(client.appReady).toHaveBeenCalledOnce();
    expect(client.startJourney).not.toHaveBeenCalled();
  });

  it("starts only after a committed background celebration", async () => {
    analytics.committedInteraction();
    analytics.celebrationTriggered(context);
    await analytics.settled();

    expect(client.startJourney).toHaveBeenCalledTimes(2);
    expect(client.interaction).toHaveBeenCalledWith({
      action: "celebration_triggered",
      actionDetails: JSON.stringify({
        goal_size: "tiny",
        entry_state: "unsubscribed",
        has_followup_cta: true,
      }),
    });
  });

  it("starts for committed controls that do not have a named event", async () => {
    analytics.committedInteraction();
    await analytics.settled();

    expect(client.startJourney).toHaveBeenCalledOnce();
    expect(client.interaction).not.toHaveBeenCalled();
  });

  it("keeps a successful subscription open when a follow-up CTA exists", async () => {
    analytics.subscribeActivated(context);
    analytics.subscribeSucceeded(context);
    await analytics.settled();

    expect(client.progress).toHaveBeenCalledWith({
      progress: 0.5,
      action: "subscribe_succeeded",
      actionDetails: expect.stringContaining('"result":"success"'),
    });
    expect(client.endJourney).not.toHaveBeenCalled();
  });

  it("ends a successful subscription when there is no follow-up CTA", async () => {
    analytics.subscribeSucceeded({ ...context, hasFollowupCta: false });
    await analytics.settled();

    expect(client.interaction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "subscribe_succeeded" }),
    );
    expect(client.endJourney).toHaveBeenCalledWith({ complete: true });
  });

  it("records and completes the configured second-state CTA", async () => {
    analytics.afterSubscribeCtaActivated(context, "top-post-day");
    analytics.afterSubscribeCtaOpened(context, "top-post-day");
    await analytics.settled();

    expect(client.interaction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "after_subscribe_cta_activated",
        actionDetails: expect.stringContaining('"action_type":"top-post-day"'),
      }),
    );
    expect(client.interaction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "after_subscribe_cta_opened" }),
    );
    expect(client.endJourney).toHaveBeenCalledWith({ complete: true });
  });

  it("records r/SubGoal as a completed promo action", async () => {
    analytics.promoSubgoalActivated({
      ...context,
      entryState: "completed",
    });
    await analytics.settled();

    const [{ actionDetails }] = client.interaction.mock.calls[0] ?? [];
    expect(client.interaction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "promo_subgoal_activated" }),
    );
    expect(JSON.parse(actionDetails ?? "{}")).toEqual({
      goal_size: "tiny",
      entry_state: "completed",
      has_followup_cta: true,
      action_type: "promo",
      result: "success",
    });
    expect(actionDetails).not.toContain("url");
  });

  it("exposes only an existing journey id to application routes", async () => {
    expect(analytics.journeyHeaders()).toEqual({});
    analytics.subscribeActivated(context);
    await analytics.settled();
    expect(analytics.journeyHeaders()).toEqual({
      "x-devvit-journey-id": "journey-1",
    });
  });
});
