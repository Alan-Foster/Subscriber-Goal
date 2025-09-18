/**
 * @file Very basic initial test to test the test suite, which just ensures Devvit is actually being exported from main.ts.
 */
import {Devvit} from '@devvit/public-api';
import {Devvit as exportedDevvit} from '@devvit/public-api';

describe('Check for Devvit export from main.ts', () => {
  it('export the Devvit singleton class', () => {
    expect(exportedDevvit).toBe(Devvit);
  });
});
