import {Devvit} from '@devvit/public-api';

import {formatNumberUnlessExact} from '../../utils/formatNumbers.js';

// TODO: Maybe add color customization stuff
export type ProgressBarProps = {
  start?: number;
  end?: number;
  current?: number;
  showText?: boolean;
  width: Devvit.Blocks.SizeString;
};

export const ProgressBar = ({start, end, current, showText, width}: ProgressBarProps) => {
  if (start === undefined || end === undefined || current === undefined) {
    return (<vstack backgroundColor='global-white' border='thin' borderColor='black' cornerRadius='medium' width={'100%'}>
      <spacer shape='square' size='large' />
    </vstack>);
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
