export const apiRoutes = {
  init: "/api/init",
  refresh: "/api/refresh",
  subscribe: "/api/subscribe",
} as const;

export const internalRoutes = {
  triggers: {
    onAppInstall: "/internal/triggers/on-app-install",
    onAppUpgrade: "/internal/triggers/on-app-upgrade",
    onModAction: "/internal/triggers/on-mod-action",
  },
  scheduler: {
    postsUpdaterJob: "/internal/scheduler/posts-updater-job",
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
    deleteGoal: "/internal/form/delete-goal",
    eraseData: "/internal/form/erase-data",
    eraseMyData: "/internal/form/erase-my-data",
  },
} as const;

export const formNames = {
  createGoalSetup: "createGoalSetupForm",
  createSubscriberGoal: "createSubscriberGoalForm",
  createSubscribeOnly: "createSubscribeOnlyForm",
  deleteGoal: "deleteGoalForm",
  eraseData: "eraseDataForm",
  eraseMyData: "eraseMyDataForm",
} as const;
