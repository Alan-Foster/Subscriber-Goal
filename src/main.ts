import {Devvit} from '@devvit/public-api';

export {createSubGoalButton} from './buttons/createSubGoalButton.js';
export {customPostType} from './customPost/index.js';
export {createSubGoalForm} from './forms/createSubGoalForm.js';

Devvit.configure({redditAPI: true, redis: true, media: true, realtime: true});

export default Devvit;
