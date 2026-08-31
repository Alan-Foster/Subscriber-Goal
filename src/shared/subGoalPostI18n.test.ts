import { describe, expect, it } from "vitest";
import {
  afterSubscribePresetMessages,
  defaultSubGoalLanguage,
  formatLocalizedSubscriberCount,
  getAfterSubscribePresetMessages,
  getSubGoalPostMessages,
  resolveSubGoalLanguage,
  subGoalLanguages,
  subGoalPostMessages,
} from "./subGoalPostI18n";

describe("subGoalPostI18n", () => {
  it("formats the desktop subscriber count in every supported language", () => {
    expect(formatLocalizedSubscriberCount("en", "15.1k")).toBe(
      "15.1k subscribers",
    );
    expect(formatLocalizedSubscriberCount("es", "15.1k")).toBe(
      "15.1k suscriptores",
    );
    for (const language of subGoalLanguages) {
      expect(formatLocalizedSubscriberCount(language, "15.1k")).toMatch(
        /^15\.1k .+/,
      );
    }
  });

  it("keeps every language on the same catalog shape", () => {
    const englishKeys = Object.keys(subGoalPostMessages.en).sort();

    for (const language of subGoalLanguages) {
      expect(Object.keys(subGoalPostMessages[language]).sort()).toEqual(
        englishKeys,
      );
    }
  });

  it("keeps every after-subscription preset localized and within button limits", () => {
    const englishKeys = Object.keys(afterSubscribePresetMessages.en).sort();
    const buttonMessageKeys = [
      "joinDiscord",
      "viewTopPostToday",
      "readWiki",
      "createNewPost",
      "sharePicture",
      "viewMostRecentPostToday",
    ] as const;

    for (const language of subGoalLanguages) {
      const messages = afterSubscribePresetMessages[language];
      expect(Object.keys(messages).sort()).toEqual(englishKeys);
      for (const key of buttonMessageKeys) {
        const length = Array.from(messages[key]).length;
        expect(length, `${language}.${key}`).toBeGreaterThanOrEqual(5);
        expect(length, `${language}.${key}`).toBeLessThanOrEqual(50);
      }
      expect(messages.dynamicPostUnavailable.length).toBeGreaterThan(0);
      expect(messages.dynamicPostError.length).toBeGreaterThan(0);
    }
  });

  it("returns localized preset defaults and navigation errors", () => {
    expect(getAfterSubscribePresetMessages("es")).toMatchObject({
      joinDiscord: "Únete al Discord",
      viewTopPostToday: "Ver la publicación destacada de hoy",
      readWiki: "Leer la Wiki",
      createNewPost: "Crear una publicación",
      sharePicture: "Compartir una imagen",
      viewMostRecentPostToday: "Ver la publicación más reciente de hoy",
      dynamicPostUnavailable: "No hay ninguna publicación disponible.",
    });
    expect(getAfterSubscribePresetMessages("unsupported")).toBe(
      afterSubscribePresetMessages.en,
    );
  });

  it("lists supported languages in dropdown order and keeps English as the default", () => {
    expect(subGoalLanguages).toEqual([
      "id",
      "bs",
      "ca",
      "da",
      "de",
      "en",
      "es",
      "et",
      "fr",
      "hr",
      "is",
      "it",
      "lv",
      "lt",
      "hu",
      "nl",
      "nb",
      "pl",
      "pt",
      "ro",
      "sq",
      "sk",
      "sl",
      "fi",
      "sv",
      "tl",
      "tr",
      "yo",
    ]);
    expect(defaultSubGoalLanguage).toBe("en");
    expect(
      subGoalLanguages.map(
        (language) => subGoalPostMessages[language].languageLabel,
      ),
    ).toEqual([
      "Bahasa Indonesia",
      "Bosanski",
      "Català",
      "Dansk",
      "Deutsch",
      "English",
      "Español",
      "Eesti",
      "Français",
      "Hrvatski",
      "Íslenska",
      "Italiano",
      "Latviešu",
      "Lietuvių",
      "Magyar",
      "Nederlands",
      "Norsk Bokmål",
      "Polski",
      "Português",
      "Română",
      "Shqip",
      "Slovenčina",
      "Slovenščina",
      "Suomi",
      "Svenska",
      "Tagalog",
      "Türkçe",
      "Yorùbá",
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
    expect(messages.thanksBody({ subscribersText: "15k" })).toBe(
      "¡Ahora hay 15k suscriptores en la comunidad!",
    );
    expect(
      messages.completedTitle({ subredditName: "Ejemplo", goalText: "15k" }),
    ).toBe("¡r/Ejemplo alcanzó 15k suscriptores!");
    expect(messages.subscriberNotice({ username: "ana" })).toBe(
      "¡u/ana se acaba de suscribir!",
    );
  });

  it("keeps the Indonesian subscribed state distinct from the subscribe action", () => {
    const messages = getSubGoalPostMessages("id");

    expect(messages.subscribeButton({ subredditName: "Contoh" })).toBe(
      "Berlangganan ke r/Contoh",
    );
    expect(messages.subscribedButton({ subredditName: "Contoh" })).toBe(
      "Sudah berlangganan ke r/Contoh",
    );
    expect(messages.subscribedButton({ subredditName: "Contoh" })).not.toBe(
      messages.subscribeButton({ subredditName: "Contoh" }),
    );
  });

  it("renders the corrected Yoruba load error", () => {
    expect(getSubGoalPostMessages("yo").loadError).toBe(
      "Kò le ṣàkójọpọ̀ data Subscriber Goal.",
    );
  });

  it.each([
    [
      "ca",
      "Benvingut a r/Exemple!",
      "r/Exemple ha arribat a 15k subscriptors!",
    ],
    [
      "de",
      "Willkommen bei r/Beispiel!",
      "r/Beispiel hat 15k Abonnenten erreicht!",
    ],
    ["fr", "Bienvenue sur r/Exemple !", "r/Exemple a atteint 15k abonnés !"],
    ["is", "Velkomin í r/Dæmi!", "r/Dæmi náði 15k áskrifendum!"],
    ["it", "Benvenuto in r/Esempio!", "r/Esempio ha raggiunto 15k iscritti!"],
    ["lv", "Laipni lūdzam r/Piemērs!", "r/Piemērs sasniedza 15k abonentus!"],
    [
      "lt",
      "Sveiki atvykę į r/Pavyzdys!",
      "r/Pavyzdys pasiekė 15k prenumeratorių!",
    ],
    [
      "nl",
      "Welkom bij r/Voorbeeld!",
      "r/Voorbeeld heeft 15k abonnees bereikt!",
    ],
    ["nb", "Velkommen til r/Eksempel!", "r/Eksempel nådde 15k abonnenter!"],
    ["pt", "Bem-vindo ao r/Exemplo!", "r/Exemplo alcançou 15k inscritos!"],
    ["ro", "Bun venit pe r/Exemplu!", "r/Exemplu a atins 15k abonați!"],
    ["sk", "Vitajte v r/Príklad!", "r/Príklad dosiahol 15k odberateľov!"],
    ["sl", "Dobrodošli v r/Primer!", "r/Primer je dosegel 15k naročnikov!"],
    ["tr", "r/Örnek topluluğuna hoş geldiniz!", "r/Örnek 15k aboneye ulaştı!"],
    ["yo", "Ẹ káàbọ̀ sí r/Àpẹẹrẹ!", "r/Àpẹẹrẹ ti dé 15k alabapin!"],
  ] as const)(
    "renders representative %s dynamic post messages",
    (language, expectedTitle, expectedCompletedTitle) => {
      const subredditNameByLanguage = {
        ca: "Exemple",
        de: "Beispiel",
        fr: "Exemple",
        is: "Dæmi",
        it: "Esempio",
        lv: "Piemērs",
        lt: "Pavyzdys",
        nl: "Voorbeeld",
        nb: "Eksempel",
        pt: "Exemplo",
        ro: "Exemplu",
        sk: "Príklad",
        sl: "Primer",
        tr: "Örnek",
        yo: "Àpẹẹrẹ",
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
