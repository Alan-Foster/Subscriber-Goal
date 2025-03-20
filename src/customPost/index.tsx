import {Devvit} from '@devvit/public-api';

import {Page, Router} from './router.js';

export const customPostType = Devvit.addCustomPostType({
  name: 'SubscriberGoal',
  height: 'tall',
  render: context => {
    // This is where you could perform a subreddit check which would allow rendering a different post for r/SubGoal
    const router = new Router(context, 'subGoal');
    return (
      <blocks>
        <Page context={context} router={router} />
      </blocks>
    );
  },
});
