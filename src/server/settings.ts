import type { AppSettings } from '../shared/types/api';
import type { SettingsClient } from './types';

export const defaultAppSettings: AppSettings = {
  promoSubreddit: 'SubGoal',
  crosspostAuthoritySubreddit: '',
  crosspostMaxSourcePostAgeMinutes: 10,
  crosspostIngestionEnabled: true,
  crosspostMaxRevisionAgeMinutes: 10,
  maxCrosspostsPerRun: 5,
  maxCrosspostsPerHour: 30,
};

const normalizeSubredditName = (value: string): string =>
  value.trim().replace(/^r\//i, '');

export async function getAppSettings(settings?: SettingsClient): Promise<AppSettings> {
  const allSettings = settings ? await settings.getAll<AppSettings>() : {};
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

  const configuredAuthority =
    typeof allSettings.crosspostAuthoritySubreddit === 'string'
      ? allSettings.crosspostAuthoritySubreddit
      : promoSubreddit;
  const normalizedAuthority = normalizeSubredditName(configuredAuthority);
  const crosspostAuthoritySubreddit =
    normalizedAuthority.length > 0
      ? normalizedAuthority
      : promoSubreddit;

  const configuredMaxAgeMinutes =
    typeof allSettings.crosspostMaxSourcePostAgeMinutes === 'number'
      ? allSettings.crosspostMaxSourcePostAgeMinutes
      : defaultAppSettings.crosspostMaxSourcePostAgeMinutes;
  const crosspostMaxSourcePostAgeMinutes =
    Number.isFinite(configuredMaxAgeMinutes) && configuredMaxAgeMinutes > 0
      ? Math.floor(configuredMaxAgeMinutes)
      : defaultAppSettings.crosspostMaxSourcePostAgeMinutes;

  const crosspostIngestionEnabled =
    typeof allSettings.crosspostIngestionEnabled === 'boolean'
      ? allSettings.crosspostIngestionEnabled
      : defaultAppSettings.crosspostIngestionEnabled;

  const configuredMaxRevisionAgeMinutes =
    typeof allSettings.crosspostMaxRevisionAgeMinutes === 'number'
      ? allSettings.crosspostMaxRevisionAgeMinutes
      : defaultAppSettings.crosspostMaxRevisionAgeMinutes;
  const crosspostMaxRevisionAgeMinutes =
    Number.isFinite(configuredMaxRevisionAgeMinutes) &&
    configuredMaxRevisionAgeMinutes > 0
      ? Math.floor(configuredMaxRevisionAgeMinutes)
      : defaultAppSettings.crosspostMaxRevisionAgeMinutes;

  const configuredMaxCrosspostsPerRun =
    typeof allSettings.maxCrosspostsPerRun === 'number'
      ? allSettings.maxCrosspostsPerRun
      : defaultAppSettings.maxCrosspostsPerRun;
  const maxCrosspostsPerRun =
    Number.isFinite(configuredMaxCrosspostsPerRun) &&
    configuredMaxCrosspostsPerRun > 0
      ? Math.floor(configuredMaxCrosspostsPerRun)
      : defaultAppSettings.maxCrosspostsPerRun;

  const configuredMaxCrosspostsPerHour =
    typeof allSettings.maxCrosspostsPerHour === 'number'
      ? allSettings.maxCrosspostsPerHour
      : defaultAppSettings.maxCrosspostsPerHour;
  const maxCrosspostsPerHour =
    Number.isFinite(configuredMaxCrosspostsPerHour) &&
    configuredMaxCrosspostsPerHour > 0
      ? Math.floor(configuredMaxCrosspostsPerHour)
      : defaultAppSettings.maxCrosspostsPerHour;

  if (configuredAuthority !== crosspostAuthoritySubreddit) {
    console.warn(
      `[settings] normalized crosspostAuthoritySubreddit from "${configuredAuthority}" to "${crosspostAuthoritySubreddit}"`
    );
  }

  if (configuredMaxAgeMinutes !== crosspostMaxSourcePostAgeMinutes) {
    console.warn(
      `[settings] normalized crosspostMaxSourcePostAgeMinutes from "${configuredMaxAgeMinutes}" to "${crosspostMaxSourcePostAgeMinutes}"`
    );
  }

  if (configuredMaxRevisionAgeMinutes !== crosspostMaxRevisionAgeMinutes) {
    console.warn(
      `[settings] normalized crosspostMaxRevisionAgeMinutes from "${configuredMaxRevisionAgeMinutes}" to "${crosspostMaxRevisionAgeMinutes}"`
    );
  }

  if (configuredMaxCrosspostsPerRun !== maxCrosspostsPerRun) {
    console.warn(
      `[settings] normalized maxCrosspostsPerRun from "${configuredMaxCrosspostsPerRun}" to "${maxCrosspostsPerRun}"`
    );
  }

  if (configuredMaxCrosspostsPerHour !== maxCrosspostsPerHour) {
    console.warn(
      `[settings] normalized maxCrosspostsPerHour from "${configuredMaxCrosspostsPerHour}" to "${maxCrosspostsPerHour}"`
    );
  }

  return {
    promoSubreddit,
    crosspostAuthoritySubreddit,
    crosspostMaxSourcePostAgeMinutes,
    crosspostIngestionEnabled,
    crosspostMaxRevisionAgeMinutes,
    maxCrosspostsPerRun,
    maxCrosspostsPerHour,
  };
}
