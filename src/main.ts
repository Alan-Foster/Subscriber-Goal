import {Devvit} from '@devvit/public-api';

// Custom Post
export {customPostType} from './customPost/index.js';
// Buttons
export {createGoalButton} from './buttons/createGoalButton.js';
export {deleteGoalButton} from './buttons/deleteGoalButton.js';
export {eraseDataButton} from './buttons/eraseDataButton.js';
// Forms
export {createGoalForm} from './forms/createGoalForm.js';
export {deleteGoalForm} from './forms/deleteGoalForm.js';
export {eraseDataForm} from './forms/eraseDataForm.js';
// Scheduler
export {postsUpdaterJob} from './triggers/scheduler.js';
// Settings
export {appSettings} from './settings.js';
// Triggers
export {appChangedTrigger} from './triggers/appChanged.js';
export {modActionTrigger} from './triggers/modAction.js';

Devvit.configure({redditAPI: true, redis: true, media: true, realtime: true});

export default Devvit;
