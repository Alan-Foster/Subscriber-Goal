import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SubredditIcon } from './SubredditIcon';

describe('SubredditIcon', () => {
  it('renders subreddit icons at 100px by default', () => {
    const html = renderToStaticMarkup(<SubredditIcon iconUrl="/icon.webp" />);

    expect(html).toContain('style="width:100px;height:100px"');
    expect(html).toContain('width="100"');
    expect(html).toContain('height="100"');
  });
});
