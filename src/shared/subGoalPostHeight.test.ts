import { describe, expect, it } from 'vitest';
import {
  defaultSubGoalPostHeight,
  resolveSubGoalPostHeight,
  subGoalPostHeights,
} from './subGoalPostHeight';

describe('subGoalPostHeight', () => {
  it('accepts each supported post height', () => {
    for (const postHeight of subGoalPostHeights) {
      expect(resolveSubGoalPostHeight(postHeight)).toBe(postHeight);
    }
  });

  it('defaults invalid values to regular', () => {
    expect(resolveSubGoalPostHeight(undefined)).toBe(defaultSubGoalPostHeight);
    expect(resolveSubGoalPostHeight('compact')).toBe(defaultSubGoalPostHeight);
  });
});
