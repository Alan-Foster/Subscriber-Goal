/**
 * @file This file contains the entry point for the app's custom post type.
 * The only thing handled here is the post definition and page routing.
 * The actual content is rendered on the Page components, which are swapped between and managed by the Router.
 */

import {Devvit} from '@devvit/public-api';

import {Page, Router} from './router.js';

/**
 * @description Adds the custom post type. This is exported via main.js, which tells Devvit about the custom post type.
 */
export const customPostType = Devvit.addCustomPostType({
  name: 'SubscriberGoal',
  height: 'regular',
  render: context => {
    // This is where you could perform a subreddit check which would allow rendering a different post for r/SubGoal
    const router = new Router(context, 'subGoal');
    return (
      <blocks height='regular'>
        {/* This is the mechanism that controls which page is currently being displayed.
            Page is a component in the router file that returns the current page component from Pages list.*/}
        <Page router={router} />
      </blocks>
    );
  },
});
