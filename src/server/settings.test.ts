import { describe, expect, it } from 'vitest';
import { defaultAppSettings, getAppSettings } from './settings';

describe('getAppSettings', () => {
  it('uses promo subreddit as effective authority when authority is unset', async () => {
    const settings = {
      getAll: async () => ({
        promoSubreddit: 'MyHub',
        crosspostAuthoritySubreddit: '   ',
      }),
    };

    const result = await getAppSettings(settings);

    expect(result.promoSubreddit).toBe('MyHub');
    expect(result.crosspostAuthoritySubreddit).toBe('MyHub');
    expect(result.crosspostMaxSourcePostAgeMinutes).toBe(
      defaultAppSettings.crosspostMaxSourcePostAgeMinutes
    );
    expect(result.crosspostIngestionEnabled).toBe(true);
    expect(result.crosspostMaxRevisionAgeMinutes).toBe(180);
    expect(result.maxCrosspostsPerRun).toBe(5);
    expect(result.maxCrosspostsPerHour).toBe(30);
    expect(result.crosspostRetryWindowMinutes).toBe(1440);
    expect(result.crosspostRetryBaseDelaySeconds).toBe(60);
    expect(result.crosspostRetryMaxDelayMinutes).toBe(30);
    expect(result.crosspostPendingBatchSize).toBe(25);
  });

  it('uses explicit authority override when provided', async () => {
    const settings = {
      getAll: async () => ({
        promoSubreddit: 'SubGoal',
        crosspostAuthoritySubreddit: 'r/OtherHub',
        crosspostMaxSourcePostAgeMinutes: 25.9,
        crosspostIngestionEnabled: false,
        crosspostMaxRevisionAgeMinutes: 15.1,
        maxCrosspostsPerRun: 7.9,
        maxCrosspostsPerHour: 42.4,
        crosspostRetryWindowMinutes: 720.3,
        crosspostRetryBaseDelaySeconds: 45.8,
        crosspostRetryMaxDelayMinutes: 12.4,
        crosspostPendingBatchSize: 99.6,
      }),
    };

    const result = await getAppSettings(settings);

    expect(result.promoSubreddit).toBe('SubGoal');
    expect(result.crosspostAuthoritySubreddit).toBe('OtherHub');
    expect(result.crosspostMaxSourcePostAgeMinutes).toBe(25);
    expect(result.crosspostIngestionEnabled).toBe(false);
    expect(result.crosspostMaxRevisionAgeMinutes).toBe(15);
    expect(result.maxCrosspostsPerRun).toBe(7);
    expect(result.maxCrosspostsPerHour).toBe(42);
    expect(result.crosspostRetryWindowMinutes).toBe(720);
    expect(result.crosspostRetryBaseDelaySeconds).toBe(45);
    expect(result.crosspostRetryMaxDelayMinutes).toBe(12);
    expect(result.crosspostPendingBatchSize).toBe(99);
  });
});
