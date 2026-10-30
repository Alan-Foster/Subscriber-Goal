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

  it("defines the two no-goal post type labels in all 31 locales", () => {
    const expected = {
      id: {
        tiny: "Tombol Berlangganan dan Tombol Ajakan Bertindak (Tanpa Target)",
        cta: "Tombol Ajakan Bertindak (Tanpa Berlangganan)",
      },
      bs: {
        tiny: "Dugme za pretplatu i dugme za poziv na akciju (Bez cilja)",
        cta: "Dugme za poziv na akciju (Bez pretplate)",
      },
      ca: {
        tiny: "Botó de subscripció i botó de crida a l'acció (Sense objectiu)",
        cta: "Botó de crida a l'acció (Sense subscripció)",
      },
      da: {
        tiny: "Abonner-knap og handlingsknap (Intet mål)",
        cta: "Handlingsknap (Uden abonnement)",
      },
      de: {
        tiny: "Abonnieren-Button und Handlungsaufforderungs-Button (Kein Ziel)",
        cta: "Handlungsaufforderungs-Button (Ohne Abonnieren)",
      },
      en: {
        tiny: "Subscribe Button and Call to Action Button (No Goal)",
        cta: "Call To Action Button (No Subscribing)",
      },
      hi: {
        tiny: "सब्सक्राइब बटन और कार्रवाई के लिए प्रेरित करने वाला बटन (बिना लक्ष्य)",
        cta: "कार्रवाई के लिए प्रेरित करने वाला बटन (बिना सब्सक्राइब किए)",
      },
      pa: {
        tiny: "ਸਬਸਕ੍ਰਾਈਬ ਬਟਨ ਅਤੇ ਕਾਰਵਾਈ ਲਈ ਪ੍ਰੇਰਿਤ ਕਰਨ ਵਾਲਾ ਬਟਨ (ਬਿਨਾਂ ਟੀਚੇ)",
        cta: "ਕਾਰਵਾਈ ਲਈ ਪ੍ਰੇਰਿਤ ਕਰਨ ਵਾਲਾ ਬਟਨ (ਸਬਸਕ੍ਰਾਈਬ ਕੀਤੇ ਬਿਨਾਂ)",
      },
      mr: {
        tiny: "सबस्क्राइब बटण आणि कृतीस प्रवृत्त करणारे बटण (ध्येयाशिवाय)",
        cta: "कृतीस प्रवृत्त करणारे बटण (सबस्क्राइब न करता)",
      },
      es: {
        tiny: "Botón de suscripción y botón de llamada a la acción (Sin objetivo)",
        cta: "Botón de llamada a la acción (Sin suscripción)",
      },
      et: {
        tiny: "Tellimisnupp ja tegevusele kutsuv nupp (Ilma eesmärgita)",
        cta: "Tegevusele kutsuv nupp (Ilma tellimiseta)",
      },
      fr: {
        tiny: "Bouton d'abonnement et bouton d'appel à l'action (Sans objectif)",
        cta: "Bouton d'appel à l'action (Sans abonnement)",
      },
      hr: {
        tiny: "Gumb za pretplatu i gumb za poziv na akciju (Bez cilja)",
        cta: "Gumb za poziv na akciju (Bez pretplate)",
      },
      is: {
        tiny: "Áskriftarhnappur og aðgerðahvetjandi hnappur (Ekkert markmið)",
        cta: "Aðgerðahvetjandi hnappur (Án áskriftar)",
      },
      it: {
        tiny: "Pulsante di iscrizione e pulsante di invito all'azione (Senza obiettivo)",
        cta: "Pulsante di invito all'azione (Senza iscrizione)",
      },
      lv: {
        tiny: "Abonēšanas poga un aicinājuma rīkoties poga (Bez mērķa)",
        cta: "Aicinājuma rīkoties poga (Bez abonēšanas)",
      },
      lt: {
        tiny: "Prenumeratos mygtukas ir raginimo veikti mygtukas (Be tikslo)",
        cta: "Raginimo veikti mygtukas (Be prenumeratos)",
      },
      hu: {
        tiny: "Feliratkozás gomb és cselekvésre ösztönző gomb (Cél nélkül)",
        cta: "Cselekvésre ösztönző gomb (Feliratkozás nélkül)",
      },
      nl: {
        tiny: "Abonneerknop en oproep-tot-actieknop (Geen doel)",
        cta: "Oproep-tot-actieknop (Zonder abonneren)",
      },
      nb: {
        tiny: "Abonner-knapp og handlingsoppfordringsknapp (Uten mål)",
        cta: "Handlingsoppfordringsknapp (Uten abonnement)",
      },
      pl: {
        tiny: "Przycisk subskrypcji i przycisk wezwania do działania (Bez celu)",
        cta: "Przycisk wezwania do działania (Bez subskrypcji)",
      },
      pt: {
        tiny: "Botão de inscrição e botão de chamada para ação (Sem meta)",
        cta: "Botão de chamada para ação (Sem inscrição)",
      },
      ro: {
        tiny: "Buton de abonare și buton de îndemn la acțiune (Fără obiectiv)",
        cta: "Buton de îndemn la acțiune (Fără abonare)",
      },
      sq: {
        tiny: "Butoni i abonimit dhe butoni i thirrjes për veprim (Pa objektiv)",
        cta: "Butoni i thirrjes për veprim (Pa abonim)",
      },
      sk: {
        tiny: "Tlačidlo na odber a tlačidlo výzvy na akciu (Bez cieľa)",
        cta: "Tlačidlo výzvy na akciu (Bez odberu)",
      },
      sl: {
        tiny: "Gumb za naročanje in gumb s pozivom k dejanju (Brez cilja)",
        cta: "Gumb s pozivom k dejanju (Brez naročanja)",
      },
      fi: {
        tiny: "Tilauspainike ja toimintakehotuspainike (Ei tavoitetta)",
        cta: "Toimintakehotuspainike (Ilman tilaamista)",
      },
      sv: {
        tiny: "Prenumerationsknapp och uppmaningsknapp (Inget mål)",
        cta: "Uppmaningsknapp (Utan prenumeration)",
      },
      tl: {
        tiny: "Button sa Pag-subscribe at Button sa Paghikayat na Kumilos (Walang Goal)",
        cta: "Button sa Paghikayat na Kumilos (Walang Pag-subscribe)",
      },
      tr: {
        tiny: "Abone Ol Butonu ve Harekete Geçirici Buton (Hedef Yok)",
        cta: "Harekete Geçirici Buton (Abonelik Olmadan)",
      },
      yo: {
        tiny: "Bọ́tìnì Ìforúkọsílẹ̀ àti Bọ́tìnì Ìpè sí Ìgbésẹ̀ (Láìsí Àfojúsùn)",
        cta: "Bọ́tìnì Ìpè sí Ìgbésẹ̀ (Láìsí Ìforúkọsílẹ̀)",
      },
    } as const;

    expect(Object.keys(expected).sort()).toEqual([...appLanguages].sort());
    for (const language of appLanguages) {
      expect(
        localizationCatalog.locales[language].messages["moderator.setup.tiny"],
        `${language}.moderator.setup.tiny`,
      ).toBe(expected[language].tiny);
      expect(
        localizationCatalog.locales[language].messages["moderator.setup.cta"],
        `${language}.moderator.setup.cta`,
      ).toBe(expected[language].cta);
    }
    expect(expected.en.tiny).not.toMatch(/\bCTA\b/u);
    expect(expected.en.cta).not.toMatch(/\bCTA\b/u);
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
