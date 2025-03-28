import {Devvit} from '@devvit/public-api';

export type TopButtonsProps = {
  hideNotify?: boolean;
  notificationsEnabled?: boolean;
  onNotifyPressed: () => void | Promise<void>;
  onVisitPromoSubPressed: () => void | Promise<void>;
} & Omit<Devvit.Blocks.IconProps, 'name'>;

export const TopButton = (props: TopButtonsProps) => (
  <vstack alignment="center middle" gap="medium" height="100%" padding="medium" width="100%">
    <hstack width="100%">
      <button appearance="secondary" icon='external-fill' onPress={props.onVisitPromoSubPressed} size="small"/>
      <spacer grow/>
      {!props.hideNotify && <button appearance="secondary" icon={props.notificationsEnabled === undefined ? 'notification-fill' : props.notificationsEnabled ? 'notification-frequent-fill' : 'notification-off-fill'} onPress={props.onNotifyPressed} size="small"/>}
    </hstack>
    <spacer grow/>
  </vstack>
);
