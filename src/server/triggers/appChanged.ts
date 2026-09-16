import { context, reddit, redis } from "@devvit/web/server";
import { ensureSavedSubredditDisplayName } from "../data/subredditDisplayNameData";
import { initializeRecentSubscriberIndexMigration } from "../data/subGoalData";
import {
  clearLegacySubscriberErasureTombstones,
  initializeSubscriberStatsMigration,
} from "../data/subscriberStats";
import {
  getOnboardingEligibility,
  initializeOnboardingSubscriberGoal,
  markOnboardingSubscriberGoalIneligible,
  AUTOMATIC_ONBOARDING_ENABLED,
  onboardingMinimumSubscriberCount,
} from "../core/onboardingSubscriberGoal";
import {
  markOnboardingReminderIneligible,
  scheduleOnboardingReminder,
} from "../core/onboardingReminder";
import { logDiagnostic } from "../../shared/diagnostics";
import { rememberAppInstaller } from "../core/appAccountHealth";
import { scheduleAppRepair } from "../core/appRepair";

export async function onAppChanged({
  lifecycleSource = "unknown",
  installerUsername,
}: {
  lifecycleSource?: "install" | "upgrade" | "unknown";
  installerUsername?: string;
} = {}): Promise<void> {
  if (!context.subredditName && !context.subredditId) {
    console.info(
      "[appChanged] skipping subreddit setup: no subreddit context on lifecycle trigger",
    );
    return;
  }

  let subredditName = context.subredditName;
  let currentSubreddit:
    | Awaited<ReturnType<typeof reddit.getCurrentSubreddit>>
    | undefined;
  if (!subredditName) {
    try {
      currentSubreddit = await reddit.getCurrentSubreddit();
      subredditName = currentSubreddit.name;
    } catch (error) {
      logDiagnostic(
        "warn",
        "app_changed_phase_failed",
        { workflow: "app_changed", phase: "subreddit_resolution" },
        error,
      );
      throw error;
    }
  }

  const runPhase = async (
    phase: string,
    operation: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      logDiagnostic(
        "warn",
        "app_changed_phase_failed",
        { workflow: "app_changed", phase },
        error,
      );
    }
  };

  await rememberAppInstaller(redis, installerUsername);
  await scheduleAppRepair(redis);

  await runPhase("subreddit_display_name", () =>
    ensureSavedSubredditDisplayName(redis, subredditName),
  );
  await runPhase("subscriber_erasure_cleanup", () =>
    clearLegacySubscriberErasureTombstones(redis),
  );
  await runPhase("subscriber_stats_migration", () =>
    initializeSubscriberStatsMigration(redis),
  );
  if (shouldInitializeReleaseOnboarding(lifecycleSource)) {
    if (!currentSubreddit) {
      try {
        currentSubreddit = await reddit.getCurrentSubreddit();
      } catch (error) {
        logDiagnostic(
          "warn",
          "app_changed_phase_failed",
          { workflow: "app_changed", phase: "onboarding_eligibility" },
          error,
        );
        throw error;
      }
    }
    const eligibility = getOnboardingEligibility(currentSubreddit);
    logDiagnostic("info", "onboarding_eligibility_checked", {
      workflow: "app_changed",
      phase: "lifecycle_setup",
      lifecycleSource,
      subscriberCount: eligibility.subscriberCount,
      minimumSubscriberCount: onboardingMinimumSubscriberCount,
      subredditType: eligibility.subredditType,
      isSfw: eligibility.isSfw,
      safetyStatus: eligibility.safetyStatus,
      eligible: eligibility.eligible,
      reason: eligibility.reason ?? "none",
    });
    console.info(
      `[appChanged] onboarding eligibility: source=${lifecycleSource} subscriberCount=${eligibility.subscriberCount} minimumSubscriberCount=${onboardingMinimumSubscriberCount} subredditType=${eligibility.subredditType} safetyStatus=${eligibility.safetyStatus} isSfw=${eligibility.isSfw} eligible=${eligibility.eligible} reason=${eligibility.reason ?? "none"}`,
    );
    await initializeOnboardingSubscriberGoal(redis, { lifecycleSource });
    await scheduleOnboardingReminder(redis, { lifecycleSource });
    if (!eligibility.eligible) {
      const nowMs = Date.now();
      await markOnboardingReminderIneligible(
        redis,
        eligibility.subscriberCount,
        nowMs,
      );
      await markOnboardingSubscriberGoalIneligible(
        redis,
        eligibility.subscriberCount,
        nowMs,
      );
    }
  }
  await runPhase("recent_subscriber_index_migration", () =>
    initializeRecentSubscriberIndexMigration(redis),
  );
}

export function shouldInitializeReleaseOnboarding(
  lifecycleSource: "install" | "upgrade" | "unknown",
  automationEnabled = AUTOMATIC_ONBOARDING_ENABLED,
): boolean {
  return (
    automationEnabled &&
    (lifecycleSource === "install" || lifecycleSource === "upgrade")
  );
}
