import type { AppSettings } from '../shared/types/api';
import type { SettingsClient } from './types';

export const defaultAppSettings: AppSettings = {
  promoSubreddit: 'SubGoal',
};

const normalizeSubredditName = (value: string): string =>
  value.trim().replace(/^r\//i, '');

export async function getAppSettings(settings?: SettingsClient): Promise<AppSettings> {
  if (!settings) {
    return defaultAppSettings;
  }

  const allSettings = await settings.getAll<AppSettings>();
  const configuredPromo =
    typeof allSettings.promoSubreddit === 'string'
      ? allSettings.promoSubreddit
      : defaultAppSettings.promoSubreddit;
  const normalizedPromo = normalizeSubredditName(configuredPromo);
  const promoSubreddit =
    normalizedPromo.length > 0
      ? normalizedPromo
      : defaultAppSettings.promoSubreddit;

  if (configuredPromo !== promoSubreddit) {
    console.warn(
      `[settings] normalized promoSubreddit from "${configuredPromo}" to "${promoSubreddit}"`
    );
  }

  return {
    promoSubreddit,
  };
}
