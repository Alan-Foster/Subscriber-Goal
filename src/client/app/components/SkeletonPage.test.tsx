import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SkeletonPage } from './SkeletonPage';

describe('SkeletonPage', () => {
  it('uses short height without compact spacing or logo placeholder', () => {
    const html = renderToStaticMarkup(<SkeletonPage postHeight="short" />);

    expect(html).toContain('h-[234px]');
    expect(html).toContain('gap-5 px-4 py-6');
    expect(html).not.toContain('max-sm:pt-8');
    expect(html).not.toContain('h-[100px] w-[100px]');
  });
});
