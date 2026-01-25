/**
 * @file This is the component that shows the bar with the buttons at the top of the post.
 */

import {Devvit} from '@devvit/public-api';

export type TopButtonsProps = {
  onVisitPromoSubPressed: () => void | Promise<void>;
} & Omit<Devvit.Blocks.IconProps, 'name'>;

export const TopButtons = (props: TopButtonsProps) => (
  <vstack alignment="center middle" gap="medium" height="100%" padding="medium" width="100%">
    <hstack width="100%">
      <button appearance="secondary" icon='external-fill' onPress={props.onVisitPromoSubPressed} size="small"/>
      <spacer grow/>
    </hstack>
    <spacer grow/>
  </vstack>
);
