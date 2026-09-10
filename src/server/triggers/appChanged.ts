import { context, reddit, redis } from "@devvit/web/server";
import { ensureSavedSubredditDisplayName } from "../data/subredditDisplayNameData";
import { initializeRecentSubscriberIndexMigration } from "../data/subGoalData";
import {
  clearLegacySubscriberErasureTombstones,
  initializeSubscriberStatsMigration,
} from "../data/subscriberStats";
import { getTrackedPosts, queueUpdates } from "../data/updaterData";
import { initializePostKindMigration } from "../data/postKindMigration";
import { initializeLegacyAfterSubscribeActionMigration } from "../data/legacyAfterSubscribeActionMigration";
import { initializeOnboardingSubscriberGoal } from "../core/onboardingSubscriberGoal";
import { scheduleOnboardingReminder } from "../core/onboardingReminder";
import {
  backfillSubscriberGoalPostFlair,
  ensureSubscriberGoalPostFlair,
} from "../core/subscriberGoalPostFlair";
import { getSubscriberGoalCandidatePostIds } from "../data/subscriberGoalCandidates";
import { reconcileSubscriberGoalStickies } from "../utils/redditUtils";
import { ensureCommunityPostActivityBackfill } from "../data/ctaActivity";
import { logDiagnostic } from "../../shared/diagnostics";
import {
  checkAppAccountHealth,
  rememberAppInstaller,
} from "../core/appAccountHealth";

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

  let currentSubreddit:
    | Awaited<ReturnType<typeof reddit.getCurrentSubreddit>>
    | undefined;
  let subredditName = context.subredditName;
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
      return;
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

  await runPhase("installer_persistence", () =>
    rememberAppInstaller(redis, installerUsername),
  );

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
    await runPhase("onboarding_goal_initialization", () =>
      initializeOnboardingSubscriberGoal(redis, { lifecycleSource }),
    );
    await runPhase("onboarding_reminder_initialization", () =>
      scheduleOnboardingReminder(redis, { lifecycleSource }),
    );
  }
  await runPhase("recent_subscriber_index_migration", () =>
    initializeRecentSubscriberIndexMigration(redis),
  );
  await runPhase("activity_backfill", () =>
    ensureCommunityPostActivityBackfill(reddit, redis, subredditName),
  );

  let lifecycleSubreddit: { id: string; name: string } | undefined =
    context.subredditId
      ? { id: context.subredditId, name: subredditName }
      : undefined;
  if (!currentSubreddit) {
    try {
      currentSubreddit = await reddit.getCurrentSubreddit();
      lifecycleSubreddit ??= currentSubreddit;
    } catch (error) {
      logDiagnostic(
        "warn",
        "app_changed_phase_failed",
        { workflow: "app_changed", phase: "repair_subreddit_resolution" },
        error,
      );
    }
  }

  await runPhase("app_account_health", () =>
    checkAppAccountHealth({
      reddit,
      redis,
      subredditName,
      ...(lifecycleSubreddit?.id ? { subredditId: lifecycleSubreddit.id } : {}),
    }),
  );

  let candidatePostIds: string[] | undefined;
  try {
    candidatePostIds = await getSubscriberGoalCandidatePostIds(redis);
  } catch (error) {
    logDiagnostic(
      "warn",
      "app_changed_phase_failed",
      { workflow: "app_changed", phase: "repair_candidate_discovery" },
      error,
    );
  }

  let flairId: string | undefined;
  try {
    flairId = (await ensureSubscriberGoalPostFlair(reddit, subredditName)).id;
  } catch (error) {
    logDiagnostic(
      "warn",
      "app_changed_phase_failed",
      { workflow: "app_changed", phase: "flair_ensure" },
      error,
    );
  }
  if (lifecycleSubreddit && candidatePostIds && flairId) {
    try {
      await backfillSubscriberGoalPostFlair(
        reddit,
        lifecycleSubreddit,
        candidatePostIds,
        flairId,
      );
    } catch (error) {
      logDiagnostic(
        "warn",
        "app_changed_phase_failed",
        { workflow: "app_changed", phase: "flair_backfill" },
        error,
      );
    }
  }
  if (lifecycleSubreddit && candidatePostIds) {
    try {
      const result = await reconcileSubscriberGoalStickies(reddit, {
        knownPostIds: candidatePostIds,
        subreddit: lifecycleSubreddit,
      });
      console.info(
        `[appChanged] Subscriber Goal pin reconciliation: kept=${result.keptPostId ?? "none"} unstickied=${result.unstickied.length} failed=${result.failed.length}`,
      );
    } catch (error) {
      logDiagnostic(
        "warn",
        "app_changed_phase_failed",
        { workflow: "app_changed", phase: "sticky_reconciliation" },
        error,
      );
    }
  }

  let trackedPosts: string[] = [];
  await runPhase("tracked_post_discovery", async () => {
    trackedPosts = await getTrackedPosts(redis);
  });
  await runPhase("post_kind_migration", () =>
    initializePostKindMigration(redis, trackedPosts),
  );
  const migrationCandidates = candidatePostIds ?? trackedPosts;
  try {
    const migrationSubreddit = {
      name: subredditName,
      type: currentSubreddit?.type,
    };
    await initializeLegacyAfterSubscribeActionMigration(
      redis,
      migrationCandidates,
      migrationSubreddit,
    );
  } catch (error) {
    logDiagnostic(
      "warn",
      "app_changed_phase_failed",
      { workflow: "app_changed", phase: "after_subscribe_action_migration" },
      error,
    );
  }
  if (!trackedPosts.length) {
    return;
  }
  console.log(`Scheduling update queue for: ${trackedPosts.join(",")}`);
  await runPhase("update_queue", () => queueUpdates(redis, trackedPosts));
}
