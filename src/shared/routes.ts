export const apiRoutes = {
  init: '/api/init',
  refresh: '/api/refresh',
  subscribe: '/api/subscribe',
} as const;

export const internalRoutes = {
  triggers: {
    onAppInstall: '/internal/triggers/on-app-install',
    onAppUpgrade: '/internal/triggers/on-app-upgrade',
    onModAction: '/internal/triggers/on-mod-action',
  },
  scheduler: {
    postsUpdaterJob: '/internal/scheduler/posts-updater-job',
  },
  menu: {
    createGoal: '/internal/menu/create-goal',
    deleteGoal: '/internal/menu/delete-goal',
    eraseData: '/internal/menu/erase-data',
  },
  forms: {
    createGoal: '/internal/form/create-goal',
    deleteGoal: '/internal/form/delete-goal',
    eraseData: '/internal/form/erase-data',
  },
} as const;

export const formNames = {
  createGoal: 'createGoalForm',
  deleteGoal: 'deleteGoalForm',
  eraseData: 'eraseDataForm',
} as const;
