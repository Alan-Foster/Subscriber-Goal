/**
 * @file Contains the ProgressBar component.
 */
import {Devvit} from '@devvit/public-api';

import {formatNumberUnlessExact} from '../../utils/numberUtils.js';

export type ProgressBarProps = {
  start?: number;
  end?: number;
  current?: number;
  showText?: boolean;
  width: Devvit.Blocks.SizeString;
};

/**
 * This is just the progress bar component, constructed from stacks and spacers.
 * It is a simple horizontal bar that fills up based on the current value relative to the start and end values.
 * If the start, end, or current values are not provided, it will render an empty progress bar of the specified width.
 * @param props - The properties for the progress bar.
 * @param props.start - This is the starting value of the progress bar, or what the left edge of the progress bar represents.
 * @param props.end - This is the end value of the progress bar, basically what the progress bar is approaching on the right edge.
 * @param props.current - Current value of the progress bar. It should be greater than or equal to the start value. The maximum value is clamped, however the behavior is undefined for values less than the start value.
 * @param props.showText - This controls whether the current and end values are displayed in the progress bar.
 * @param props.width - This will be the width of the ProgressBar component, accepts any valid width value for Devvit stacks.
 * @returns Devvit blocks component that displays a progress bar.
 * @todo Add color customization, possibly based on the subreddit theme color? Although that would require more complex logic to handle text color with different themes.
 */
export const ProgressBar = ({start, end, current, showText, width}: ProgressBarProps) => {
  if (start === undefined || end === undefined || current === undefined) {
    return (
      <zstack alignment="center middle" width={width}>
        <vstack backgroundColor='global-white' border='thin' borderColor='black' cornerRadius='medium' width={'100%'}>
          <spacer shape='square' size='large' />
        </vstack>
      </zstack>
    );
  }

  const progress = Math.min((current - start) / (end - start) * 100, 100);
  return (
    <zstack alignment="center middle" width={width}>
      <vstack backgroundColor='global-white' border='thin' borderColor='black' cornerRadius='medium' width={'100%'}>
        <hstack backgroundColor='#D93A00' width={`${progress}%`}>
          <spacer shape='square' size='large' />
        </hstack>
      </vstack>
      {showText ? <text alignment="center middle" color={'rgb(51, 61, 66)'} selectable={false} size="medium" weight="bold" wrap>
        &nbsp;{current} / {formatNumberUnlessExact(end)}&nbsp;
      </text> : null}
    </zstack>
  );
};
