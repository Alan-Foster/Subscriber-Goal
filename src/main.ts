import {Devvit} from '@devvit/public-api';

// Custom Post
export {customPostType} from './customPost/index.js';
// Buttons
export {createSubGoalButton} from './buttons/createSubGoalButton.js';
// Forms
export {createSubGoalForm} from './forms/createSubGoalForm.js';
// Settings
export {appSettings} from './settings.js';
// Triggers
export {modActionTrigger} from './triggers/modAction.js';
export {postDeleteTrigger} from './triggers/postDelete.js';

Devvit.configure({redditAPI: true, redis: true, media: true, realtime: true});

export default Devvit;
