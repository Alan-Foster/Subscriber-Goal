import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SubGoalState } from '../../../shared/types/api';

vi.mock('@devvit/web/client', () => ({
  context: {
    timezone: 'America/New_York',
  },
}));

import { CompletedPage } from './CompletedPage';

const baseState: SubGoalState = {
  goal: 10,
  recentSubscriber: null,
  completedTime: new Date('2026-04-29T19:32:30.000Z').getTime(),
  colorTheme: 'red',
  language: 'en',
  subscribed: true,
  user: { id: 't2_user', username: 'alice' },
  appSettings: {
    promoSubreddit: 'SubGoal',
  },
  subreddit: {
    id: 't5_test',
    name: 'indianActressClass',
    icon: '/icon.png',
    subscribers: 10,
    isNsfw: false,
  },
};

describe('CompletedPage', () => {
  const commonProps = {
    onVisitPromoSub: vi.fn(),
    onCelebrate: vi.fn(),
  };

  it('formats the completed time without seconds and with a month name', () => {
    const html = renderToStaticMarkup(
      <CompletedPage state={baseState} {...commonProps} />
    );

    expect(html).toContain('Goal reached at 3:32 PM on April 29, 2026');
    expect(html).not.toContain('3:32:30');
    expect(html).not.toContain('4/29/2026');
  });

  it('renders Spanish completed text', () => {
    const html = renderToStaticMarkup(
      <CompletedPage
        state={{ ...baseState, language: 'es' }}
        {...commonProps}
      />
    );

    expect(html).toContain('¡r/indianActressClass alcanzó 10 suscriptores!');
    expect(html).toContain('Meta alcanzada');
  });

  it('uses the just-now fallback when completed time is missing', () => {
    const html = renderToStaticMarkup(
      <CompletedPage
        state={{ ...baseState, completedTime: null }}
        {...commonProps}
      />
    );

    expect(html).toContain('Goal reached just now!');
  });
});
