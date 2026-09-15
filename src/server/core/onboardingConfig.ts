/**
 * Automatic onboarding rollout controls.
 *
 * Keep these values together so test rollouts can be shortened and the
 * production timings can be restored without searching through the workflow.
 * The scheduler runs once per minute, so sub-minute delays are not useful.
 */
export const onboardingMinimumSubscriberCount = 40;

export const onboardingReminderStaggerMinMinutes = 1;
export const onboardingReminderStaggerMaxMinutes = 5;

export const onboardingGoalBaseDelayMs = 5 * 60 * 1000;
export const onboardingGoalStaggerMinMinutes = 1;
export const onboardingGoalStaggerMaxMinutes = 10;
