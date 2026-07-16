export const subGoalPostHeights = ['regular', 'short', 'tiny'] as const;

export type SubGoalPostHeight = (typeof subGoalPostHeights)[number];

export const defaultSubGoalPostHeight: SubGoalPostHeight = 'regular';

export const shortSubGoalPostHeightPixels = 234;
export const tinySubGoalPostHeightPixels = 120;

export function resolveSubGoalPostHeight(value: unknown): SubGoalPostHeight {
  return typeof value === 'string' &&
    subGoalPostHeights.includes(value as SubGoalPostHeight)
    ? (value as SubGoalPostHeight)
    : defaultSubGoalPostHeight;
}
