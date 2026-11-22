import { describe, expect, it } from "vitest";
import { getRetryWaitMs } from "./fetchRetryDelay";
import {
  classifyNonJsonBody,
  classifyRetryResponse,
} from "./fetchRetryResponse";

describe("retry response classification", () => {
  it("preserves even a null successful JSON payload and flags an invalid success", () => {
    expect(classifyRetryResponse(true, 200, null, true)).toEqual({
      kind: "success",
      data: null,
    });
    expect(classifyRetryResponse(true, 200, {}, false)).toEqual({
      kind: "protocol_error",
    });
  });

  it.each([
    [400, false],
    [404, false],
    [429, true],
    [500, true],
    [503, true],
  ])(
    "classifies HTTP %i and keeps the structured error",
    (status, retryable) => {
      const payload = { status: "error", message: "Request rejected" };
      expect(classifyRetryResponse(false, status, payload, true)).toEqual({
        kind: "http_error",
        error: "Request rejected",
        retryable,
        errorResponse: payload,
      });
    },
  );

  it("preserves a plain message and falls back to the HTTP status for a non-JSON body", () => {
    expect(
      classifyRetryResponse(false, 400, { message: "Bad input" }, true),
    ).toEqual({ kind: "http_error", error: "Bad input", retryable: false });
    expect(classifyRetryResponse(false, 503, {}, false)).toEqual({
      kind: "http_error",
      error: "HTTP 503",
      retryable: true,
    });
  });

  it.each([
    ["  Failed to call Devvit application", "gateway"],
    ["\n<!DOCTYPE HTML>", "html"],
    ["  <HTML>", "html"],
    ["", "empty"],
    ["  ", "malformed_json"],
  ])("classifies the non-JSON body %j", (body, phase) => {
    expect(classifyNonJsonBody(body)).toBe(phase);
  });
});

describe("retry wait", () => {
  it("applies symmetric jitter and clamps the result to the remaining budget", () => {
    expect(getRetryWaitMs(200, 0.15, 1_000, () => 0)).toBe(170);
    expect(getRetryWaitMs(200, 0.15, 1_000, () => 1)).toBe(230);
    expect(getRetryWaitMs(200, 0.15, 220, () => 1)).toBe(220);
    expect(getRetryWaitMs(200, 2, 1_000, () => 0)).toBe(0);
  });

  it("clamps waits with jitter disabled and keeps a zero base delay", () => {
    expect(getRetryWaitMs(200, 0, 75)).toBe(75);
    expect(getRetryWaitMs(0, 0.15, 100)).toBe(0);
  });
});
