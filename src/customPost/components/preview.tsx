import {Devvit} from '@devvit/public-api';

import {formatNumberUnlessExact} from '../../utils/formatNumbers.js';
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

// TODO: This duplicates a lot of the subGoalPage and completedPage code. Maybe split those into more components, so we can use them here?
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

export const previewMaker = (props: PreviewProps) => <Preview {...props}/>;

export const textFallbackMaker = (props: PreviewProps) => props.completedTime
  ? `r/${props.subredditName} reached ${props.goal} subscribers!\n\nGoal reached at ${props.completedTime.toLocaleTimeString('en', {timeZone: 'UTC'})} on ${props.completedTime.toLocaleDateString('en', {timeZone: 'UTC'})}`
  : `Welcome to r/${props.subredditName}\n\n${props.subscribers} / ${props.goal} subscribers.\n  Help us reach our goal!\n\nVisit this post on Shreddit to enjoy interactive features.`;
