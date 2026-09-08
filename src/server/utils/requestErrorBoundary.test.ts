import type { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@devvit/web/server", () => ({
  context: { postId: "t3_post" },
}));

import { unhandledRequestErrorHandler } from "./requestErrorBoundary";

const invoke = (path: string, headersSent = false) => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next = vi.fn();
  unhandledRequestErrorHandler(
    new Error("route exploded"),
    { path, method: "POST" } as Request,
    { status, json, headersSent } as unknown as Response,
    next as NextFunction,
  );
  return { json, status, next };
};

describe("unhandled request error boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs and returns a valid internal UI toast", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = invoke("/internal/form/delete-goal");
    expect(result.status).toHaveBeenCalledWith(200);
    expect(result.json).toHaveBeenCalledWith({
      showToast: expect.stringContaining("Reference: request-"),
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/unhandled_request_error.*route exploded.*stack/),
    );
  });

  it("returns JSON 503 for uncaught public API failures", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = invoke("/api/refresh");
    expect(result.status).toHaveBeenCalledWith(503);
    expect(result.json).toHaveBeenCalledWith({
      status: "error",
      message: expect.stringContaining("Reference: request-"),
    });
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("delegates after logging when headers were already sent", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = invoke("/api/refresh", true);
    expect(result.next).toHaveBeenCalledWith(expect.any(Error));
    expect(result.status).not.toHaveBeenCalled();
  });
});
