import type { ErrorResponse } from "../../shared/types/api";

export type RetryResponse =
  | { kind: "success"; data: unknown }
  | { kind: "protocol_error" }
  | {
      kind: "http_error";
      error: string;
      retryable: boolean;
      errorResponse?: ErrorResponse;
    };

export function classifyRetryResponse(
  ok: boolean,
  status: number,
  payload: unknown,
  validJson: boolean,
): RetryResponse {
  if (ok) {
    return validJson
      ? { kind: "success", data: payload }
      : { kind: "protocol_error" };
  }

  const retryable = status >= 500 || status === 429;
  if (
    payload &&
    typeof payload === "object" &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return {
      kind: "http_error",
      error: payload.message,
      retryable,
      ...((payload as Partial<ErrorResponse>).status === "error"
        ? { errorResponse: payload as ErrorResponse }
        : {}),
    };
  }
  return { kind: "http_error", error: `HTTP ${status}`, retryable };
}

export function classifyNonJsonBody(body: string) {
  const normalized = body.trimStart().toLowerCase();
  if (normalized.startsWith("failed to call devvit application"))
    return "gateway";
  if (normalized.startsWith("<!doctype html") || normalized.startsWith("<html"))
    return "html";
  return body.length === 0 ? "empty" : "malformed_json";
}
