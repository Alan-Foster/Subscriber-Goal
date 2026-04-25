import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SubredditIcon } from './SubredditIcon';

describe('SubredditIcon', () => {
  it('renders subreddit icons at 64px by default', () => {
    const html = renderToStaticMarkup(<SubredditIcon iconUrl="/icon.webp" />);

    expect(html).toContain('style="width:64px;height:64px"');
    expect(html).toContain('width="64"');
    expect(html).toContain('height="64"');
  });
});
