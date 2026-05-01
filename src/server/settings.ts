import type { PublicAppSettings } from '../shared/types/api';

export type ServerAppSettings = PublicAppSettings & {
  crosspostAuthoritySubreddit: string;
  crosspostMaxSourcePostAgeMinutes: number;
  crosspostIngestionEnabled: boolean;
  crosspostMaxRevisionAgeMinutes: number;
  maxCrosspostsPerRun: number;
  maxCrosspostsPerHour: number;
  crosspostRetryWindowMinutes: number;
  crosspostRetryBaseDelaySeconds: number;
  crosspostRetryMaxDelayMinutes: number;
  crosspostPendingBatchSize: number;
};

export const defaultAppSettings: ServerAppSettings = {
  promoSubreddit: 'SubGoal',
  crosspostAuthoritySubreddit: 'SubGoal',
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

export function getAppSettings(): ServerAppSettings {
  return { ...defaultAppSettings };
}

export function getPublicAppSettings(): PublicAppSettings {
  return {
    promoSubreddit: defaultAppSettings.promoSubreddit,
  };
}
