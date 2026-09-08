import { describe, expect, it, vi } from "vitest";
import { logDiagnostic, sanitizeDiagnosticText } from "./diagnostics";

describe("structured diagnostics", () => {
  it("redacts credentials, usernames, and sensitive query values", () => {
    expect(
      sanitizeDiagnosticText(
        'Bearer abc123 u/PrivateUser "username":"PrivateUser" https://x.test/?token=secret',
      ),
    ).toBe(
      'Bearer [redacted] u/[redacted] "username":"[redacted]" https://x.test/?token=[redacted]',
    );
  });

  it("logs structured stack-bearing errors", () => {
    const errorSpy = vi
      .spyOn(globalThis.console, "error")
      .mockImplementation(() => {});
    logDiagnostic(
      "error",
      "test_failure",
      { workflow: "test", phase: "execute", postId: "t3_post" },
      new Error("failed"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/test_failure.*"errorMessage":"failed".*"stack":/),
    );
    errorSpy.mockRestore();
  });
});
