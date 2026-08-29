export const subGoalColorThemes = ['red', 'green', 'purple', 'blue', 'pink'] as const;

export type SubGoalColorTheme = (typeof subGoalColorThemes)[number];

export const defaultSubGoalColorTheme: SubGoalColorTheme = 'red';

export function isSubGoalColorTheme(value: unknown): value is SubGoalColorTheme {
  return (
    typeof value === 'string' &&
    subGoalColorThemes.includes(value as SubGoalColorTheme)
  );
}

export function resolveSubGoalColorTheme(value: unknown): SubGoalColorTheme {
  return isSubGoalColorTheme(value) ? value : defaultSubGoalColorTheme;
}
