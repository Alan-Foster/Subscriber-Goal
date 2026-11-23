import { describe, expect, it } from "vitest";
import { isAfterSubscribeTargetResponse } from "./afterSubscribeTargetValidation";

describe("isAfterSubscribeTargetResponse", () => {
  it("accepts an HTTP(S) target with an optional permalink", () => {
    expect(
      isAfterSubscribeTargetResponse({ target: { url: "http://example.com" } }),
    ).toBe(true);
    expect(
      isAfterSubscribeTargetResponse({
        target: {
          url: "https://www.reddit.com/r/example/comments/abc",
          permalink: "/r/example/comments/abc",
        },
      }),
    ).toBe(true);
  });

  it.each([
    null,
    {},
    { target: null },
    { target: { url: "  " } },
    { target: { url: "/r/example" } },
    { target: { url: "ftp://example.com" } },
    { target: { url: "https://example.com", permalink: 1 } },
  ])("rejects unusable payload %j", (payload) => {
    expect(isAfterSubscribeTargetResponse(payload)).toBe(false);
  });
});
