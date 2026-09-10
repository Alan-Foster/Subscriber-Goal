import { context, reddit, redis } from "@devvit/web/server";
import { ensureSavedSubredditDisplayName } from "../data/subredditDisplayNameData";
import { initializeRecentSubscriberIndexMigration } from "../data/subGoalData";
import {
  clearLegacySubscriberErasureTombstones,
  initializeSubscriberStatsMigration,
} from "../data/subscriberStats";
import { initializeOnboardingSubscriberGoal } from "../core/onboardingSubscriberGoal";
import { scheduleOnboardingReminder } from "../core/onboardingReminder";
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
  if (!subredditName) {
    try {
      subredditName = (await reddit.getCurrentSubreddit()).name;
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
  if (lifecycleSource === "install") {
    await initializeOnboardingSubscriberGoal(redis, { lifecycleSource });
    await scheduleOnboardingReminder(redis, { lifecycleSource });
  }
  await runPhase("recent_subscriber_index_migration", () =>
    initializeRecentSubscriberIndexMigration(redis),
  );
}
