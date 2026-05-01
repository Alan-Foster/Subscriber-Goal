import { describe, expect, it } from 'vitest';
import {
  defaultAppSettings,
  getAppSettings,
  getPublicAppSettings,
} from './settings';

describe('app settings', () => {
  it('uses hard-coded private server defaults', () => {
    expect(getAppSettings()).toEqual({
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
    });
  });

  it('exposes only public app settings to client state', () => {
    expect(getPublicAppSettings()).toEqual({
      promoSubreddit: defaultAppSettings.promoSubreddit,
    });
  });
});
