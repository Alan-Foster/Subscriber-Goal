import {Devvit, IconName} from '@devvit/public-api';

import {LoadingElement} from './loadingElement.js';

export type SubredditIconProps = {
  iconUrl?: string;
  onPress?: () => void | Promise<void>;
  placeholderIconName?: IconName;
  gap?: Devvit.Blocks.ContainerGap;
  padding?: Devvit.Blocks.ContainerPadding;
  imageWidth: Devvit.Blocks.SizePixels | number;
  imageHeight: Devvit.Blocks.SizePixels | number;
} & Omit<Devvit.Blocks.IconProps, 'name'>;

export const SubredditIcon = (props: SubredditIconProps) => (
  <hstack alignment='center middle' backgroundColor='' cornerRadius='full' padding={props.padding}>
    <LoadingElement color={props.color} darkColor={props.darkColor} lightColor={props.lightColor} name={props.placeholderIconName ?? 'load-fill'} size={props.size}>
      {props.iconUrl && <image imageHeight={props.imageHeight} imageWidth={props.imageWidth} onPress={props.onPress} url={props.iconUrl} />}
    </LoadingElement>
  </hstack>
);
