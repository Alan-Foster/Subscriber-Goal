/**
 * @file This file contains the logic for creating the static preview and text fallback that is shown when a custom post can't or hasn't yet been loaded.
 */

import {Devvit} from '@devvit/public-api';

import {formatNumberUnlessExact} from '../../utils/numberUtils.js';
import {ProgressBar} from './progressBar.js';
import {SubredditIcon} from './subredditIcon.js';

export type PreviewProps = {
  goal: number;
  subscribers: number;
  subredditName: string;
  subredditIcon: string;
  recentSubscriber: string | null;
  completedTime: Date | null;
}

/**
 * This is the static preview component, it is meant to be used with setCustomPostPreview.
 * @param props - {@linkcode PreviewProps} that are used to populate the static Preview component.
 * @returns A static Preview component that can be used as a custom post preview.
 * @todo This duplicates a lot of the subGoalPage and completedPage code. Maybe split those into more components, so we can reuse them here?
 */
export const Preview = (props: PreviewProps) => {
  let previewContents = <text>Loading Subscriber Goal...</text>;

  if (props.completedTime) {
    previewContents = (
      <vstack alignment="middle center" gap="medium" height="100%" padding="medium" width="100%">
        <SubredditIcon iconUrl={props.subredditIcon} imageHeight={100} imageWidth={100} />
        <text alignment="middle center" selectable={false} size="xxlarge" weight="bold" width="100%" wrap>&nbsp;r/{props.subredditName} reached {formatNumberUnlessExact(props.goal)} subscribers!&nbsp;</text>
        <text alignment="middle center" size="xlarge" weight="bold" width="100%" wrap>
          &nbsp;Goal reached at {props.completedTime.toLocaleTimeString('en', {timeZone: 'UTC'})} on {props.completedTime.toLocaleDateString('en', {timeZone: 'UTC'})}&nbsp;
        </text>
        <button appearance="success" disabled={true} size="large">
          &nbsp;Loading...&nbsp;
        </button>
      </vstack>
    );
  } else {
    previewContents = (
      <vstack alignment="center middle" gap="medium" height="100%" padding="medium" width="100%">
        <spacer size='xsmall' />
        <SubredditIcon iconUrl={props.subredditIcon} imageHeight={100} imageWidth={100} />
        <hstack alignment="center middle" gap='none' padding='none'>
          <text alignment="center middle" size="xlarge" weight="bold" wrap>&nbsp;Welcome to r/</text>
          <text alignment="center middle" selectable={false} size="xlarge" weight="bold" wrap>{props.subredditName}&nbsp;</text>
        </hstack>
        <ProgressBar current={props.subscribers} end={props.goal} showText={true} start={0} width={'70%'} />
        <button appearance="success" disabled={true} size="large">
          &nbsp;Loading...&nbsp;
        </button>
        {props.recentSubscriber ? (
          <text alignment="top center" selectable={false} size="medium" weight="regular" wrap>
            {`u/${props.recentSubscriber} just subscribed!`}
          </text>
        ) : <text size="medium"/>}
        <spacer size='small' />
      </vstack>
    );
  }

  return (
    <blocks height='regular'>
      {previewContents}
    </blocks>
  );
};

/**
 * Shorthand function to create a static Preview component in non-tsx files.
 * @param props - {@linkcode PreviewProps} that are used to populate the static Preview component.
 * @returns A static Preview component that can be used as the custom post preview.
 */
export const previewMaker = (props: PreviewProps) => <Preview {...props}/>;

/**
 * Generates the text fallback for a custom post, which is displayed on old Reddit and some other places that don't support custom posts.
 * Be careful with this function, as certain text can cause issues with the feed on the mobile apps (despite the fact that it is not displayed there).
 * @param props - Same props that are used for creating the static Preview component.
 * @returns The text fallback string formatted with all the relevant information.
 */
export const textFallbackMaker = (props: PreviewProps) => props.completedTime
  ? `r/${props.subredditName} reached ${props.goal} subscribers!\n\nGoal reached at \`${props.completedTime.toISOString()}\`.`
  : `Welcome to r/${props.subredditName}\n\n${props.subscribers} / ${props.goal} subscribers.\n  Help us reach our goal!\n\nVisit this post on Shreddit to enjoy interactive features.`;
