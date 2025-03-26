import {Devvit} from '@devvit/public-api';

import {Page, Router} from './router.js';

export const customPostType = Devvit.addCustomPostType({
  name: 'SubscriberGoal',
  height: 'regular',
  render: context => {
    // This is where you could perform a subreddit check which would allow rendering a different post for r/SubGoal
    const router = new Router(context, 'subGoal');
    return (
      <blocks height='regular'>
        <Page router={router} />
      </blocks>
    );
  },
});
