/**
 * @file Helper functions to send PostCreateEvents to the promo subreddit wiki.
 */

import {Post, RedditAPIClient} from '@devvit/public-api';

import {SubGoalData} from '../../../data/subGoalData.js';
import {WikiEventType} from '../types/baseWikiEvent.js';
import {PostCreateEventData} from '../types/postCreateEvent.js';
import {sendWikiEvent} from './wikiEventSender.js';

export type SendPostCreateEventProps = {
  reddit: RedditAPIClient;
  targetSubredditName: string;
  post: Post;
  subGoalData: SubGoalData;
}

/**
 * Sends a PostActionEvent to the specified subreddit wiki.
 * @param props - SendPostActionEventProps object.
 * @param props.reddit - Instance of RedditAPIClient.
 * @param props.post - The ID of the post the action was taken on.
 * @param props.subGoalData - Optional timestamp of when the action was taken. If not provided, the current time will be used.
 * @param props.targetSubredditName - This is the name of the subreddit where the wiki event will be sent.
 */
export async function sendPostCreateEvent ({reddit, targetSubredditName, post, subGoalData}: SendPostCreateEventProps) {
  const eventData: PostCreateEventData = {
    type: WikiEventType.PostCreateEvent,
    postId: post.id,
    subGoal: subGoalData.goal,
    subredditDisplayName: subGoalData.subredditDisplayName ?? post.subredditName,
  };

  if (subGoalData.sendWikiEvents === false) {
    return;
  }

  await sendWikiEvent({
    reddit,
    targetSubredditName,
    eventData,
  });
};
