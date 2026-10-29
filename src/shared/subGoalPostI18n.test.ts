import { describe, expect, it } from "vitest";
import {
  afterSubscribePresetMessages,
  defaultSubGoalLanguage,
  formatLocalizedCtaActivity,
  formatLocalizedSubscriberGrowth,
  formatLocalizedSubscriberCount,
  getAfterSubscribePresetMessages,
  getModeratorInstallPromotionMessages,
  getSubGoalPostMessages,
  resolveSubGoalLanguage,
  subGoalLanguages,
  subGoalPostMessages,
} from "./subGoalPostI18n";
import type { SubGoalLanguage } from "./subGoalPostI18n";

const expectedJoinButtons: Record<SubGoalLanguage, string> = {
  id: "Bergabung dengan r/ExampleSub",
  bs: "Pridruži se r/ExampleSub",
  ca: "Uneix-te a r/ExampleSub",
  da: "Deltag i r/ExampleSub",
  de: "r/ExampleSub beitreten",
  en: "Join r/ExampleSub",
  hi: "r/ExampleSub में शामिल हों",
  pa: "r/ExampleSub ਵਿੱਚ ਸ਼ਾਮਲ ਹੋਵੋ",
  mr: "r/ExampleSub मध्ये सामील व्हा",
  es: "Unirse a r/ExampleSub",
  et: "Liitu kogukonnaga r/ExampleSub",
  fr: "Rejoindre r/ExampleSub",
  hr: "Pridruži se r/ExampleSub",
  is: "Gakktu til liðs við r/ExampleSub",
  it: "Unisciti a r/ExampleSub",
  lv: "Pievienojies r/ExampleSub",
  lt: "Prisijungti prie r/ExampleSub",
  hu: "Csatlakozz ehhez: r/ExampleSub",
  nl: "Lid worden van r/ExampleSub",
  nb: "Bli med i r/ExampleSub",
  pl: "Dołącz do r/ExampleSub",
  pt: "Unir-se a r/ExampleSub",
  ro: "Alătură-te r/ExampleSub",
  sq: "Bashkohu me r/ExampleSub",
  sk: "Pripojiť sa k r/ExampleSub",
  sl: "Pridruži se r/ExampleSub",
  fi: "Liity yhteisöön r/ExampleSub",
  sv: "Gå med i r/ExampleSub",
  tl: "Sumali sa r/ExampleSub",
  tr: "r/ExampleSub topluluğuna katıl",
  yo: "Darapọ̀ mọ́ r/ExampleSub",
};

describe("subGoalPostI18n", () => {
  it("uses the approved Join CTA in every supported language", () => {
    expect(Object.keys(expectedJoinButtons)).toHaveLength(
      subGoalLanguages.length,
    );

    for (const language of subGoalLanguages) {
      const actual = getSubGoalPostMessages(language).subscribeButton({
        subredditName: "ExampleSub",
      });
      expect(actual, language).toBe(expectedJoinButtons[language]);
      expect(actual.split("r/ExampleSub"), language).toHaveLength(2);
    }

    expect(
      getSubGoalPostMessages("en").subscribedButton({
        subredditName: "ExampleSub",
      }),
    ).toBe("Joined r/ExampleSub");
    expect(
      getSubGoalPostMessages("hi").subscribedButton({
        subredditName: "ExampleSub",
      }),
    ).toBe("r/ExampleSub में शामिल हो गए");
  });

  it("uses localized Join wording for every member action state", () => {
    const actionCopy = (language: SubGoalLanguage) => {
      const messages = getSubGoalPostMessages(language);
      return [
        messages.subscribedButton({ subredditName: "ExampleSub" }),
        messages.shareUsernameLabel,
        messages.thanksTitle,
        messages.subscriberNotice({ username: "alice" }),
        messages.subscriberNotice({ username: null }),
        messages.subscribeSuccessToast,
        messages.subscribeErrorToast,
        messages.loginRequired,
      ];
    };
    const english = actionCopy("en");

    expect(english).toEqual([
      "Joined r/ExampleSub",
      "Show my username when I join",
      "Thanks for Joining!",
      "u/alice just joined!",
      "New member just joined!",
      "Thanks for joining!",
      "Couldn't join the community.",
      "Please log in to join.",
    ]);

    for (const language of subGoalLanguages) {
      const values = actionCopy(language);
      expect(
        values.every((value) => value.length > 0),
        language,
      ).toBe(true);
      expect(values[0]?.split("r/ExampleSub"), language).toHaveLength(2);
      expect(values[3]?.split("u/alice"), language).toHaveLength(2);
      if (language !== "en") expect(values, language).not.toEqual(english);
    }
  });

  it("provides moderator install promotion copy for every language", () => {
    for (const language of subGoalLanguages) {
      const messages = getModeratorInstallPromotionMessages(language);
      expect(messages.greeting.length, `${language}.greeting`).toBeGreaterThan(
        0,
      );
      expect(messages.body.length, `${language}.body`).toBeGreaterThan(0);
      expect(messages.body, `${language}.body`).toContain("Subscriber Goal");
      expect(messages.body, `${language}.body`).not.toContain("2x");
      expect(messages.body, `${language}.body`).toMatch(/!$/);
      expect(
        messages.installButton.length,
        `${language}.installButton`,
      ).toBeGreaterThan(0);
      expect(
        messages.mobileInstallButton.length,
        `${language}.mobileInstallButton`,
      ).toBeGreaterThan(0);
      expect(
        messages.mobileInstallButton,
        `${language}.mobileInstallButton`,
      ).toContain("SubGoal");
    }
    expect(getModeratorInstallPromotionMessages("unknown")).toEqual(
      getModeratorInstallPromotionMessages("en"),
    );
    expect(getModeratorInstallPromotionMessages("en").greeting).toBe("Hi");
    expect(getModeratorInstallPromotionMessages("en").body).toBe(
      "Add Subscriber Goal to your own subreddits now!",
    );
    expect(getModeratorInstallPromotionMessages("en").mobileInstallButton).toBe(
      "Install SubGoal Now",
    );
  });
  it("formats the desktop subscriber count in every supported language", () => {
    expect(formatLocalizedSubscriberCount("en", 15_100, "15.1k")).toBe(
      "15.1k subscribers",
    );
    expect(formatLocalizedSubscriberCount("es", 15_100, "15.1k")).toBe(
      "15.1k suscriptores",
    );
    expect(formatLocalizedSubscriberCount("en", 1)).toBe("1 subscriber");
    expect(formatLocalizedSubscriberCount("es", 1)).toBe("1 suscriptor");
    for (const language of subGoalLanguages) {
      expect(formatLocalizedSubscriberCount(language, 15_100, "15.1k")).toMatch(
        /^15\.1k .+/,
      );
    }
  });

  it("formats daily and weekly growth with locale plural rules", () => {
    expect(
      formatLocalizedSubscriberGrowth("en", { count: 1, period: "today" }),
    ).toBe("1 new today");
    expect(
      formatLocalizedSubscriberGrowth("en", { count: 2, period: "today" }),
    ).toBe("2 new today");
    expect(
      formatLocalizedSubscriberGrowth("es", { count: 1, period: "today" }),
    ).toBe("1 nuevo hoy");
    expect(
      formatLocalizedSubscriberGrowth("es", { count: 2, period: "today" }),
    ).toBe("2 nuevos hoy");
    expect(
      formatLocalizedSubscriberGrowth("en", { count: 1, period: "week" }),
    ).toBe("1 new this week");
    expect(
      formatLocalizedSubscriberGrowth("es", { count: 2, period: "week" }),
    ).toBe("2 nuevos esta semana");
    for (const language of subGoalLanguages) {
      const locale = subGoalPostMessages[language].intlLocale;
      const pluralRules = new Intl.PluralRules(locale);
      const candidates = [
        ...Array.from({ length: 201 }, (_, count) => count),
        0.1,
        1.1,
        2.1,
        10.1,
        1000,
        1_000_000,
      ];
      for (const category of pluralRules.resolvedOptions().pluralCategories) {
        const count = candidates.find(
          (candidate) => pluralRules.select(candidate) === category,
        );
        expect(count, `${language}.${category}`).toBeDefined();
        if (count === undefined) continue;
        for (const period of ["today", "week"] as const) {
          const countText = `#${category}#`;
          const output = formatLocalizedSubscriberGrowth(
            language,
            { count, period },
            countText,
          );
          expect(
            output.length,
            `${language}.${period}.${category}`,
          ).toBeGreaterThan(0);
          expect(
            output.split(countText).length - 1,
            `${language}.${period}.${category}`,
          ).toBe(1);
        }
      }
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
      "hi",
      "pa",
      "mr",
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
      "हिन्दी",
      "ਪੰਜਾਬੀ",
      "मराठी",
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
      "Português (Brasil)",
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
    expect(resolveSubGoalLanguage("hi")).toBe("hi");
    expect(resolveSubGoalLanguage("pa")).toBe("pa");
    expect(resolveSubGoalLanguage("mr")).toBe("mr");
  });

  it("renders the reviewed Punjabi catalog and inferred plural forms", () => {
    const messages = getSubGoalPostMessages("pa");

    expect(messages.languageLabel).toBe("ਪੰਜਾਬੀ");
    expect(messages.intlLocale).toBe("pa-IN");
    expect(messages.subscribeButton({ subredditName: "ਉਦਾਹਰਣ" })).toBe(
      "r/ਉਦਾਹਰਣ ਵਿੱਚ ਸ਼ਾਮਲ ਹੋਵੋ",
    );
    expect(messages.subscribedButton({ subredditName: "ਉਦਾਹਰਣ" })).toBe(
      "r/ਉਦਾਹਰਣ ਵਿੱਚ ਸ਼ਾਮਲ ਹੋ ਗਏ ਹੋ",
    );
    expect(messages.thanksTitle).toBe("ਸ਼ਾਮਲ ਹੋਣ ਲਈ ਧੰਨਵਾਦ!");
    expect(
      messages.completedTitle({
        subredditName: "ਉਦਾਹਰਣ",
        goalCount: 1_000,
        goalText: "1,000",
      }),
    ).toBe("r/ਉਦਾਹਰਣ ਨੇ 1,000 ਸਬਸਕ੍ਰਾਈਬਰਾਂ ਦਾ ਟੀਚਾ ਪੂਰਾ ਕਰ ਲਿਆ!");
    expect(
      formatLocalizedCtaActivity(
        "pa",
        { kind: "posts", count: 2, period: "today" },
        "2",
      ),
    ).toBe("ਅੱਜ 2 ਨਵੀਆਂ ਪੋਸਟਾਂ");
    expect(
      formatLocalizedCtaActivity(
        "pa",
        { kind: "posts", count: 1, period: "week" },
        "1",
      ),
    ).toBe("ਇਸ ਹਫ਼ਤੇ 1 ਨਵੀਂ ਪੋਸਟ");
  });

  it("renders the reviewed Marathi catalog", () => {
    const messages = getSubGoalPostMessages("mr");

    expect(messages.languageLabel).toBe("मराठी");
    expect(messages.intlLocale).toBe("mr-IN");
    expect(messages.subscribeButton({ subredditName: "उदाहरण" })).toBe(
      "r/उदाहरण मध्ये सामील व्हा",
    );
    expect(messages.subscribedButton({ subredditName: "उदाहरण" })).toBe(
      "r/उदाहरण मध्ये सामील झाला आहात",
    );
    expect(messages.thanksTitle).toBe("सामील झाल्याबद्दल धन्यवाद!");
    expect(
      messages.fallbackCompleted({
        subredditName: "उदाहरण",
        goalCount: 1_000,
        goalText: "1,000",
        completedIso: "2026-10-29T12:00:00Z",
      }),
    ).toContain("ध्येय पूर्ण झाल्याची वेळ: 2026-10-29T12:00:00Z");
    expect(getModeratorInstallPromotionMessages("mr")).toMatchObject({
      greeting: "नमस्कार",
      body: "आत्ताच तुमच्या सबरेडिट्समध्ये Subscriber Goal जोडा!",
      mobileInstallButton: "आत्ताच SubGoal इंस्टॉल करा",
    });
  });

  it("renders the reviewed Hindi catalog and terminology", () => {
    const messages = getSubGoalPostMessages("hi");

    expect(messages.languageLabel).toBe("हिन्दी");
    expect(messages.intlLocale).toBe("hi-IN");
    expect(messages.subscribedButton({ subredditName: "उदाहरण" })).toBe(
      "r/उदाहरण में शामिल हो गए",
    );
    expect(
      messages.thanksBody({ subscribersCount: 15_000, subscribersText: "15k" }),
    ).toBe("कम्यूनिटी में अब 15k सब्सक्राइबर हैं!");
    expect(
      messages.completedTitle({
        subredditName: "उदाहरण",
        goalCount: 15_000,
        goalText: "15k",
      }),
    ).toBe("r/उदाहरण ने 15k सब्सक्राइबर पूरे कर लिए!");
    expect(
      messages.fallbackCompleted({
        subredditName: "उदाहरण",
        goalCount: 15_000,
        goalText: "15k",
        completedIso: "2026-10-28T12:00:00Z",
      }),
    ).toContain("लक्ष्य पूरा होने का समय: `2026-10-28T12:00:00Z`");
    expect(messages.subscriberNotice({ username: "आशा" })).toBe(
      "u/आशा अभी-अभी शामिल हुए!",
    );
  });

  it("formats Hindi counts and activity with singular and plural forms", () => {
    expect(formatLocalizedSubscriberCount("hi", 1, "1")).toBe("1 सब्सक्राइबर");
    expect(formatLocalizedSubscriberCount("hi", 2, "2")).toBe("2 सब्सक्राइबर");
    expect(
      formatLocalizedSubscriberGrowth("hi", { count: 1, period: "today" }, "1"),
    ).toBe("आज 1 नया");
    expect(
      formatLocalizedSubscriberGrowth("hi", { count: 2, period: "today" }, "2"),
    ).toBe("आज 2 नए");
    expect(
      formatLocalizedCtaActivity(
        "hi",
        { kind: "posts", count: 1, period: "today" },
        "1",
      ),
    ).toBe("आज 1 नई पोस्ट");
    expect(
      formatLocalizedCtaActivity(
        "hi",
        { kind: "posts", count: 2, period: "today" },
        "2",
      ),
    ).toBe("आज 2 नई पोस्टें");
  });

  it("provides reviewed Hindi promotion and after-subscribe actions", () => {
    expect(getModeratorInstallPromotionMessages("hi")).toMatchObject({
      greeting: "नमस्ते",
      body: "अभी अपने सबरेडिट्स में Subscriber Goal जोड़ें!",
      installButton: "अभी Subscriber Goal इंस्टॉल करें",
      mobileInstallButton: "अभी SubGoal इंस्टॉल करें",
    });
    expect(getAfterSubscribePresetMessages("hi")).toMatchObject({
      joinDiscord: "Discord से जुड़ें",
      readWiki: "विकी पढ़ें",
      createNewPost: "नई पोस्ट बनाएँ",
      dynamicPostUnavailable: "अभी कोई पोस्ट उपलब्ध नहीं है।",
    });
  });

  it("renders Spanish dynamic post messages", () => {
    const messages = getSubGoalPostMessages("es");

    expect(messages.defaultPostTitle({ subredditName: "Ejemplo" })).toBe(
      "¡Bienvenido a r/Ejemplo!",
    );
    expect(
      messages.thanksBody({ subscribersCount: 15_000, subscribersText: "15k" }),
    ).toBe("¡Ahora hay 15k suscriptores en la comunidad!");
    expect(
      messages.completedTitle({
        subredditName: "Ejemplo",
        goalCount: 15_000,
        goalText: "15k",
      }),
    ).toBe("¡r/Ejemplo alcanzó 15k suscriptores!");
    expect(messages.subscriberNotice({ username: "ana" })).toBe(
      "¡u/ana se acaba de unir!",
    );
  });

  it("uses plural-aware subscriber phrases inside full messages", () => {
    const english = getSubGoalPostMessages("en");
    const spanish = getSubGoalPostMessages("es");

    expect(
      english.thanksBody({ subscribersCount: 1, subscribersText: "1" }),
    ).toBe("The community now has 1 subscriber!");
    expect(
      spanish.completedTitle({
        subredditName: "Ejemplo",
        goalCount: 1,
        goalText: "1",
      }),
    ).toBe("¡r/Ejemplo alcanzó 1 suscriptor!");
    expect(
      english.fallbackActive({
        subredditName: "Example",
        subscribersCount: 1,
        subscribersText: "1",
        goalCount: 2,
        goalText: "2",
      }),
    ).toContain("1 subscriber / 2 subscribers.");
  });

  it("keeps count and name placeholders intact in every localized full message", () => {
    for (const language of subGoalLanguages) {
      const messages = getSubGoalPostMessages(language);
      for (const count of [1, 2, 10]) {
        const countText = `#${count}#`;
        const thanks = messages.thanksBody({
          subscribersCount: count,
          subscribersText: countText,
        });
        const completed = messages.completedTitle({
          subredditName: "ExampleSub",
          goalCount: count,
          goalText: countText,
        });
        const activeFallback = messages.fallbackActive({
          subredditName: "ExampleSub",
          subscribersCount: count,
          subscribersText: `#CURRENT-${count}#`,
          goalCount: count,
          goalText: `#GOAL-${count}#`,
        });
        const completedFallback = messages.fallbackCompleted({
          subredditName: "ExampleSub",
          goalCount: count,
          goalText: countText,
          completedIso: "2026-10-29T12:00:00Z",
        });
        expect(
          thanks.split(countText).length - 1,
          `${language}.thanks.${count}`,
        ).toBe(1);
        expect(
          completed.split(countText).length - 1,
          `${language}.completed.${count}`,
        ).toBe(1);
        expect(completed).toContain("r/ExampleSub");
        expect(
          activeFallback.split(`#CURRENT-${count}#`).length - 1,
          `${language}.activeFallback.current.${count}`,
        ).toBe(1);
        expect(
          activeFallback.split(`#GOAL-${count}#`).length - 1,
          `${language}.activeFallback.goal.${count}`,
        ).toBe(1);
        expect(
          completedFallback.split(countText).length - 1,
          `${language}.completedFallback.${count}`,
        ).toBe(1);
        expect(completedFallback).toContain("r/ExampleSub");
      }
    }
  });

  it.each([
    ["pa", 10, "r/Example ਨੇ 10 ਸਬਸਕ੍ਰਾਈਬਰਾਂ ਦਾ ਟੀਚਾ ਪੂਰਾ ਕਰ ਲਿਆ!"],
    ["mr", 10, "r/Example ने 10 सबस्क्राइबरचा टप्पा गाठला!"],
    ["tr", 10, "r/Example 10 aboneye ulaştı!"],
    ["et", 10, "r/Example jõudis 10 tellijani!"],
  ] as const)(
    "uses the contextual reached-count form for %s",
    (language, count, expected) => {
      expect(
        getSubGoalPostMessages(language).completedTitle({
          subredditName: "Example",
          goalCount: count,
          goalText: String(count),
        }),
      ).toBe(expected);
    },
  );

  it("uses Join terminology for the Indonesian action and joined state", () => {
    const messages = getSubGoalPostMessages("id");

    expect(messages.subscribeButton({ subredditName: "Contoh" })).toBe(
      "Bergabung dengan r/Contoh",
    );
    expect(messages.subscribedButton({ subredditName: "Contoh" })).toBe(
      "Bergabung dengan r/Contoh",
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
