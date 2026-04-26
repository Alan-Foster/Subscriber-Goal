import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('formats subscriber counts with shared display rules', () => {
    const html = renderToStaticMarkup(
      <ProgressBar current={12632} end={15000} start={0} showText />
    );

    expect(html).toContain('12632 / 15k');
  });
});
