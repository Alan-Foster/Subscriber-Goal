export const apiRoutes = {
  init: "/api/init",
  refresh: "/api/refresh",
  subscribe: "/api/subscribe",
  afterSubscribeTarget: "/api/after-subscribe-target",
  ctaClick: "/api/cta-click",
  notificationSettings: "/api/notification-settings",
} as const;

export const internalRoutes = {
  triggers: {
    onAppInstall: "/internal/triggers/on-app-install",
    onAppUpgrade: "/internal/triggers/on-app-upgrade",
    onModAction: "/internal/triggers/on-mod-action",
    onPostCreate: "/internal/triggers/on-post-create",
  },
  scheduler: {
    postsUpdaterJob: "/internal/scheduler/posts-updater-job",
    milestoneNotificationJob: "/internal/scheduler/milestone-notification-job",
  },
  menu: {
    createGoal: "/internal/menu/create-goal",
    deleteGoal: "/internal/menu/delete-goal",
    eraseData: "/internal/menu/erase-data",
    eraseMyData: "/internal/menu/erase-my-data",
  },
  forms: {
    createGoalSetup: "/internal/form/create-goal/setup",
    createSubscriberGoal: "/internal/form/create-goal/subscriber-goal",
    createSubscribeOnly: "/internal/form/create-goal/subscribe-only",
    createCtaOnly: "/internal/form/create-goal/cta-only",
    createSubscriberGoalFollowUp:
      "/internal/form/create-goal/subscriber-goal/follow-up",
    createSubscribeOnlyFollowUp:
      "/internal/form/create-goal/subscribe-only/follow-up",
    createCtaOnlyFollowUp: "/internal/form/create-goal/cta-only/follow-up",
    deleteGoal: "/internal/form/delete-goal",
    eraseData: "/internal/form/erase-data",
    eraseMyData: "/internal/form/erase-my-data",
  },
} as const;

export const formNames = {
  createGoalSetup: "createGoalSetupForm",
  createSubscriberGoal: "createSubscriberGoalForm",
  createSubscribeOnly: "createSubscribeOnlyForm",
  createCtaOnly: "createCtaOnlyForm",
  createSubscriberGoalFollowUp: "createSubscriberGoalFollowUpForm",
  createSubscribeOnlyFollowUp: "createSubscribeOnlyFollowUpForm",
  createCtaOnlyFollowUp: "createCtaOnlyFollowUpForm",
  deleteGoal: "deleteGoalForm",
  eraseData: "eraseDataForm",
  eraseMyData: "eraseMyDataForm",
} as const;
