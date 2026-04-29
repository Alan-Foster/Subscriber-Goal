import { describe, expect, it } from 'vitest';
import {
  defaultSubGoalColorTheme,
  resolveSubGoalColorTheme,
  subGoalColorThemes,
} from './subGoalColorTheme';

describe('subGoalColorTheme', () => {
  it('accepts each supported color theme', () => {
    for (const theme of subGoalColorThemes) {
      expect(resolveSubGoalColorTheme(theme)).toBe(theme);
    }
  });

  it('defaults invalid values to red', () => {
    expect(resolveSubGoalColorTheme(undefined)).toBe(defaultSubGoalColorTheme);
    expect(resolveSubGoalColorTheme('orange')).toBe(defaultSubGoalColorTheme);
  });
});
