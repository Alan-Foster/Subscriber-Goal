import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SubGoalState } from '../../shared/types/api';

const state: SubGoalState = {
  goal: 1000,
  recentSubscriber: null,
  completedTime: null,
  subscribed: false,
  user: { id: 't2_user', username: 'alice' },
  appSettings: {
    promoSubreddit: 'SubGoal',
    crosspostAuthoritySubreddit: 'SubGoal',
    crosspostMaxSourcePostAgeMinutes: 10,
    crosspostIngestionEnabled: true,
    crosspostMaxRevisionAgeMinutes: 10,
    maxCrosspostsPerRun: 5,
    maxCrosspostsPerHour: 30,
    crosspostRetryWindowMinutes: 1440,
    crosspostRetryBaseDelaySeconds: 60,
    crosspostRetryMaxDelayMinutes: 30,
    crosspostPendingBatchSize: 25,
  },
  subreddit: {
    id: 't5_test',
    name: 'ExampleSub',
    icon: '/icon.png',
    subscribers: 123,
    isNsfw: false,
  },
};

vi.mock('../hooks/useSubGoal', () => ({
  useSubGoal: () => ({
    state,
    loading: false,
    submitting: false,
    subscribe: vi.fn(async () => ({ state, error: null })),
    setError: vi.fn(),
    notice: null,
    showNotice: vi.fn(),
  }),
}));

import { App } from './App';

describe('App', () => {
  it('defaults username sharing to opt-in (unchecked)', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('Show my username when I subscribe');
    expect(html).not.toContain('checked=""');
  });
});
