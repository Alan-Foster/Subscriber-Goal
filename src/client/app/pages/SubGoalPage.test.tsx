import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SubGoalState } from '../../../shared/types/api';
import { SubGoalPage } from './SubGoalPage';

const baseState: SubGoalState = {
  goal: 500,
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
  },
  subreddit: {
    id: 't5_test',
    name: 'ExampleSub',
    icon: '/icon.png',
    subscribers: 123,
    isNsfw: false,
  },
};

describe('SubGoalPage', () => {
  const commonProps = {
    onSubscribe: vi.fn(),
    onCelebrate: vi.fn(),
    onVisitPromoSub: vi.fn(),
    isSubmitting: false,
    shareUsername: false,
    onShareUsernameChange: vi.fn(),
    notice: null,
  };

  it('shows username share control on non-NSFW subreddits', () => {
    const html = renderToStaticMarkup(
      <SubGoalPage state={baseState} {...commonProps} />
    );

    expect(html).toContain('Show my username when I subscribe');
  });

  it('hides username share control on NSFW subreddits', () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{
          ...baseState,
          subreddit: { ...baseState.subreddit, isNsfw: true },
        }}
        {...commonProps}
      />
    );

    expect(html).not.toContain('Show my username when I subscribe');
  });
});
