import { describe, expect, it } from "vitest";
import { parsePersistedSubscriberGoal } from "./subGoalData";

describe("parsePersistedSubscriberGoal", () => {
  it.each([undefined, null, "", "   ", "0", "not-a-number", "-5", "12.5"])(
    "rejects unusable persisted goal %j",
    (value) => {
      expect(parsePersistedSubscriberGoal(value)).toBe(0);
    },
  );

  it("rejects unsafe integers", () => {
    expect(
      parsePersistedSubscriberGoal(String(Number.MAX_SAFE_INTEGER + 1)),
    ).toBe(0);
  });

  it("preserves positive safe integer goals", () => {
    expect(parsePersistedSubscriberGoal("15000")).toBe(15_000);
  });
});
