import type { AppSettings } from '../shared/types/api';
import type { SettingsClient } from './types';

export const defaultAppSettings: AppSettings = {
  promoSubreddit: 'SubGoal',
  crosspostAuthoritySubreddit: '',
  crosspostMaxSourcePostAgeMinutes: 180,
  crosspostIngestionEnabled: true,
  crosspostMaxRevisionAgeMinutes: 180,
  maxCrosspostsPerRun: 5,
  maxCrosspostsPerHour: 30,
  crosspostRetryWindowMinutes: 1440,
  crosspostRetryBaseDelaySeconds: 60,
  crosspostRetryMaxDelayMinutes: 30,
  crosspostPendingBatchSize: 25,
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

  const configuredRetryWindowMinutes =
    typeof allSettings.crosspostRetryWindowMinutes === 'number'
      ? allSettings.crosspostRetryWindowMinutes
      : defaultAppSettings.crosspostRetryWindowMinutes;
  const crosspostRetryWindowMinutes =
    Number.isFinite(configuredRetryWindowMinutes) &&
    configuredRetryWindowMinutes > 0
      ? Math.floor(configuredRetryWindowMinutes)
      : defaultAppSettings.crosspostRetryWindowMinutes;

  const configuredRetryBaseDelaySeconds =
    typeof allSettings.crosspostRetryBaseDelaySeconds === 'number'
      ? allSettings.crosspostRetryBaseDelaySeconds
      : defaultAppSettings.crosspostRetryBaseDelaySeconds;
  const crosspostRetryBaseDelaySeconds =
    Number.isFinite(configuredRetryBaseDelaySeconds) &&
    configuredRetryBaseDelaySeconds > 0
      ? Math.floor(configuredRetryBaseDelaySeconds)
      : defaultAppSettings.crosspostRetryBaseDelaySeconds;

  const configuredRetryMaxDelayMinutes =
    typeof allSettings.crosspostRetryMaxDelayMinutes === 'number'
      ? allSettings.crosspostRetryMaxDelayMinutes
      : defaultAppSettings.crosspostRetryMaxDelayMinutes;
  const crosspostRetryMaxDelayMinutes =
    Number.isFinite(configuredRetryMaxDelayMinutes) &&
    configuredRetryMaxDelayMinutes > 0
      ? Math.floor(configuredRetryMaxDelayMinutes)
      : defaultAppSettings.crosspostRetryMaxDelayMinutes;

  const configuredPendingBatchSize =
    typeof allSettings.crosspostPendingBatchSize === 'number'
      ? allSettings.crosspostPendingBatchSize
      : defaultAppSettings.crosspostPendingBatchSize;
  const crosspostPendingBatchSize =
    Number.isFinite(configuredPendingBatchSize) &&
    configuredPendingBatchSize > 0
      ? Math.floor(configuredPendingBatchSize)
      : defaultAppSettings.crosspostPendingBatchSize;

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

  if (configuredRetryWindowMinutes !== crosspostRetryWindowMinutes) {
    console.warn(
      `[settings] normalized crosspostRetryWindowMinutes from "${configuredRetryWindowMinutes}" to "${crosspostRetryWindowMinutes}"`
    );
  }

  if (configuredRetryBaseDelaySeconds !== crosspostRetryBaseDelaySeconds) {
    console.warn(
      `[settings] normalized crosspostRetryBaseDelaySeconds from "${configuredRetryBaseDelaySeconds}" to "${crosspostRetryBaseDelaySeconds}"`
    );
  }

  if (configuredRetryMaxDelayMinutes !== crosspostRetryMaxDelayMinutes) {
    console.warn(
      `[settings] normalized crosspostRetryMaxDelayMinutes from "${configuredRetryMaxDelayMinutes}" to "${crosspostRetryMaxDelayMinutes}"`
    );
  }

  if (configuredPendingBatchSize !== crosspostPendingBatchSize) {
    console.warn(
      `[settings] normalized crosspostPendingBatchSize from "${configuredPendingBatchSize}" to "${crosspostPendingBatchSize}"`
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
    crosspostRetryWindowMinutes,
    crosspostRetryBaseDelaySeconds,
    crosspostRetryMaxDelayMinutes,
    crosspostPendingBatchSize,
  };
}
