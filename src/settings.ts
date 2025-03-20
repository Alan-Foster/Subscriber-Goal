import {Devvit, SettingsClient, SettingScope} from '@devvit/public-api';

export type AppSettings = {
  promoSubreddit: string;
}

export const defaultAppSettings: AppSettings = {
  promoSubreddit: 'SubGoal',
};

export async function getAppSettings (settings: SettingsClient): Promise<AppSettings> {
  const allSettings = await settings.getAll<AppSettings>();

  return {
    promoSubreddit: typeof allSettings.promoSubreddit === 'string' ? allSettings.promoSubreddit : defaultAppSettings.promoSubreddit,
  };
}

export const appSettings = Devvit.addSettings([
  {
    type: 'string',
    name: 'promoSubreddit',
    label: 'Promo Subreddit',
    helpText: 'The subreddit where created subgoals will be posted in addition to the current subreddit. The purpose of this functionality is to create a place where users can browse all subreddits that are looking for more subscribers.',
    defaultValue: 'SubGoal',
    scope: SettingScope.App,
    isSecret: false,
  },
]);
