import {Devvit} from '@devvit/public-api';

// Custom Post
export {customPostType} from './customPost/index.js';
// Buttons
export {createMenuItem} from './buttons/createMenuItem.js';
// Forms
export {createForm} from './forms/createForm.js';
// Scheduler
export {postsUpdaterJob} from './triggers/scheduler.js';
// Settings
export {appSettings} from './settings.js';
// Triggers
export {appChangedTrigger} from './triggers/appChanged.js';
export {modActionTrigger} from './triggers/modAction.js';
export {postDeleteTrigger} from './triggers/postDelete.js';

Devvit.configure({redditAPI: true, redis: true, media: true, realtime: true});

export default Devvit;
