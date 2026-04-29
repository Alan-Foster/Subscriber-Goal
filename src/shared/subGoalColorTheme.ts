export const subGoalColorThemes = ['red', 'green', 'purple', 'blue'] as const;

export type SubGoalColorTheme = (typeof subGoalColorThemes)[number];

export const defaultSubGoalColorTheme: SubGoalColorTheme = 'red';

export function resolveSubGoalColorTheme(value: unknown): SubGoalColorTheme {
  return typeof value === 'string' &&
    subGoalColorThemes.includes(value as SubGoalColorTheme)
    ? (value as SubGoalColorTheme)
    : defaultSubGoalColorTheme;
}
