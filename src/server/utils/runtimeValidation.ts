import {
  logDiagnostic,
  type DiagnosticContext,
  type DiagnosticLevel,
} from "../../shared/diagnostics";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

export function parseStoredJson<T>(
  raw: string | undefined,
  guard: (value: unknown) => value is T,
  context: DiagnosticContext,
  {
    event = "persisted_json_invalid",
    level = "warn",
  }: {
    event?: string;
    level?: DiagnosticLevel;
  } = {},
): T | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // diagnostic-allow-silent: log invalid data below without including its contents.
  }
  if (guard(parsed)) return parsed;
  logDiagnostic(level, event, context);
  return undefined;
}
