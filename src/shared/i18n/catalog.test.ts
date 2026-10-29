import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { IntlMessageFormat } from "intl-messageformat";
import {
  appLanguages,
  getLanguageMetadata,
  getTranslationCoverage,
  isMessageKey,
  localizationCatalog,
  resolveAppLanguage,
  translate,
} from "./catalog";

describe("localization catalog", () => {
  it("is the single complete source for the 31-language interactive UI", () => {
    expect(appLanguages).toHaveLength(31);
    const requiredKeys = Object.entries(localizationCatalog.definitions)
      .filter(([, definition]) => definition.policy === "required")
      .map(([key]) => key);
    for (const language of appLanguages) {
      const metadata = getLanguageMetadata(language);
      expect(metadata.locale).toBeTruthy();
      expect(() => new Intl.NumberFormat(metadata.locale)).not.toThrow();
      for (const key of requiredKeys) {
        expect(
          localizationCatalog.locales[language].messages[
            key as keyof (typeof localizationCatalog.locales)[typeof language]["messages"]
          ],
          `${language}.${key}`,
        ).toBeTruthy();
      }
    }
  });

  it("defines Punjabi and Marathi metadata", () => {
    expect(getLanguageMetadata("pa")).toMatchObject({
      label: "ਪੰਜਾਬੀ",
      locale: "pa-IN",
    });
    expect(getLanguageMetadata("mr")).toMatchObject({
      label: "मराठी",
      locale: "mr-IN",
    });
    expect(
      translate("pa", "post.completedTitle", {
        subredditName: "ਉਦਾਹਰਣ",
        goalCountLabel: translate("pa", "metric.subscribersReached", {
          count: 1_000,
          countText: "1,000",
        }),
      }),
    ).toBe("r/ਉਦਾਹਰਣ ਨੇ 1,000 ਸਬਸਕ੍ਰਾਈਬਰਾਂ ਦਾ ਟੀਚਾ ਪੂਰਾ ਕਰ ਲਿਆ!");
    expect(
      translate("mr", "post.completedTitle", {
        subredditName: "उदाहरण",
        goalCountLabel: translate("mr", "metric.subscribersReached", {
          count: 1_000,
          countText: "1,000",
        }),
      }),
    ).toBe("r/उदाहरण ने 1,000 सबस्क्राइबरचा टप्पा गाठला!");
  });

  it("keeps Portuguese storage canonical while accepting metadata aliases", () => {
    expect(getLanguageMetadata("pt")).toEqual({
      label: "Português (Brasil)",
      locale: "pt-BR",
    });
    for (const alias of ["pt-BR", "pt-br", "pt_BR"]) {
      expect(resolveAppLanguage(alias)).toBe("pt");
      expect(getLanguageMetadata(alias)).toEqual({
        label: "Português (Brasil)",
        locale: "pt-BR",
      });
    }
  });

  it("formats ICU values and plural branches", () => {
    expect(
      translate("en", "post.joinButton", { subredditName: "Example" }),
    ).toBe("Join r/Example");
    expect(
      translate("en", "activity.postsToday", {
        count: 1,
        countText: "1",
      }),
    ).toBe("1 new post today");
    expect(
      translate("en", "activity.postsToday", {
        count: 2,
        countText: "2",
      }),
    ).toBe("2 new posts today");
  });

  it("rejects missing and unused values", () => {
    expect(() => translate("en", "post.joinButton")).toThrow("subredditName");
    expect(() =>
      translate("en", "post.thanksTitle", { unused: "value" }),
    ).toThrow("unused");
  });

  it("rejects inherited language and message-key properties", () => {
    expect(resolveAppLanguage("constructor")).toBe("en");
    expect(resolveAppLanguage("toString")).toBe("en");
    expect(isMessageKey("constructor")).toBe(false);
    expect(isMessageKey("toString")).toBe(false);
    expect(() => translate("en", "constructor" as never)).toThrow(
      "Unknown localization key",
    );
  });

  it("reports intentional English fallback coverage", () => {
    const hindi = getTranslationCoverage().find(
      ({ language }) => language === "hi",
    );
    expect(hindi?.missingFallbackKeys).toContain("errors.join.transport");
    expect(translate("hi", "errors.join.transport")).toBe(
      "Could not join the community.",
    );
  });

  it("keeps ICU syntax and placeholders aligned with English", () => {
    const pattern = /\{([A-Za-z][A-Za-z0-9_]*)(?:\s*,|\})/gu;
    const names = (message: string) =>
      [
        ...new Set([...message.matchAll(pattern)].map((match) => match[1])),
      ].sort();
    const english = localizationCatalog.locales.en.messages;
    for (const language of appLanguages) {
      const locale = localizationCatalog.locales[language];
      for (const key of Object.keys(localizationCatalog.definitions) as Array<
        keyof typeof localizationCatalog.definitions
      >) {
        const message = locale.messages[key];
        if (!message) continue;
        expect(
          () => new IntlMessageFormat(message, locale.locale),
          `${language}.${key}`,
        ).not.toThrow();
        expect(names(message), `${language}.${key}`).toEqual(
          Object.keys(localizationCatalog.definitions[key].placeholders).sort(),
        );
        for (const token of localizationCatalog.definitions[key]
          .protectedTokens) {
          expect(message, `${language}.${key}`).toContain(token);
        }
      }
      expect(
        Object.keys(locale.messages).every(
          (key) => key in localizationCatalog.definitions,
        ),
        language,
      ).toBe(true);
    }
  });

  it("keeps static Devvit menu copy synchronized", () => {
    const devvit = JSON.parse(
      readFileSync(`${globalThis.process.cwd()}/devvit.json`, "utf8"),
    ) as { menu: { items: Array<{ label: string; description: string }> } };
    const keys = [
      ["menu.createGoal.label", "menu.createGoal.description"],
      ["menu.createCta.label", "menu.createCta.description"],
      ["menu.deleteGoal.label", "menu.deleteGoal.description"],
      ["menu.eraseData.label", "menu.eraseData.description"],
      ["menu.eraseOwnData.label", "menu.eraseOwnData.description"],
    ] as const;
    for (const [index, [label, description]] of keys.entries()) {
      expect(devvit.menu.items[index]).toMatchObject({
        label: localizationCatalog.locales.en.messages[label],
        description: localizationCatalog.locales.en.messages[description],
      });
    }
  });
});
