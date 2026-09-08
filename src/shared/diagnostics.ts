export type DiagnosticLevel = "info" | "warn" | "error";

export type DiagnosticContext = {
  operationId?: string | undefined;
  route?: string | undefined;
  workflow?: string | undefined;
  phase?: string | undefined;
  status?: number | undefined;
  postId?: string | undefined;
  category?: string | undefined;
  [key: string]: string | number | boolean | undefined;
};

const maxDiagnosticTextLength = 1200;
const maxDiagnosticContextTextLength = 300;
const maxDiagnosticContextFields = 24;

export const sanitizeDiagnosticText = (value: unknown): string => {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(
      /([?&](?:token|key|secret|auth|authorization)=)[^&\s]+/gi,
      "$1[redacted]",
    )
    .replace(/([?&](?:userId|access_token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(?:u\/|\/u\/)[A-Za-z0-9_-]+/gi, "u/[redacted]")
    .replace(/\b\/user\/[A-Za-z0-9_-]+/gi, "/user/[redacted]")
    .replace(/([/\\]Users[/\\])[^/\\\s]+/gi, "$1[redacted]")
    .replace(/(\/home\/)[^/\s]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(["']username["']\s*:\s*["'])[^"']+/gi, "$1[redacted]")
    .replace(/(["']userId["']\s*:\s*["'])[^"']+/gi, "$1[redacted]")
    .slice(0, maxDiagnosticTextLength);
};

const sanitizeContext = (context: DiagnosticContext): DiagnosticContext =>
  Object.fromEntries(
    Object.entries(context)
      .slice(0, maxDiagnosticContextFields)
      .map(([key, value]) => {
      if (value === undefined || typeof value !== "string") return [key, value];
      if (/^(?:userId|username)$/i.test(key)) return [key, "[redacted]"];
      return [
        key,
        sanitizeDiagnosticText(value).slice(0, maxDiagnosticContextTextLength),
      ];
    }),
  ) as DiagnosticContext;

const errorDetails = (error: unknown): Record<string, string> => {
  if (!(error instanceof Error)) {
    return {
      errorName: "NonError",
      errorMessage: sanitizeDiagnosticText(error),
    };
  }
  const details: Record<string, string> = {
    errorName: sanitizeDiagnosticText(error.name),
    errorMessage: sanitizeDiagnosticText(error.message),
  };
  if (error.stack) details.stack = sanitizeDiagnosticText(error.stack);
  if (error.cause !== undefined) {
    details.cause = sanitizeDiagnosticText(error.cause);
  }
  return details;
};

export const createOperationId = (prefix = "op"): string => {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${randomPart}`;
};

export function logDiagnostic(
  level: DiagnosticLevel,
  event: string,
  context: DiagnosticContext,
  error?: unknown,
): void {
  const payload = {
    event: sanitizeDiagnosticText(event),
    ...sanitizeContext(context),
    ...(error === undefined ? {} : errorDetails(error)),
  };
  try {
    const line = `[diagnostic] ${JSON.stringify(payload)}`;
    if (level === "error") globalThis.console.error(line);
    else if (level === "warn") globalThis.console.warn(line);
    else globalThis.console.info(line);
  } catch {
    // diagnostic-allow-silent: logging must never break application control flow.
  }
}
