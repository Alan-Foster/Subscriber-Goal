import {Devvit, SettingsClient, SettingScope} from '@devvit/public-api';

export type AppSettings = {
  promoSubreddit: string;
  crosspost: boolean;
}

export const defaultAppSettings: AppSettings = {
  promoSubreddit: 'SubGoal',
  crosspost: true,
};

export async function getAppSettings (settings: SettingsClient): Promise<AppSettings> {
  const allSettings = await settings.getAll<AppSettings>();

  return {
    promoSubreddit: typeof allSettings.promoSubreddit === 'string' ? allSettings.promoSubreddit : defaultAppSettings.promoSubreddit,
    crosspost: typeof allSettings.crosspost === 'boolean' ? allSettings.crosspost : defaultAppSettings.crosspost,
  };
}

export const appSettings = Devvit.addSettings([
  {
    type: 'string',
    name: 'promoSubreddit',
    label: 'Promo Subreddit',
    helpText: 'The subreddit where created subgoals will be posted in addition to the current subreddit. The purpose of this functionality is to create a place where users can browse all subreddits that are looking for more subscribers.',
    defaultValue: defaultAppSettings.promoSubreddit,
    scope: SettingScope.App,
    isSecret: false,
  },
  {
    type: 'boolean',
    name: 'crosspost',
    label: 'Crosspost Subscriber Goal Posts',
    helpText: 'If you do not wish to crosspost subscriber goal posts to the app subreddit, you can disable this setting. We recommend keeping this enabled to increase visibility of your subscriber goal posts.',
    defaultValue: defaultAppSettings.crosspost,
    scope: SettingScope.Installation,
  },
]);
