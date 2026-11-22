import { context, reddit, redis, scheduler } from "@devvit/web/server";
import { ensureSavedSubredditDisplayName } from "../data/subredditDisplayNameData";
import {
  getOnboardingEligibility,
  getOnboardingSubscriberGoalState,
  initializeOnboardingSubscriberGoal,
  markOnboardingSubscriberGoalIneligible,
  AUTOMATIC_ONBOARDING_ENABLED,
  onboardingMinimumSubscriberCount,
} from "../core/onboardingSubscriberGoal";
import {
  getOnboardingReminderState,
  markOnboardingReminderIneligible,
  scheduleOnboardingReminder,
} from "../core/onboardingReminder";
import { logDiagnostic } from "../../shared/diagnostics";
import { rememberAppInstaller } from "../core/appAccountHealth";
import { recordLifecycleAndScheduleRecovery } from "../core/appAccountRecovery";
import { scheduleAppRepair } from "../core/appRepair";
import { reconcileOnboardingForLifecycle } from "../core/onboardingLifecycle";

type LifecycleSource = "install" | "upgrade" | "unknown";
type InstallOrUpgrade = Exclude<LifecycleSource, "unknown">;
type LifecycleSubreddit = Awaited<
  ReturnType<typeof reddit.getCurrentSubreddit>
>;

export async function onAppChanged({
  lifecycleSource = "unknown",
  installerUsername,
}: {
  lifecycleSource?: LifecycleSource;
  installerUsername?: string;
} = {}): Promise<void> {
  const community = await resolveLifecycleCommunity();
  if (!community) return;

  await recordLifecycleAndScheduleRepairs(
    lifecycleSource,
    community.subredditName,
    installerUsername,
  );
  await saveLifecycleDisplayName(community.subredditName);
  if (lifecycleSource === "install" || lifecycleSource === "upgrade") {
    await setUpLifecycleOnboarding(
      lifecycleSource,
      installerUsername,
      community.currentSubreddit,
    );
  }
}

async function resolveLifecycleCommunity() {
  if (!context.subredditName && !context.subredditId) {
    console.info(
      "[appChanged] skipping subreddit setup: no subreddit context on lifecycle trigger",
    );
    return;
  }

  let subredditName = context.subredditName;
  let currentSubreddit: LifecycleSubreddit | undefined;
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
  return { subredditName, currentSubreddit };
}

async function recordLifecycleAndScheduleRepairs(
  lifecycleSource: LifecycleSource,
  subredditName: string,
  installerUsername: string | undefined,
): Promise<void> {
  await rememberAppInstaller(redis, installerUsername);
  if (lifecycleSource === "install" || lifecycleSource === "upgrade") {
    await recordLifecycleAndScheduleRecovery({
      redis,
      scheduler,
      lifecycleSource,
      subredditName,
      ...(context.subredditId ? { subredditId: context.subredditId } : {}),
      ...(installerUsername ? { installerUsername } : {}),
    });
  }
  await scheduleAppRepair(redis, Date.now(), undefined, {
    force: lifecycleSource === "install" || lifecycleSource === "upgrade",
    reason: `lifecycle_${lifecycleSource}`,
  });
}

async function saveLifecycleDisplayName(subredditName: string): Promise<void> {
  try {
    await ensureSavedSubredditDisplayName(redis, subredditName);
  } catch (error) {
    logDiagnostic(
      "warn",
      "app_changed_phase_failed",
      { workflow: "app_changed", phase: "subreddit_display_name" },
      error,
    );
  }
}

async function setUpLifecycleOnboarding(
  lifecycleSource: InstallOrUpgrade,
  installerUsername: string | undefined,
  currentSubreddit: LifecycleSubreddit | undefined,
): Promise<void> {
  const automaticOnboardingEnabled =
    shouldInitializeReleaseOnboarding(lifecycleSource);
  const eligibility = await checkLifecycleOnboardingEligibility(
    lifecycleSource,
    installerUsername,
    currentSubreddit,
  );
  const reconciliation = await reconcileOnboardingForLifecycle(reddit, redis, {
    lifecycleSource,
    allowOnboardingRearm: automaticOnboardingEnabled && eligibility.eligible,
  });
  const reconciliationStatus = reconciliation.status;
  if (automaticOnboardingEnabled) {
    await initializeLifecycleOnboarding(lifecycleSource, eligibility);
  }
  await reportLifecycleOnboardingState(
    lifecycleSource,
    installerUsername,
    eligibility.eligible,
    reconciliationStatus,
  );
}

async function checkLifecycleOnboardingEligibility(
  lifecycleSource: InstallOrUpgrade,
  installerUsername: string | undefined,
  currentSubreddit: LifecycleSubreddit | undefined,
) {
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
    upgradeActor: installerUsername ?? "unknown",
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
  return eligibility;
}

async function initializeLifecycleOnboarding(
  lifecycleSource: InstallOrUpgrade,
  eligibility: ReturnType<typeof getOnboardingEligibility>,
): Promise<void> {
  await initializeOnboardingSubscriberGoal(redis, { lifecycleSource });
  await scheduleOnboardingReminder(redis, { lifecycleSource });
  if (!eligibility.eligible) {
    const nowMs = Date.now();
    await markOnboardingReminderIneligible(
      redis,
      eligibility.subscriberCount,
      nowMs,
      eligibility.reason,
    );
    await markOnboardingSubscriberGoalIneligible(
      redis,
      eligibility.subscriberCount,
      nowMs,
      eligibility.reason,
    );
  }
}

async function reportLifecycleOnboardingState(
  lifecycleSource: InstallOrUpgrade,
  installerUsername: string | undefined,
  eligible: boolean,
  reconciliationStatus: Awaited<
    ReturnType<typeof reconcileOnboardingForLifecycle>
  >["status"],
): Promise<void> {
  const [goalState, reminderState] = await Promise.all([
    getOnboardingSubscriberGoalState(redis),
    getOnboardingReminderState(redis),
  ]);
  const nextAction = describeOnboardingNextAction(goalState, reminderState);
  const details = {
    lifecycleSource,
    upgradeActor: installerUsername ?? "unknown",
    eligible,
    reconciliationStatus,
    nextAction,
    timerArmed:
      reminderState?.status === "pending" || goalState?.status === "pending",
    goalState: goalState?.status ?? "missing_or_unparseable",
    goalResult: goalState?.resultStatus ?? "none",
    goalOperationId: goalState?.operationId ?? "none",
    goalArmedAt: goalState?.armedAt ?? "none",
    goalNextRunAt: goalState?.nextRunAt ?? "none",
    goalNextRunAtIso: formatOptionalTimestamp(goalState?.nextRunAt),
    reminderState: reminderState?.status ?? "missing_or_unparseable",
    reminderResult: reminderState?.result ?? "none",
    reminderNextRunAt: reminderState?.nextRunAt ?? "none",
    reminderNextRunAtIso: formatOptionalTimestamp(reminderState?.nextRunAt),
  };
  logDiagnostic("info", "onboarding_lifecycle_setup_complete", {
    workflow: "onboarding_lifecycle",
    phase: "lifecycle_setup_complete",
    ...details,
  });
  console.info(
    `[appChanged] onboarding setup: reconciliation=${reconciliationStatus} nextAction=${nextAction} timerArmed=${details.timerArmed} goal=${details.goalState}/${details.goalResult} reminder=${details.reminderState}/${details.reminderResult} reminderNextRunAt=${details.reminderNextRunAtIso} goalNextRunAt=${details.goalNextRunAtIso} operationId=${details.goalOperationId}`,
  );
}

function describeOnboardingNextAction(
  goalState:
    Awaited<ReturnType<typeof getOnboardingSubscriberGoalState>> | undefined,
  reminderState:
    Awaited<ReturnType<typeof getOnboardingReminderState>> | undefined,
): string {
  if (reminderState?.status === "pending") return "awaiting_modmail_timer";
  if (
    reminderState?.status === "processing" ||
    reminderState?.status === "dispatching"
  ) {
    return "modmail_processing";
  }
  if (goalState?.status === "pending") return "awaiting_goal_creation_timer";
  if (goalState?.status === "processing") return "goal_creation_processing";
  if (goalState?.status === "complete") return "terminal_no_action";
  if (goalState?.status === "awaiting_warning")
    return "awaiting_reminder_state";
  return "no_runnable_workflow";
}

function formatOptionalTimestamp(timestamp: number | undefined): string {
  return timestamp === undefined ? "none" : new Date(timestamp).toISOString();
}

export function shouldInitializeReleaseOnboarding(
  lifecycleSource: LifecycleSource,
  automationEnabled = AUTOMATIC_ONBOARDING_ENABLED,
): boolean {
  return (
    automationEnabled &&
    (lifecycleSource === "install" || lifecycleSource === "upgrade")
  );
}
