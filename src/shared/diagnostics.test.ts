import { describe, expect, it, vi } from "vitest";
import { logDiagnostic, sanitizeDiagnosticText } from "./diagnostics";

describe("structured diagnostics", () => {
  it("redacts credentials, usernames, and sensitive query values", () => {
    expect(
      sanitizeDiagnosticText(
        'Bearer abc123 u/PrivateUser "username":"PrivateUser" "userId":"t2_private" C:/Users/Owner https://x.test/?token=secret&userId=t2_private',
      ),
    ).toBe(
      'Bearer [redacted] u/[redacted] "username":"[redacted]" "userId":"[redacted]" C:/Users/[redacted] https://x.test/?token=[redacted]&userId=[redacted]',
    );
  });

  it("sanitizes and truncates every string context field", () => {
    const warnSpy = vi
      .spyOn(globalThis.console, "warn")
      .mockImplementation(() => {});
    logDiagnostic("warn", "context_test", {
      workflow: `https://name:password@example.test/user/PrivateUser?secret=value ${"x".repeat(2000)}`,
      userId: "t2_private",
      username: "PrivateUser",
      postId: "t3_safe",
    });
    const line = String(warnSpy.mock.calls[0]?.[0]);
    expect(line).not.toContain("password");
    expect(line).not.toContain("PrivateUser");
    expect(line).not.toContain("t2_private");
    expect(line).not.toContain("secret=value");
    expect(line).toContain('"postId":"t3_safe"');
    expect(line.length).toBeLessThan(1500);
    warnSpy.mockRestore();
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
