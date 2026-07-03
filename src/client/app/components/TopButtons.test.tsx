import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TopButtons } from './TopButtons';

describe('TopButtons', () => {
  it('shows the promo subreddit link text and accessible label', () => {
    const html = renderToStaticMarkup(
      <TopButtons
        onVisitPromoSubPressed={vi.fn()}
        promoSubreddit="SubGoal"
        language="en"
      />
    );

    expect(html).toContain('r/SubGoal');
    expect(html).toContain('View other subscriber goals in r/SubGoal');
    expect(html).toContain('absolute right-4 top-4');
    expect(html).not.toContain('max-sm:top-6');
  });

  it('localizes the accessible label', () => {
    const html = renderToStaticMarkup(
      <TopButtons
        onVisitPromoSubPressed={vi.fn()}
        promoSubreddit="SubGoal"
        language="es"
      />
    );

    expect(html).toContain('Ver otras metas de suscriptores en r/SubGoal');
  });
});
