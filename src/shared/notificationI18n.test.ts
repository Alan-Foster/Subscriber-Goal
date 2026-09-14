import { describe, expect, it } from "vitest";
import { getNotificationMessages } from "./notificationI18n";
import { subGoalLanguages } from "./subGoalPostI18n";

describe("notification messages", () => {
  it.each(subGoalLanguages)(
    "defines every notification string for %s",
    (language) => {
      const messages = getNotificationMessages(language);
      for (const value of Object.values(messages)) {
        const rendered =
          typeof value === "function" ? value({ goalText: "1000" }) : value;
        expect(rendered.trim().length).toBeGreaterThan(0);
        expect(rendered).not.toContain("{{goalText}}");
      }
    },
  );

  it("falls back to English when no language is available", () => {
    expect(getNotificationMessages(undefined).title).toBe(
      "Notification Settings",
    );
  });
});
