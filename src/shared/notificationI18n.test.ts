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

  it("uses the reviewed Hindi notification terminology", () => {
    const messages = getNotificationMessages("hi");

    expect(messages.title).toBe("नोटिफ़िकेशन सेटिंग्स");
    expect(messages.description).toBe(
      "सब्सक्राइबर लक्ष्य पूरा होने पर सूचना पाएँ",
    );
    expect(messages.goalPrompt({ goalText: "1,000" })).toBe(
      "1,000 सब्सक्राइबर होने पर सूचना पाएँ",
    );
    expect(messages.enabledHeading).toBe("नोटिफ़िकेशन चालू हैं!");
    expect(messages.successBody).toBe(
      "लक्ष्य पूरा होने पर आपको सूचना दी जाएगी।",
    );
  });

  it("uses the reviewed Punjabi notification terminology", () => {
    const messages = getNotificationMessages("pa");

    expect(messages.title).toBe("ਨੋਟੀਫਿਕੇਸ਼ਨ ਸੈਟਿੰਗਾਂ");
    expect(messages.description).toBe(
      "ਸਬਸਕ੍ਰਾਈਬਰ ਟੀਚਾ ਪੂਰਾ ਹੋਣ 'ਤੇ ਸੂਚਨਾ ਪ੍ਰਾਪਤ ਕਰੋ",
    );
    expect(messages.goalPrompt({ goalText: "1,000" })).toBe(
      "1,000 ਸਬਸਕ੍ਰਾਈਬਰ ਹੋਣ 'ਤੇ ਸੂਚਨਾ ਪ੍ਰਾਪਤ ਕਰੋ",
    );
    expect(messages.enabledHeading).toBe("ਨੋਟੀਫਿਕੇਸ਼ਨ ਚਾਲੂ ਹਨ!");
    expect(messages.successBody).toBe(
      "ਟੀਚਾ ਪੂਰਾ ਹੋਣ 'ਤੇ ਤੁਹਾਨੂੰ ਸੂਚਨਾ ਮਿਲੇਗੀ।",
    );
  });

  it("uses the reviewed Marathi notification terminology", () => {
    const messages = getNotificationMessages("mr");

    expect(messages.title).toBe("नोटिफिकेशन सेटिंग्ज");
    expect(messages.description).toBe(
      "सबस्क्राइबरचे ध्येय पूर्ण झाल्यावर सूचना मिळवा",
    );
    expect(messages.goalPrompt({ goalText: "1,000" })).toBe(
      "1,000 सबस्क्राइबर झाल्यावर सूचना मिळवा",
    );
    expect(messages.enabledHeading).toBe("नोटिफिकेशन्स चालू आहेत!");
    expect(messages.successBody).toBe(
      "ध्येय पूर्ण झाल्यावर तुम्हाला सूचना मिळेल.",
    );
  });
});
