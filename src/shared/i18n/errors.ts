import type { ErrorResponse } from "../types/api";
import { isMessageKey, translate, type MessageValues } from "./catalog";

export type LocalizableError = Pick<ErrorResponse, "message"> &
  Partial<Pick<ErrorResponse, "messageKey" | "messageParams">>;

export function localizeError(
  language: unknown,
  error: LocalizableError | undefined,
  fallback: string,
): string {
  if (error && isMessageKey(error.messageKey)) {
    try {
      return translate(
        language,
        error.messageKey,
        (error.messageParams ?? {}) as MessageValues,
      );
    } catch {
      // diagnostic-allow-silent: a compatible English message remains the defensive wire fallback.
    }
  }
  return error?.message || fallback;
}
