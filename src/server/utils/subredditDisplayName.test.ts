import { describe, expect, it } from 'vitest';
import { validateSubredditDisplayName } from './subredditDisplayName';

describe('validateSubredditDisplayName', () => {
  it('accepts exact match', () => {
    expect(validateSubredditDisplayName('Subscriber_Goal_Dev', 'Subscriber_Goal_Dev')).toBeUndefined();
  });

  it('accepts case-only changes', () => {
    expect(validateSubredditDisplayName('subscriber_goal_dev', 'Subscriber_Goal_Dev')).toBeUndefined();
    expect(validateSubredditDisplayName('SUBSCRIBER_GOAL_DEV', 'Subscriber_Goal_Dev')).toBeUndefined();
  });

  it('rejects mismatched letters', () => {
    expect(validateSubredditDisplayName('Subscriber_Goal_Dez', 'Subscriber_Goal_Dev')).toContain(
      'only change capitalization'
    );
  });

  it('rejects mismatched non-letter characters and empty values', () => {
    expect(validateSubredditDisplayName('SubscriberGoalDev', 'Subscriber_Goal_Dev')).toContain(
      'only change capitalization'
    );
    expect(validateSubredditDisplayName('Subscriber_Goal_Dev2', 'Subscriber_Goal_Dev')).toContain(
      'only change capitalization'
    );
    expect(validateSubredditDisplayName('  ', 'Subscriber_Goal_Dev')).toContain(
      'Please provide a subreddit display name'
    );
  });
});
