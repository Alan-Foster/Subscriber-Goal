import { describe, expect, it, vi } from 'vitest';

vi.mock('@devvit/web/server', () => ({
  reddit: {},
  redis: {},
  context: {},
}));

import { isMissingSourcePostError } from './modAction';

describe('isMissingSourcePostError', () => {
  it('detects explicit no post t3_* error messages', () => {
    expect(isMissingSourcePostError('no post t3_1saea32')).toBe(true);
  });

  it('detects common missing/deleted variants', () => {
    expect(isMissingSourcePostError('post not found')).toBe(true);
    expect(isMissingSourcePostError('target does not exist')).toBe(true);
    expect(isMissingSourcePostError('post has been deleted')).toBe(true);
    expect(isMissingSourcePostError('post no longer exists')).toBe(true);
  });

  it('does not classify transient/network failures as missing-source', () => {
    expect(isMissingSourcePostError('ECONNRESET upstream timeout')).toBe(false);
    expect(isMissingSourcePostError('503 Service Unavailable')).toBe(false);
  });
});
