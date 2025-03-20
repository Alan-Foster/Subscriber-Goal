import {Devvit} from '@devvit/public-api';

export type ProgressBarProps = {
  start: number;
  end: number;
  current: number;
  width: Devvit.Blocks.SizeString;
};

export const ProgressBar = ({start, end, current, width}: ProgressBarProps) => {
  const progress = Math.min((current - start) / (end - start) * 100, 100);
  return (
    <vstack backgroundColor='global-white' border='thin' borderColor='black' cornerRadius='medium' width={width}>
      <hstack backgroundColor='#D93A00' width={`${progress}%`}>
        <spacer shape='square' size='large' />
      </hstack>
    </vstack>
  );
};
