import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SubGoalState } from '../../../shared/types/api';
import { SubGoalPage } from './SubGoalPage';

const baseState: SubGoalState = {
  goal: 500,
  recentSubscriber: null,
  completedTime: null,
  headerText: null,
  colorTheme: 'red',
  language: 'en',
  subscribed: false,
  user: { id: 't2_user', username: 'alice' },
  appSettings: {
    promoSubreddit: 'SubGoal',
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

  it('renders Spanish post text', () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{ ...baseState, language: 'es' }}
        {...commonProps}
      />
    );

    expect(html).toContain('Bienvenido a r/ExampleSub');
    expect(html).toContain('Suscribirse a r/ExampleSub');
    expect(html).toContain('Mostrar mi nombre de usuario cuando me suscriba');
  });

  it('renders custom header text when provided', () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{ ...baseState, headerText: 'This is a Custom Message' }}
        {...commonProps}
      />
    );

    expect(html).toContain('This is a Custom Message');
    expect(html).not.toContain('Welcome to r/ExampleSub');
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

  it('adds attention glow when subscribe button is actionable', () => {
    const html = renderToStaticMarkup(
      <SubGoalPage state={baseState} {...commonProps} />
    );

    expect(html).toContain('sg-subscribe-attention');
  });

  it('renders the selected color theme', () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{ ...baseState, colorTheme: 'purple' }}
        {...commonProps}
      />
    );

    expect(html).toContain('data-sg-theme="purple"');
  });

  it('does not add attention glow after subscribing', () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={{ ...baseState, subscribed: true }}
        {...commonProps}
      />
    );

    expect(html).not.toContain('sg-subscribe-attention');
  });

  it('does not add attention glow while submitting', () => {
    const html = renderToStaticMarkup(
      <SubGoalPage
        state={baseState}
        {...commonProps}
        isSubmitting
      />
    );

    expect(html).not.toContain('sg-subscribe-attention');
  });
});
