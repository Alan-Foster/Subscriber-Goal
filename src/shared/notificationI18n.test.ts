import { describe, expect, it } from "vitest";
import { getNotificationMessages } from "./notificationI18n";
import { subGoalLanguages } from "./subGoalPostI18n";

describe("notification messages", () => {
  it.each(subGoalLanguages)(
    "defines every notification string for %s",
    (language) => {
      const messages = getNotificationMessages(language);
      for (const value of Object.values(messages)) {
        expect(value.trim().length).toBeGreaterThan(0);
      }
    },
  );

  it("falls back to English when no language is available", () => {
    expect(getNotificationMessages(undefined).title).toBe(
      "Notification Settings",
    );
  });
});
