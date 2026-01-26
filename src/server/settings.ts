import type { AppSettings } from '../shared/types/api';
import type { SettingsClient } from './types';

export const defaultAppSettings: AppSettings = {
  promoSubreddit: 'SubGoal',
};

export async function getAppSettings(settings?: SettingsClient): Promise<AppSettings> {
  if (!settings) {
    return defaultAppSettings;
  }

  const allSettings = await settings.getAll<AppSettings>();

  return {
    promoSubreddit:
      typeof allSettings.promoSubreddit === 'string'
        ? allSettings.promoSubreddit
        : defaultAppSettings.promoSubreddit,
  };
}
