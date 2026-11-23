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

  it.each([
    ["/user/alice", "/user/[redacted]"],
    ["see /user/alice now", "see /user/[redacted] now"],
    ['"/user/alice"', '"/user/[redacted]"'],
    [
      "https://www.reddit.com/user/alice",
      "https://www.reddit.com/user/[redacted]",
    ],
    ["/username/alice /users/", "/username/alice /users/"],
    ["C:/users/alice", "C:/users/[redacted]"],
    ["/user/alice and /USER/bob_2", "/user/[redacted] and /user/[redacted]"],
  ])("sanitizes profile paths in %s", (input, expected) => {
    expect(sanitizeDiagnosticText(input)).toBe(expected);
  });

  it.each([
    ["open /home/alice/work", "open /home/[redacted]/work"],
    [
      "http://alice:secret@example.test/path",
      "http://[redacted]@example.test/path",
    ],
    [
      "Bearer   token-value and Basic\t\tbackup",
      "Bearer [redacted] and Basic [redacted]",
    ],
    [
      '{"username"  :  "alice", "userId"  :  "t2_alice"}',
      '{"username"  :  "[redacted]", "userId"  :  "[redacted]"}',
    ],
    [
      '{"username"  :"alice", "username":  "bob", "userId"  :"t2_alice", "userId":  "t2_bob"}',
      '{"username"  :"[redacted]", "username":  "[redacted]", "userId"  :"[redacted]", "userId":  "[redacted]"}',
    ],
  ])("preserves the surrounding text while redacting %s", (input, expected) => {
    expect(sanitizeDiagnosticText(input)).toBe(expected);
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

  it("sanitizes a non-Error reason, and the stack and cause of an Error", () => {
    const errorSpy = vi
      .spyOn(globalThis.console, "error")
      .mockImplementation(() => {});
    try {
      const error = new Error("failed to read /user/alice", {
        cause: "open /home/alice/project",
      });
      error.stack = "at /home/bob/project/file.js";
      logDiagnostic("error", "read_failed", {}, error);
      logDiagnostic("error", "read_failed", {}, "see /user/bob");

      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        '[diagnostic] {"event":"read_failed","errorName":"Error","errorMessage":"failed to read /user/[redacted]","stack":"at /home/[redacted]/project/file.js","cause":"open /home/[redacted]/project"}',
      );
      expect(errorSpy).toHaveBeenNthCalledWith(
        2,
        '[diagnostic] {"event":"read_failed","errorName":"NonError","errorMessage":"see /user/[redacted]"}',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("omits stack and cause fields when the error has neither", () => {
    const errorSpy = vi
      .spyOn(globalThis.console, "error")
      .mockImplementation(() => {});
    try {
      const error = new Error("read failed");
      delete error.stack;
      logDiagnostic("error", "read_failed", {}, error);
      expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
        '[diagnostic] {"event":"read_failed","errorName":"Error","errorMessage":"read failed"}',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
