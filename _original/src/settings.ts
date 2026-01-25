/**
 * @file Contains the definitions, types, defaults, and getters for the Devvit app settings.
 */

import {Devvit, SettingsClient, SettingScope} from '@devvit/public-api';

export type AppSettings = {
  promoSubreddit: string;
}

export const defaultAppSettings: AppSettings = {
  promoSubreddit: 'SubGoal',
};

/**
 * Retrieves the application settings from the SettingsClient.
 * @param settings - Instance of SettingsClient.
 * @returns The AppSettings object containing the current settings, or the default values if not set.
 */
export async function getAppSettings (settings: SettingsClient): Promise<AppSettings> {
  const allSettings = await settings.getAll<AppSettings>();

  return {
    promoSubreddit: typeof allSettings.promoSubreddit === 'string' ? allSettings.promoSubreddit : defaultAppSettings.promoSubreddit,
  };
}

/**
 * @description Registers the application settings with Devvit. This is exported via main.js, which enables the configuration through Devvit.
 */
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
]);
