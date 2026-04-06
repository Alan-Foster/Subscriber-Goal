import { describe, expect, it } from 'vitest';
import { resolveShareUsername } from './usernameSharePolicy';

describe('resolveShareUsername', () => {
  it('allows sharing on non-NSFW when requested', () => {
    expect(resolveShareUsername(true, false)).toBe(true);
  });

  it('disables sharing on non-NSFW when not requested', () => {
    expect(resolveShareUsername(false, false)).toBe(false);
  });

  it('always disables sharing on NSFW', () => {
    expect(resolveShareUsername(true, true)).toBe(false);
    expect(resolveShareUsername(false, true)).toBe(false);
  });
});
