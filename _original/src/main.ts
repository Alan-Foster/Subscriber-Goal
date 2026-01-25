/**
 * @file This is the main entry point for a Devvit app, we are keeping it simple and separating all Devvit definitions into their own files.
 * It exports all the buttons, forms, triggers, etc that we've defined elsewhere in the app.
 */

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
