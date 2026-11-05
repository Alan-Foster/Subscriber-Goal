// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStatisticsEventId } from "./statisticsAnalytics";

describe("statistics analytics identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the platform UUID generator when available", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
    });
    expect(createStatisticsEventId()).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("builds a UUID from secure random bytes when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.forEach((_, index) => {
          bytes[index] = index;
        });
        return bytes;
      },
    });
    expect(createStatisticsEventId()).toBe(
      "00010203-0405-4607-8809-0a0b0c0d0e0f",
    );
  });

  it("fails closed instead of generating a predictable identifier", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => createStatisticsEventId()).toThrow(
      "Secure random values are unavailable.",
    );
  });
});
