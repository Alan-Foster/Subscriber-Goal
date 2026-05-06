import { describe, expect, it } from "vitest";
import {
  defaultSubGoalLanguage,
  getSubGoalPostMessages,
  resolveSubGoalLanguage,
  subGoalLanguages,
  subGoalPostMessages,
} from "./subGoalPostI18n";

describe("subGoalPostI18n", () => {
  it("keeps every language on the same catalog shape", () => {
    const englishKeys = Object.keys(subGoalPostMessages.en).sort();

    for (const language of subGoalLanguages) {
      expect(Object.keys(subGoalPostMessages[language]).sort()).toEqual(
        englishKeys,
      );
    }
  });

  it("lists supported languages in dropdown order and keeps English as the default", () => {
    expect(subGoalLanguages).toEqual([
      "de",
      "en",
      "es",
      "fr",
      "it",
      "nl",
      "pt",
      "ro",
    ]);
    expect(defaultSubGoalLanguage).toBe("en");
    expect(
      subGoalLanguages.map(
        (language) => subGoalPostMessages[language].languageLabel,
      ),
    ).toEqual([
      "Deutsch",
      "English",
      "Español",
      "Français",
      "Italiano",
      "Nederlands",
      "Português",
      "Română",
    ]);
  });

  it("resolves unsupported languages to English", () => {
    expect(resolveSubGoalLanguage(undefined)).toBe(defaultSubGoalLanguage);
    expect(resolveSubGoalLanguage("ja")).toBe(defaultSubGoalLanguage);
    expect(resolveSubGoalLanguage("es")).toBe("es");
    expect(resolveSubGoalLanguage("fr")).toBe("fr");
  });

  it("renders Spanish dynamic post messages", () => {
    const messages = getSubGoalPostMessages("es");

    expect(messages.defaultPostTitle({ subredditName: "Ejemplo" })).toBe(
      "¡Bienvenido a r/Ejemplo!",
    );
    expect(
      messages.completedTitle({ subredditName: "Ejemplo", goalText: "15k" }),
    ).toBe("¡r/Ejemplo alcanzó 15k suscriptores!");
    expect(messages.subscriberNotice({ username: "ana" })).toBe(
      "¡u/ana se acaba de suscribir!",
    );
  });

  it.each([
    [
      "de",
      "Willkommen bei r/Beispiel!",
      "r/Beispiel hat 15k Abonnenten erreicht!",
    ],
    ["fr", "Bienvenue sur r/Exemple !", "r/Exemple a atteint 15k abonnés !"],
    ["it", "Benvenuto in r/Esempio!", "r/Esempio ha raggiunto 15k iscritti!"],
    [
      "nl",
      "Welkom bij r/Voorbeeld!",
      "r/Voorbeeld heeft 15k abonnees bereikt!",
    ],
    ["pt", "Bem-vindo ao r/Exemplo!", "r/Exemplo alcançou 15k inscritos!"],
    ["ro", "Bun venit pe r/Exemplu!", "r/Exemplu a atins 15k abonați!"],
  ] as const)(
    "renders representative %s dynamic post messages",
    (language, expectedTitle, expectedCompletedTitle) => {
      const subredditNameByLanguage = {
        de: "Beispiel",
        fr: "Exemple",
        it: "Esempio",
        nl: "Voorbeeld",
        pt: "Exemplo",
        ro: "Exemplu",
      }[language];
      const messages = getSubGoalPostMessages(language);

      expect(
        messages.defaultPostTitle({ subredditName: subredditNameByLanguage }),
      ).toBe(expectedTitle);
      expect(
        messages.completedTitle({
          subredditName: subredditNameByLanguage,
          goalText: "15k",
        }),
      ).toBe(expectedCompletedTitle);
    },
  );
});
