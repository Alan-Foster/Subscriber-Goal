export const subGoalLanguages = [
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
] as const;
export type SubGoalLanguage = (typeof subGoalLanguages)[number];

export const defaultSubGoalLanguage: SubGoalLanguage = "en";

type SubredditNameParams = {
  subredditName: string;
};

type PromoSubredditParams = {
  promoSubreddit: string;
};

type UsernameParams = {
  username?: string | null;
};

type SubscribersParams = {
  subscribersText: string;
};

type CompletedTitleParams = SubredditNameParams & {
  goalText: string;
};

type CompletedDateParams = {
  timeText: string;
  dateText: string;
};

type TextFallbackActiveParams = SubredditNameParams & {
  subscribersText: string;
  goalText: string;
};

type TextFallbackCompletedParams = SubredditNameParams & {
  goalText: string;
  completedIso: string;
};

export type SubGoalPostMessages = {
  languageLabel: string;
  intlLocale: string;
  defaultPostTitle: (params: SubredditNameParams) => string;
  welcome: (params: SubredditNameParams) => string;
  subscribeButton: (params: SubredditNameParams) => string;
  subscribedButton: (params: SubredditNameParams) => string;
  shareUsernameLabel: string;
  thanksTitle: string;
  thanksBody: (params: SubscribersParams) => string;
  thanksReturnButton: string;
  completedTitle: (params: CompletedTitleParams) => string;
  completedGoalFallback: string;
  completedReachedAt: (params: CompletedDateParams) => string;
  completedJustNow: string;
  promoAriaLabel: (params: PromoSubredditParams) => string;
  subscriberNotice: (params: UsernameParams) => string;
  subscribeSuccessToast: string;
  subscribeErrorToast: string;
  loginRequired: string;
  loadError: string;
  fallbackActive: (params: TextFallbackActiveParams) => string;
  fallbackCompleted: (params: TextFallbackCompletedParams) => string;
};

export const subGoalPostMessages: Record<SubGoalLanguage, SubGoalPostMessages> =
  {
    id: {
      languageLabel: "Bahasa Indonesia",
      intlLocale: "id-ID",
      defaultPostTitle: ({ subredditName }) =>
        `Selamat datang di r/${subredditName}!`,
      welcome: ({ subredditName }) => `Selamat datang di r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Berlangganan ke r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Sudah berlangganan ke r/${subredditName}`,
      shareUsernameLabel:
        "Tampilkan nama pengguna saya saat saya berlangganan",
      thanksTitle: "Terima kasih sudah berlangganan!",
      thanksBody: ({ subscribersText }) =>
        `Sekarang ada ${subscribersText} pelanggan di komunitas!`,
      thanksReturnButton: "Kembali ke halaman sebelumnya",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} mencapai ${goalText} pelanggan!`,
      completedGoalFallback: "target",
      completedReachedAt: ({ timeText, dateText }) =>
        `Target tercapai pukul ${timeText} pada ${dateText}`,
      completedJustNow: "Target baru saja tercapai!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Lihat target pelanggan lain di r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} baru saja berlangganan!`
          : "Anggota baru saja berlangganan!",
      subscribeSuccessToast: "Terima kasih sudah berlangganan!",
      subscribeErrorToast: "Gagal berlangganan.",
      loginRequired: "Masuk untuk berlangganan.",
      loadError: "Tidak dapat memuat data Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Selamat datang di r/${subredditName}\n\n${subscribersText} / ${goalText} pelanggan.\n  Bantu kami mencapai target!\n\nKunjungi postingan ini di Shreddit untuk menggunakan fitur interaktif.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} mencapai ${goalText} pelanggan!\n\nTarget tercapai pada \`${completedIso}\`.`,
    },
    bs: {
      languageLabel: "Bosanski",
      intlLocale: "bs-BA",
      defaultPostTitle: ({ subredditName }) =>
        `Dobro došli u r/${subredditName}!`,
      welcome: ({ subredditName }) => `Dobro došli u r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Pretplati se na r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Pretplaćeni ste na r/${subredditName}`,
      shareUsernameLabel:
        "Prikaži moje korisničko ime kada se pretplatim",
      thanksTitle: "Hvala na pretplati!",
      thanksBody: ({ subscribersText }) =>
        `Zajednica sada ima ${subscribersText} pretplatnika!`,
      thanksReturnButton: "Vrati se na prethodnu stranicu",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} je dostigao ${goalText} pretplatnika!`,
      completedGoalFallback: "cilj",
      completedReachedAt: ({ timeText, dateText }) =>
        `Cilj dostignut u ${timeText} dana ${dateText}`,
      completedJustNow: "Cilj je upravo dostignut!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Pogledaj druge ciljeve pretplatnika u r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} se upravo pretplatio!`
          : "Novi član se upravo pretplatio!",
      subscribeSuccessToast: "Hvala na pretplati!",
      subscribeErrorToast: "Pretplata nije uspjela.",
      loginRequired: "Prijavi se za pretplatu.",
      loadError: "Nije moguće učitati podatke Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Dobro došli u r/${subredditName}\n\n${subscribersText} / ${goalText} pretplatnika.\n  Pomozite nam da dostignemo cilj!\n\nPosjetite ovu objavu na Shredditu za interaktivne funkcije.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} je dostigao ${goalText} pretplatnika!\n\nCilj dostignut u \`${completedIso}\`.`,
    },
    ca: {
      languageLabel: "Català",
      intlLocale: "ca-ES",
      defaultPostTitle: ({ subredditName }) =>
        `Benvingut a r/${subredditName}!`,
      welcome: ({ subredditName }) => `Benvingut a r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Subscriu-te a r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Subscrit a r/${subredditName}`,
      shareUsernameLabel:
        "Mostra el meu nom d'usuari quan em subscrigui",
      thanksTitle: "Gràcies per subscriure't!",
      thanksBody: ({ subscribersText }) =>
        `Ara hi ha ${subscribersText} subscriptors a la comunitat!`,
      thanksReturnButton: "Torna a la pàgina anterior",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} ha arribat a ${goalText} subscriptors!`,
      completedGoalFallback: "l'objectiu",
      completedReachedAt: ({ timeText, dateText }) =>
        `Objectiu assolit a les ${timeText} el ${dateText}`,
      completedJustNow: "Objectiu assolit ara mateix!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Vegeu altres objectius de subscriptors a r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} s'acaba de subscriure!`
          : "Un nou membre s'acaba de subscriure!",
      subscribeSuccessToast: "Gràcies per subscriure't!",
      subscribeErrorToast: "La subscripció ha fallat.",
      loginRequired: "Inicia sessió per subscriure't.",
      loadError: "No s'han pogut carregar les dades de Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Benvingut a r/${subredditName}\n\n${subscribersText} / ${goalText} subscriptors.\n  Ajuda'ns a assolir el nostre objectiu!\n\nVisita aquesta publicació a Shreddit per utilitzar les funcions interactives.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} ha arribat a ${goalText} subscriptors!\n\nObjectiu assolit a \`${completedIso}\`.`,
    },
    da: {
      languageLabel: "Dansk",
      intlLocale: "da-DK",
      defaultPostTitle: ({ subredditName }) =>
        `Velkommen til r/${subredditName}!`,
      welcome: ({ subredditName }) => `Velkommen til r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Abonner på r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Abonnerer på r/${subredditName}`,
      shareUsernameLabel: "Vis mit brugernavn, når jeg abonnerer",
      thanksTitle: "Tak for din tilmelding!",
      thanksBody: ({ subscribersText }) =>
        `Der er nu ${subscribersText} abonnenter i fællesskabet!`,
      thanksReturnButton: "Gå tilbage til forrige side",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} har nået ${goalText} abonnenter!`,
      completedGoalFallback: "målet",
      completedReachedAt: ({ timeText, dateText }) =>
        `Målet blev nået kl. ${timeText} den ${dateText}`,
      completedJustNow: "Målet blev netop nået!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Se andre abonnentmål i r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} abonnerede lige!`
          : "Et nyt medlem abonnerede lige!",
      subscribeSuccessToast: "Tak for din tilmelding!",
      subscribeErrorToast: "Abonnementet mislykkedes.",
      loginRequired: "Log ind for at abonnere.",
      loadError: "Kunne ikke indlæse Subscriber Goal-data.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Velkommen til r/${subredditName}\n\n${subscribersText} / ${goalText} abonnenter.\n  Hjælp os med at nå vores mål!\n\nBesøg dette opslag på Shreddit for at bruge interaktive funktioner.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} har nået ${goalText} abonnenter!\n\nMålet blev nået kl. \`${completedIso}\`.`,
    },
    de: {
      languageLabel: "Deutsch",
      intlLocale: "de-DE",
      defaultPostTitle: ({ subredditName }) =>
        `Willkommen bei r/${subredditName}!`,
      welcome: ({ subredditName }) => `Willkommen bei r/${subredditName}`,
      subscribeButton: ({ subredditName }) => `r/${subredditName} abonnieren`,
      subscribedButton: ({ subredditName }) => `r/${subredditName} abonniert`,
      shareUsernameLabel: "Meinen Benutzernamen anzeigen, wenn ich abonniere",
      thanksTitle: "Danke fürs Abonnieren!",
      thanksBody: ({ subscribersText }) =>
        `Die Community hat jetzt ${subscribersText} Abonnenten!`,
      thanksReturnButton: "Zur vorherigen Seite zurückkehren",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} hat ${goalText} Abonnenten erreicht!`,
      completedGoalFallback: "das Ziel",
      completedReachedAt: ({ timeText, dateText }) =>
        `Ziel erreicht um ${timeText} am ${dateText}`,
      completedJustNow: "Ziel gerade erreicht!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Weitere Abonnentenziele in r/${promoSubreddit} ansehen`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} hat gerade abonniert!`
          : "Ein neues Mitglied hat gerade abonniert!",
      subscribeSuccessToast: "Danke fürs Abonnieren!",
      subscribeErrorToast: "Abonnement fehlgeschlagen.",
      loginRequired: "Bitte melde dich an, um zu abonnieren.",
      loadError: "Subscriber Goal-Daten konnten nicht geladen werden.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Willkommen bei r/${subredditName}\n\n${subscribersText} / ${goalText} Abonnenten.\n  Hilf uns, unser Ziel zu erreichen!\n\nBesuche diesen Beitrag auf Shreddit, um interaktive Funktionen zu nutzen.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} hat ${goalText} Abonnenten erreicht!\n\nZiel erreicht um \`${completedIso}\`.`,
    },
    en: {
      languageLabel: "English",
      intlLocale: "en-US",
      defaultPostTitle: ({ subredditName }) => `Welcome to r/${subredditName}!`,
      welcome: ({ subredditName }) => `Welcome to r/${subredditName}`,
      subscribeButton: ({ subredditName }) => `Subscribe to r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Subscribed to r/${subredditName}`,
      shareUsernameLabel: "Show my username when I subscribe",
      thanksTitle: "Thanks for Subscribing!",
      thanksBody: ({ subscribersText }) =>
        `There are now ${subscribersText} subscribers in the community!`,
      thanksReturnButton: "Return to Previous Page",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} reached ${goalText} subscribers!`,
      completedGoalFallback: "the goal",
      completedReachedAt: ({ timeText, dateText }) =>
        `Goal reached at ${timeText} on ${dateText}`,
      completedJustNow: "Goal reached just now!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `View other subscriber goals in r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} just subscribed!`
          : "New member just subscribed!",
      subscribeSuccessToast: "Thanks for subscribing!",
      subscribeErrorToast: "Subscription failed.",
      loginRequired: "Please log in to subscribe.",
      loadError: "Unable to load Subscriber Goal data.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Welcome to r/${subredditName}\n\n${subscribersText} / ${goalText} subscribers.\n  Help us reach our goal!\n\nVisit this post on Shreddit to enjoy interactive features.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} reached ${goalText} subscribers!\n\nGoal reached at \`${completedIso}\`.`,
    },
    es: {
      languageLabel: "Español",
      intlLocale: "es-419",
      defaultPostTitle: ({ subredditName }) =>
        `¡Bienvenido a r/${subredditName}!`,
      welcome: ({ subredditName }) => `Bienvenido a r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Suscribirse a r/${subredditName}`,
      subscribedButton: ({ subredditName }) => `Suscrito a r/${subredditName}`,
      shareUsernameLabel: "Mostrar mi nombre de usuario cuando me suscriba",
      thanksTitle: "¡Gracias por suscribirte!",
      thanksBody: ({ subscribersText }) =>
        `¡Ahora hay ${subscribersText} suscriptores en la comunidad!`,
      thanksReturnButton: "Volver a la página anterior",
      completedTitle: ({ subredditName, goalText }) =>
        `¡r/${subredditName} alcanzó ${goalText} suscriptores!`,
      completedGoalFallback: "la meta",
      completedReachedAt: ({ timeText, dateText }) =>
        `Meta alcanzada a las ${timeText} el ${dateText}`,
      completedJustNow: "¡Meta alcanzada justo ahora!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Ver otras metas de suscriptores en r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `¡u/${username} se acaba de suscribir!`
          : "¡Un nuevo miembro se acaba de suscribir!",
      subscribeSuccessToast: "¡Gracias por suscribirte!",
      subscribeErrorToast: "No se pudo completar la suscripción.",
      loginRequired: "Inicia sesión para suscribirte.",
      loadError: "No se pudieron cargar los datos de Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Bienvenido a r/${subredditName}\n\n${subscribersText} / ${goalText} suscriptores.\n  ¡Ayúdanos a alcanzar nuestra meta!\n\nVisita esta publicación en Shreddit para disfrutar las funciones interactivas.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `¡r/${subredditName} alcanzó ${goalText} suscriptores!\n\nMeta alcanzada en \`${completedIso}\`.`,
    },
    et: {
      languageLabel: "Eesti",
      intlLocale: "et-EE",
      defaultPostTitle: ({ subredditName }) =>
        `Tere tulemast r/${subredditName}!`,
      welcome: ({ subredditName }) => `Tere tulemast r/${subredditName}`,
      subscribeButton: ({ subredditName }) => `Telli r/${subredditName}`,
      subscribedButton: ({ subredditName }) => `Tellitud r/${subredditName}`,
      shareUsernameLabel: "Näita minu kasutajanime, kui tellin",
      thanksTitle: "Täname tellimise eest!",
      thanksBody: ({ subscribersText }) =>
        `Kogukonnas on nüüd ${subscribersText} tellijat!`,
      thanksReturnButton: "Tagasi eelmisele lehele",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} jõudis ${goalText} tellijani!`,
      completedGoalFallback: "eesmärk",
      completedReachedAt: ({ timeText, dateText }) =>
        `Eesmärk saavutati kell ${timeText} kuupäeval ${dateText}`,
      completedJustNow: "Eesmärk saavutati just nüüd!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Vaata teisi tellijate eesmärke r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} tellis just!`
          : "Uus liige tellis just!",
      subscribeSuccessToast: "Täname tellimise eest!",
      subscribeErrorToast: "Tellimine ebaõnnestus.",
      loginRequired: "Tellimiseks logi sisse.",
      loadError: "Subscriber Goal-andmeid ei saanud laadida.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Tere tulemast r/${subredditName}\n\n${subscribersText} / ${goalText} tellijat.\n  Aita meil eesmärk saavutada!\n\nInteraktiivsete funktsioonide kasutamiseks külasta seda postitust Shredditis.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} jõudis ${goalText} tellijani!\n\nEesmärk saavutati \`${completedIso}\`.`,
    },
    fr: {
      languageLabel: "Français",
      intlLocale: "fr-FR",
      defaultPostTitle: ({ subredditName }) =>
        `Bienvenue sur r/${subredditName} !`,
      welcome: ({ subredditName }) => `Bienvenue sur r/${subredditName}`,
      subscribeButton: ({ subredditName }) => `S'abonner à r/${subredditName}`,
      subscribedButton: ({ subredditName }) => `Abonné à r/${subredditName}`,
      shareUsernameLabel: "Afficher mon nom d'utilisateur quand je m'abonne",
      thanksTitle: "Merci de vous être abonné !",
      thanksBody: ({ subscribersText }) =>
        `La communauté compte maintenant ${subscribersText} abonnés !`,
      thanksReturnButton: "Retourner à la page précédente",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} a atteint ${goalText} abonnés !`,
      completedGoalFallback: "l'objectif",
      completedReachedAt: ({ timeText, dateText }) =>
        `Objectif atteint à ${timeText} le ${dateText}`,
      completedJustNow: "Objectif atteint à l'instant !",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Voir d'autres objectifs d'abonnés dans r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} vient de s'abonner !`
          : "Un nouveau membre vient de s’abonner !",
      subscribeSuccessToast: "Merci de vous être abonné !",
      subscribeErrorToast: "L'abonnement a échoué.",
      loginRequired: "Veuillez vous connecter pour vous abonner.",
      loadError: "Impossible de charger les données Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Bienvenue sur r/${subredditName}\n\n${subscribersText} / ${goalText} abonnés.\n  Aidez-nous à atteindre notre objectif !\n\nConsultez cette publication sur Shreddit pour profiter des fonctionnalités interactives.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} a atteint ${goalText} abonnés !\n\nObjectif atteint à \`${completedIso}\`.`,
    },
    hr: {
      languageLabel: "Hrvatski",
      intlLocale: "hr-HR",
      defaultPostTitle: ({ subredditName }) =>
        `Dobro došli u r/${subredditName}!`,
      welcome: ({ subredditName }) => `Dobro došli u r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Pretplati se na r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Pretplaćeni ste na r/${subredditName}`,
      shareUsernameLabel:
        "Prikaži moje korisničko ime kada se pretplatim",
      thanksTitle: "Hvala na pretplati!",
      thanksBody: ({ subscribersText }) =>
        `Zajednica sada ima ${subscribersText} pretplatnika!`,
      thanksReturnButton: "Povratak na prethodnu stranicu",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} dosegnuo je ${goalText} pretplatnika!`,
      completedGoalFallback: "cilj",
      completedReachedAt: ({ timeText, dateText }) =>
        `Cilj je dosegnut u ${timeText} dana ${dateText}`,
      completedJustNow: "Cilj je upravo dosegnut!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Pogledajte druge ciljeve pretplatnika u r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} se upravo pretplatio!`
          : "Novi član se upravo pretplatio!",
      subscribeSuccessToast: "Hvala na pretplati!",
      subscribeErrorToast: "Pretplata nije uspjela.",
      loginRequired: "Prijavite se za pretplatu.",
      loadError: "Nije moguće učitati podatke Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Dobro došli u r/${subredditName}\n\n${subscribersText} / ${goalText} pretplatnika.\n  Pomozite nam dosegnuti cilj!\n\nPosjetite ovu objavu na Shredditu za interaktivne značajke.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} dosegnuo je ${goalText} pretplatnika!\n\nCilj je dosegnut u \`${completedIso}\`.`,
    },
    is: {
      languageLabel: "Íslenska",
      intlLocale: "is-IS",
      defaultPostTitle: ({ subredditName }) =>
        `Velkomin í r/${subredditName}!`,
      welcome: ({ subredditName }) => `Velkomin í r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Gerast áskrifandi að r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Áskrifandi að r/${subredditName}`,
      shareUsernameLabel:
        "Sýna notandanafnið mitt þegar ég gerist áskrifandi",
      thanksTitle: "Takk fyrir áskriftina!",
      thanksBody: ({ subscribersText }) =>
        `Nú eru ${subscribersText} áskrifendur í samfélaginu!`,
      thanksReturnButton: "Fara aftur á fyrri síðu",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} náði ${goalText} áskrifendum!`,
      completedGoalFallback: "markmiðið",
      completedReachedAt: ({ timeText, dateText }) =>
        `Markmiði náð kl. ${timeText} þann ${dateText}`,
      completedJustNow: "Markmiðinu var náð rétt í þessu!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Skoða önnur áskrifendamarkmið í r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} gerðist áskrifandi rétt í þessu!`
          : "Nýr meðlimur gerðist áskrifandi rétt í þessu!",
      subscribeSuccessToast: "Takk fyrir áskriftina!",
      subscribeErrorToast: "Áskrift mistókst.",
      loginRequired: "Skráðu þig inn til að gerast áskrifandi.",
      loadError: "Ekki tókst að hlaða Subscriber Goal-gögnum.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Velkomin í r/${subredditName}\n\n${subscribersText} / ${goalText} áskrifendur.\n  Hjálpaðu okkur að ná markmiðinu!\n\nSkoðaðu þessa færslu á Shreddit til að nota gagnvirka eiginleika.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} náði ${goalText} áskrifendum!\n\nMarkmiði náð kl. \`${completedIso}\`.`,
    },
    it: {
      languageLabel: "Italiano",
      intlLocale: "it-IT",
      defaultPostTitle: ({ subredditName }) =>
        `Benvenuto in r/${subredditName}!`,
      welcome: ({ subredditName }) => `Benvenuto in r/${subredditName}`,
      subscribeButton: ({ subredditName }) => `Iscriviti a r/${subredditName}`,
      subscribedButton: ({ subredditName }) => `Iscritto a r/${subredditName}`,
      shareUsernameLabel: "Mostra il mio nome utente quando mi iscrivo",
      thanksTitle: "Grazie per esserti iscritto!",
      thanksBody: ({ subscribersText }) =>
        `Ora ci sono ${subscribersText} iscritti nella community!`,
      thanksReturnButton: "Torna alla pagina precedente",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} ha raggiunto ${goalText} iscritti!`,
      completedGoalFallback: "l'obiettivo",
      completedReachedAt: ({ timeText, dateText }) =>
        `Obiettivo raggiunto alle ${timeText} del ${dateText}`,
      completedJustNow: "Obiettivo appena raggiunto!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Visualizza altri obiettivi iscritti in r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} si è appena iscritto!`
          : "Un nuovo membro si è appena iscritto!",
      subscribeSuccessToast: "Grazie per esserti iscritto!",
      subscribeErrorToast: "Iscrizione non riuscita.",
      loginRequired: "Accedi per iscriverti.",
      loadError: "Impossibile caricare i dati di Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Benvenuto in r/${subredditName}\n\n${subscribersText} / ${goalText} iscritti.\n  Aiutaci a raggiungere il nostro obiettivo!\n\nVisita questo post su Shreddit per usare le funzionalità interattive.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} ha raggiunto ${goalText} iscritti!\n\nObiettivo raggiunto alle \`${completedIso}\`.`,
    },
    lv: {
      languageLabel: "Latviešu",
      intlLocale: "lv-LV",
      defaultPostTitle: ({ subredditName }) =>
        `Laipni lūdzam r/${subredditName}!`,
      welcome: ({ subredditName }) => `Laipni lūdzam r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Abonēt r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Abonēts r/${subredditName}`,
      shareUsernameLabel: "Rādīt manu lietotājvārdu, kad abonēju",
      thanksTitle: "Paldies par abonēšanu!",
      thanksBody: ({ subscribersText }) =>
        `Kopienā tagad ir ${subscribersText} abonenti!`,
      thanksReturnButton: "Atgriezties iepriekšējā lapā",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} sasniedza ${goalText} abonentus!`,
      completedGoalFallback: "mērķis",
      completedReachedAt: ({ timeText, dateText }) =>
        `Mērķis sasniegts plkst. ${timeText}, ${dateText}`,
      completedJustNow: "Mērķis tikko sasniegts!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Skatīt citus abonentu mērķus r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} tikko abonēja!`
          : "Jauns dalībnieks tikko abonēja!",
      subscribeSuccessToast: "Paldies par abonēšanu!",
      subscribeErrorToast: "Abonēšana neizdevās.",
      loginRequired: "Pieraksties, lai abonētu.",
      loadError: "Neizdevās ielādēt Subscriber Goal datus.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Laipni lūdzam r/${subredditName}\n\n${subscribersText} / ${goalText} abonenti.\n  Palīdzi mums sasniegt mērķi!\n\nApmeklē šo ziņu Shreddit, lai izmantotu interaktīvās funkcijas.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} sasniedza ${goalText} abonentus!\n\nMērķis sasniegts \`${completedIso}\`.`,
    },
    lt: {
      languageLabel: "Lietuvių",
      intlLocale: "lt-LT",
      defaultPostTitle: ({ subredditName }) =>
        `Sveiki atvykę į r/${subredditName}!`,
      welcome: ({ subredditName }) => `Sveiki atvykę į r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Prenumeruoti r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Prenumeruojate r/${subredditName}`,
      shareUsernameLabel:
        "Rodyti mano naudotojo vardą, kai prenumeruoju",
      thanksTitle: "Ačiū, kad prenumeruojate!",
      thanksBody: ({ subscribersText }) =>
        `Bendruomenėje dabar yra ${subscribersText} prenumeratorių!`,
      thanksReturnButton: "Grįžti į ankstesnį puslapį",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} pasiekė ${goalText} prenumeratorių!`,
      completedGoalFallback: "tikslas",
      completedReachedAt: ({ timeText, dateText }) =>
        `Tikslas pasiektas ${timeText}, ${dateText}`,
      completedJustNow: "Tikslas ką tik pasiektas!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Peržiūrėti kitus prenumeratorių tikslus r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} ką tik užsiprenumeravo!`
          : "Naujas narys ką tik užsiprenumeravo!",
      subscribeSuccessToast: "Ačiū, kad prenumeruojate!",
      subscribeErrorToast: "Prenumerata nepavyko.",
      loginRequired: "Prisijunkite, kad prenumeruotumėte.",
      loadError: "Nepavyko įkelti Subscriber Goal duomenų.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Sveiki atvykę į r/${subredditName}\n\n${subscribersText} / ${goalText} prenumeratorių.\n  Padėkite mums pasiekti tikslą!\n\nApsilankykite šiame įraše Shreddit, kad naudotumėte interaktyvias funkcijas.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} pasiekė ${goalText} prenumeratorių!\n\nTikslas pasiektas \`${completedIso}\`.`,
    },
    hu: {
      languageLabel: "Magyar",
      intlLocale: "hu-HU",
      defaultPostTitle: ({ subredditName }) =>
        `Üdvözlünk az r/${subredditName} közösségben!`,
      welcome: ({ subredditName }) =>
        `Üdvözlünk az r/${subredditName} közösségben`,
      subscribeButton: ({ subredditName }) =>
        `Feliratkozás erre: r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Feliratkozva erre: r/${subredditName}`,
      shareUsernameLabel:
        "Mutassa a felhasználónevemet, amikor feliratkozom",
      thanksTitle: "Köszönjük a feliratkozást!",
      thanksBody: ({ subscribersText }) =>
        `A közösségnek most ${subscribersText} feliratkozója van!`,
      thanksReturnButton: "Vissza az előző oldalra",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} elérte a(z) ${goalText} feliratkozót!`,
      completedGoalFallback: "a cél",
      completedReachedAt: ({ timeText, dateText }) =>
        `A cél elérve ekkor: ${dateText}, ${timeText}`,
      completedJustNow: "A cél éppen most teljesült!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Más feliratkozói célok megtekintése itt: r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} éppen most feliratkozott!`
          : "Egy új tag éppen most feliratkozott!",
      subscribeSuccessToast: "Köszönjük a feliratkozást!",
      subscribeErrorToast: "A feliratkozás sikertelen.",
      loginRequired: "Jelentkezz be a feliratkozáshoz.",
      loadError: "Nem sikerült betölteni a Subscriber Goal adatait.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Üdvözlünk az r/${subredditName} közösségben\n\n${subscribersText} / ${goalText} feliratkozó.\n  Segíts elérni a célunkat!\n\nLátogasd meg ezt a bejegyzést Shredditen az interaktív funkciók használatához.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} elérte a(z) ${goalText} feliratkozót!\n\nA cél elérve: \`${completedIso}\`.`,
    },
    nl: {
      languageLabel: "Nederlands",
      intlLocale: "nl-NL",
      defaultPostTitle: ({ subredditName }) => `Welkom bij r/${subredditName}!`,
      welcome: ({ subredditName }) => `Welkom bij r/${subredditName}`,
      subscribeButton: ({ subredditName }) => `Abonneer op r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Geabonneerd op r/${subredditName}`,
      shareUsernameLabel: "Mijn gebruikersnaam tonen wanneer ik me abonneer",
      thanksTitle: "Bedankt voor je abonnement!",
      thanksBody: ({ subscribersText }) =>
        `Er zijn nu ${subscribersText} abonnees in de community!`,
      thanksReturnButton: "Terug naar vorige pagina",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} heeft ${goalText} abonnees bereikt!`,
      completedGoalFallback: "het doel",
      completedReachedAt: ({ timeText, dateText }) =>
        `Doel bereikt om ${timeText} op ${dateText}`,
      completedJustNow: "Doel zojuist bereikt!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Bekijk andere abonneedoelen in r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} heeft zich zojuist geabonneerd!`
          : "Een nieuw lid heeft zich zojuist geabonneerd!",
      subscribeSuccessToast: "Bedankt voor je abonnement!",
      subscribeErrorToast: "Abonneren mislukt.",
      loginRequired: "Log in om je te abonneren.",
      loadError: "Kan Subscriber Goal-gegevens niet laden.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Welkom bij r/${subredditName}\n\n${subscribersText} / ${goalText} abonnees.\n  Help ons ons doel te bereiken!\n\nBezoek dit bericht op Shreddit om interactieve functies te gebruiken.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} heeft ${goalText} abonnees bereikt!\n\nDoel bereikt om \`${completedIso}\`.`,
    },
    nb: {
      languageLabel: "Norsk Bokmål",
      intlLocale: "nb-NO",
      defaultPostTitle: ({ subredditName }) =>
        `Velkommen til r/${subredditName}!`,
      welcome: ({ subredditName }) => `Velkommen til r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Abonner på r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Abonnerer på r/${subredditName}`,
      shareUsernameLabel: "Vis brukernavnet mitt når jeg abonnerer",
      thanksTitle: "Takk for at du abonnerer!",
      thanksBody: ({ subscribersText }) =>
        `Det er nå ${subscribersText} abonnenter i fellesskapet!`,
      thanksReturnButton: "Gå tilbake til forrige side",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} nådde ${goalText} abonnenter!`,
      completedGoalFallback: "målet",
      completedReachedAt: ({ timeText, dateText }) =>
        `Målet ble nådd kl. ${timeText} den ${dateText}`,
      completedJustNow: "Målet ble nettopp nådd!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Se andre abonnentmål i r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} abonnerte nettopp!`
          : "Et nytt medlem abonnerte nettopp!",
      subscribeSuccessToast: "Takk for at du abonnerer!",
      subscribeErrorToast: "Abonnementet mislyktes.",
      loginRequired: "Logg inn for å abonnere.",
      loadError: "Kunne ikke laste Subscriber Goal-data.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Velkommen til r/${subredditName}\n\n${subscribersText} / ${goalText} abonnenter.\n  Hjelp oss å nå målet vårt!\n\nBesøk dette innlegget på Shreddit for å bruke interaktive funksjoner.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} nådde ${goalText} abonnenter!\n\nMålet ble nådd kl. \`${completedIso}\`.`,
    },
    pl: {
      languageLabel: "Polski",
      intlLocale: "pl-PL",
      defaultPostTitle: ({ subredditName }) =>
        `Witamy w r/${subredditName}!`,
      welcome: ({ subredditName }) => `Witamy w r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Subskrybuj r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Subskrybujesz r/${subredditName}`,
      shareUsernameLabel:
        "Pokaż moją nazwę użytkownika, gdy subskrybuję",
      thanksTitle: "Dziękujemy za subskrypcję!",
      thanksBody: ({ subscribersText }) =>
        `Społeczność ma teraz ${subscribersText} subskrybentów!`,
      thanksReturnButton: "Wróć do poprzedniej strony",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} osiągnęło ${goalText} subskrybentów!`,
      completedGoalFallback: "cel",
      completedReachedAt: ({ timeText, dateText }) =>
        `Cel osiągnięty o ${timeText} dnia ${dateText}`,
      completedJustNow: "Cel właśnie osiągnięty!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Zobacz inne cele subskrybentów w r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} właśnie zasubskrybował!`
          : "Nowy członek właśnie zasubskrybował!",
      subscribeSuccessToast: "Dziękujemy za subskrypcję!",
      subscribeErrorToast: "Subskrypcja nie powiodła się.",
      loginRequired: "Zaloguj się, aby subskrybować.",
      loadError: "Nie udało się załadować danych Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Witamy w r/${subredditName}\n\n${subscribersText} / ${goalText} subskrybentów.\n  Pomóż nam osiągnąć cel!\n\nOdwiedź ten post w Shreddit, aby używać funkcji interaktywnych.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} osiągnęło ${goalText} subskrybentów!\n\nCel osiągnięty o \`${completedIso}\`.`,
    },
    pt: {
      languageLabel: "Português",
      intlLocale: "pt",
      defaultPostTitle: ({ subredditName }) =>
        `Bem-vindo ao r/${subredditName}!`,
      welcome: ({ subredditName }) => `Bem-vindo ao r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Inscrever-se em r/${subredditName}`,
      subscribedButton: ({ subredditName }) => `Inscrito em r/${subredditName}`,
      shareUsernameLabel: "Mostrar meu nome de usuário quando eu me inscrever",
      thanksTitle: "Obrigado por se inscrever!",
      thanksBody: ({ subscribersText }) =>
        `Agora há ${subscribersText} inscritos na comunidade!`,
      thanksReturnButton: "Voltar para a página anterior",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} alcançou ${goalText} inscritos!`,
      completedGoalFallback: "a meta",
      completedReachedAt: ({ timeText, dateText }) =>
        `Meta alcançada às ${timeText} em ${dateText}`,
      completedJustNow: "Meta alcançada agora mesmo!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Ver outras metas de inscritos em r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} acabou de se inscrever!`
          : "Um novo membro acabou de se inscrever!",
      subscribeSuccessToast: "Obrigado por se inscrever!",
      subscribeErrorToast: "Falha na inscrição.",
      loginRequired: "Faça login para se inscrever.",
      loadError: "Não foi possível carregar os dados do Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Bem-vindo ao r/${subredditName}\n\n${subscribersText} / ${goalText} inscritos.\n  Ajude-nos a alcançar nossa meta!\n\nVisite esta publicação no Shreddit para aproveitar os recursos interativos.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} alcançou ${goalText} inscritos!\n\nMeta alcançada em \`${completedIso}\`.`,
    },
    ro: {
      languageLabel: "Română",
      intlLocale: "ro-RO",
      defaultPostTitle: ({ subredditName }) =>
        `Bun venit pe r/${subredditName}!`,
      welcome: ({ subredditName }) => `Bun venit pe r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Abonează-te la r/${subredditName}`,
      subscribedButton: ({ subredditName }) => `Abonat la r/${subredditName}`,
      shareUsernameLabel: "Afișează-mi numele de utilizator când mă abonez",
      thanksTitle: "Mulțumim pentru abonare!",
      thanksBody: ({ subscribersText }) =>
        `Acum sunt ${subscribersText} abonați în comunitate!`,
      thanksReturnButton: "Înapoi la pagina anterioară",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} a atins ${goalText} abonați!`,
      completedGoalFallback: "obiectivul",
      completedReachedAt: ({ timeText, dateText }) =>
        `Obiectiv atins la ${timeText} pe ${dateText}`,
      completedJustNow: "Obiectiv atins chiar acum!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Vezi alte obiective de abonați în r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} tocmai s-a abonat!`
          : "Un membru nou tocmai s-a abonat!",
      subscribeSuccessToast: "Mulțumim pentru abonare!",
      subscribeErrorToast: "Abonarea a eșuat.",
      loginRequired: "Autentifică-te pentru a te abona.",
      loadError: "Nu s-au putut încărca datele Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Bun venit pe r/${subredditName}\n\n${subscribersText} / ${goalText} abonați.\n  Ajută-ne să ne atingem obiectivul!\n\nVizitează această postare pe Shreddit pentru a folosi funcțiile interactive.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} a atins ${goalText} abonați!\n\nObiectiv atins la \`${completedIso}\`.`,
    },
    sq: {
      languageLabel: "Shqip",
      intlLocale: "sq-AL",
      defaultPostTitle: ({ subredditName }) =>
        `Mirë se vini në r/${subredditName}!`,
      welcome: ({ subredditName }) => `Mirë se vini në r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Abonohu te r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `I abonuar te r/${subredditName}`,
      shareUsernameLabel:
        "Shfaq emrin tim të përdoruesit kur abonohem",
      thanksTitle: "Faleminderit që u abonove!",
      thanksBody: ({ subscribersText }) =>
        `Tani ka ${subscribersText} abonentë në komunitet!`,
      thanksReturnButton: "Kthehu te faqja e mëparshme",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} arriti ${goalText} abonentë!`,
      completedGoalFallback: "qëllimi",
      completedReachedAt: ({ timeText, dateText }) =>
        `Qëllimi u arrit në ${timeText} më ${dateText}`,
      completedJustNow: "Qëllimi sapo u arrit!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Shiko qëllime të tjera abonentësh në r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} sapo u abonua!`
          : "Një anëtar i ri sapo u abonua!",
      subscribeSuccessToast: "Faleminderit që u abonove!",
      subscribeErrorToast: "Abonimi dështoi.",
      loginRequired: "Identifikohu për t'u abonuar.",
      loadError: "Nuk mund të ngarkohen të dhënat e Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Mirë se vini në r/${subredditName}\n\n${subscribersText} / ${goalText} abonentë.\n  Na ndihmo të arrijmë qëllimin!\n\nVizito këtë postim në Shreddit për të përdorur funksionet interaktive.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} arriti ${goalText} abonentë!\n\nQëllimi u arrit në \`${completedIso}\`.`,
    },
    sk: {
      languageLabel: "Slovenčina",
      intlLocale: "sk-SK",
      defaultPostTitle: ({ subredditName }) =>
        `Vitajte v r/${subredditName}!`,
      welcome: ({ subredditName }) => `Vitajte v r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Prihlásiť sa na odber r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Prihlásené na odber r/${subredditName}`,
      shareUsernameLabel:
        "Zobraziť moje používateľské meno, keď sa prihlásim na odber",
      thanksTitle: "Ďakujeme za prihlásenie na odber!",
      thanksBody: ({ subscribersText }) =>
        `Komunita má teraz ${subscribersText} odberateľov!`,
      thanksReturnButton: "Vrátiť sa na predchádzajúcu stránku",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} dosiahol ${goalText} odberateľov!`,
      completedGoalFallback: "cieľ",
      completedReachedAt: ({ timeText, dateText }) =>
        `Cieľ dosiahnutý o ${timeText} dňa ${dateText}`,
      completedJustNow: "Cieľ bol práve dosiahnutý!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Pozrieť ďalšie ciele odberateľov v r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} sa práve prihlásil na odber!`
          : "Nový člen sa práve prihlásil na odber!",
      subscribeSuccessToast: "Ďakujeme za prihlásenie na odber!",
      subscribeErrorToast: "Prihlásenie na odber zlyhalo.",
      loginRequired: "Prihláste sa, aby ste sa mohli prihlásiť na odber.",
      loadError: "Nepodarilo sa načítať údaje Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Vitajte v r/${subredditName}\n\n${subscribersText} / ${goalText} odberateľov.\n  Pomôžte nám dosiahnuť cieľ!\n\nNavštívte tento príspevok na Shreddite a použite interaktívne funkcie.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} dosiahol ${goalText} odberateľov!\n\nCieľ dosiahnutý o \`${completedIso}\`.`,
    },
    sl: {
      languageLabel: "Slovenščina",
      intlLocale: "sl-SI",
      defaultPostTitle: ({ subredditName }) =>
        `Dobrodošli v r/${subredditName}!`,
      welcome: ({ subredditName }) => `Dobrodošli v r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Naroči se na r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Naročen na r/${subredditName}`,
      shareUsernameLabel:
        "Prikaži moje uporabniško ime, ko se naročim",
      thanksTitle: "Hvala za naročnino!",
      thanksBody: ({ subscribersText }) =>
        `Skupnost ima zdaj ${subscribersText} naročnikov!`,
      thanksReturnButton: "Nazaj na prejšnjo stran",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} je dosegel ${goalText} naročnikov!`,
      completedGoalFallback: "cilj",
      completedReachedAt: ({ timeText, dateText }) =>
        `Cilj dosežen ob ${timeText} dne ${dateText}`,
      completedJustNow: "Cilj je bil pravkar dosežen!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Oglej si druge cilje naročnikov v r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} se je pravkar naročil!`
          : "Nov član se je pravkar naročil!",
      subscribeSuccessToast: "Hvala za naročnino!",
      subscribeErrorToast: "Naročnina ni uspela.",
      loginRequired: "Prijavi se za naročnino.",
      loadError: "Podatkov Subscriber Goal ni bilo mogoče naložiti.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Dobrodošli v r/${subredditName}\n\n${subscribersText} / ${goalText} naročnikov.\n  Pomagaj nam doseči cilj!\n\nObišči to objavo na Shredditu za uporabo interaktivnih funkcij.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} je dosegel ${goalText} naročnikov!\n\nCilj dosežen ob \`${completedIso}\`.`,
    },
    fi: {
      languageLabel: "Suomi",
      intlLocale: "fi-FI",
      defaultPostTitle: ({ subredditName }) =>
        `Tervetuloa r/${subredditName}!`,
      welcome: ({ subredditName }) => `Tervetuloa r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Tilaa r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Tilattu r/${subredditName}`,
      shareUsernameLabel: "Näytä käyttäjänimeni, kun tilaan",
      thanksTitle: "Kiitos tilauksesta!",
      thanksBody: ({ subscribersText }) =>
        `Yhteisössä on nyt ${subscribersText} tilaajaa!`,
      thanksReturnButton: "Palaa edelliselle sivulle",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} saavutti ${goalText} tilaajaa!`,
      completedGoalFallback: "tavoite",
      completedReachedAt: ({ timeText, dateText }) =>
        `Tavoite saavutettiin klo ${timeText} ${dateText}`,
      completedJustNow: "Tavoite saavutettiin juuri nyt!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Katso muita tilaajatavoitteita r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} tilasi juuri!`
          : "Uusi jäsen tilasi juuri!",
      subscribeSuccessToast: "Kiitos tilauksesta!",
      subscribeErrorToast: "Tilaus epäonnistui.",
      loginRequired: "Kirjaudu sisään tilataksesi.",
      loadError: "Subscriber Goal -tietoja ei voitu ladata.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Tervetuloa r/${subredditName}\n\n${subscribersText} / ${goalText} tilaajaa.\n  Auta meitä saavuttamaan tavoitteemme!\n\nKäy tässä julkaisussa Shredditissä käyttääksesi interaktiivisia toimintoja.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} saavutti ${goalText} tilaajaa!\n\nTavoite saavutettiin \`${completedIso}\`.`,
    },
    sv: {
      languageLabel: "Svenska",
      intlLocale: "sv-SE",
      defaultPostTitle: ({ subredditName }) =>
        `Välkommen till r/${subredditName}!`,
      welcome: ({ subredditName }) => `Välkommen till r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Prenumerera på r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Prenumererar på r/${subredditName}`,
      shareUsernameLabel:
        "Visa mitt användarnamn när jag prenumererar",
      thanksTitle: "Tack för att du prenumererar!",
      thanksBody: ({ subscribersText }) =>
        `Det finns nu ${subscribersText} prenumeranter i communityn!`,
      thanksReturnButton: "Gå tillbaka till föregående sida",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} nådde ${goalText} prenumeranter!`,
      completedGoalFallback: "målet",
      completedReachedAt: ({ timeText, dateText }) =>
        `Målet nåddes kl. ${timeText} den ${dateText}`,
      completedJustNow: "Målet nåddes precis!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Visa andra prenumerantmål i r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} prenumererade precis!`
          : "En ny medlem prenumererade precis!",
      subscribeSuccessToast: "Tack för att du prenumererar!",
      subscribeErrorToast: "Prenumerationen misslyckades.",
      loginRequired: "Logga in för att prenumerera.",
      loadError: "Det gick inte att läsa in Subscriber Goal-data.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Välkommen till r/${subredditName}\n\n${subscribersText} / ${goalText} prenumeranter.\n  Hjälp oss att nå vårt mål!\n\nBesök det här inlägget på Shreddit för att använda interaktiva funktioner.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} nådde ${goalText} prenumeranter!\n\nMålet nåddes kl. \`${completedIso}\`.`,
    },
    tl: {
      languageLabel: "Tagalog",
      intlLocale: "fil-PH",
      defaultPostTitle: ({ subredditName }) =>
        `Maligayang pagdating sa r/${subredditName}!`,
      welcome: ({ subredditName }) =>
        `Maligayang pagdating sa r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Mag-subscribe sa r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `Naka-subscribe sa r/${subredditName}`,
      shareUsernameLabel:
        "Ipakita ang username ko kapag nag-subscribe ako",
      thanksTitle: "Salamat sa pag-subscribe!",
      thanksBody: ({ subscribersText }) =>
        `Mayroon na ngayong ${subscribersText} subscriber sa komunidad!`,
      thanksReturnButton: "Bumalik sa nakaraang pahina",
      completedTitle: ({ subredditName, goalText }) =>
        `Naabot ng r/${subredditName} ang ${goalText} subscriber!`,
      completedGoalFallback: "ang layunin",
      completedReachedAt: ({ timeText, dateText }) =>
        `Naabot ang layunin nang ${timeText} noong ${dateText}`,
      completedJustNow: "Naabot lang ngayon ang layunin!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Tingnan ang ibang mga subscriber goal sa r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `Nag-subscribe lang si u/${username}!`
          : "May bagong miyembro na nag-subscribe!",
      subscribeSuccessToast: "Salamat sa pag-subscribe!",
      subscribeErrorToast: "Nabigo ang subscription.",
      loginRequired: "Mag-log in para mag-subscribe.",
      loadError: "Hindi ma-load ang data ng Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Maligayang pagdating sa r/${subredditName}\n\n${subscribersText} / ${goalText} subscriber.\n  Tulungan kaming maabot ang aming layunin!\n\nBisitahin ang post na ito sa Shreddit para magamit ang mga interactive na feature.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `Naabot ng r/${subredditName} ang ${goalText} subscriber!\n\nNaabot ang layunin noong \`${completedIso}\`.`,
    },
    tr: {
      languageLabel: "Türkçe",
      intlLocale: "tr-TR",
      defaultPostTitle: ({ subredditName }) =>
        `r/${subredditName} topluluğuna hoş geldiniz!`,
      welcome: ({ subredditName }) =>
        `r/${subredditName} topluluğuna hoş geldiniz`,
      subscribeButton: ({ subredditName }) =>
        `r/${subredditName} topluluğuna abone ol`,
      subscribedButton: ({ subredditName }) =>
        `r/${subredditName} topluluğuna abone oldun`,
      shareUsernameLabel:
        "Abone olduğumda kullanıcı adımı göster",
      thanksTitle: "Abone olduğunuz için teşekkürler!",
      thanksBody: ({ subscribersText }) =>
        `Toplulukta artık ${subscribersText} abone var!`,
      thanksReturnButton: "Önceki sayfaya dön",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} ${goalText} aboneye ulaştı!`,
      completedGoalFallback: "hedef",
      completedReachedAt: ({ timeText, dateText }) =>
        `Hedef ${dateText} tarihinde saat ${timeText} itibarıyla tamamlandı`,
      completedJustNow: "Hedef az önce tamamlandı!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `r/${promoSubreddit} içindeki diğer abone hedeflerini görüntüle`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} az önce abone oldu!`
          : "Yeni bir üye az önce abone oldu!",
      subscribeSuccessToast: "Abone olduğunuz için teşekkürler!",
      subscribeErrorToast: "Abonelik başarısız oldu.",
      loginRequired: "Abone olmak için giriş yapın.",
      loadError: "Subscriber Goal verileri yüklenemedi.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `r/${subredditName} topluluğuna hoş geldiniz\n\n${subscribersText} / ${goalText} abone.\n  Hedefimize ulaşmamıza yardım edin!\n\nEtkileşimli özellikleri kullanmak için bu gönderiyi Shreddit'te ziyaret edin.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} ${goalText} aboneye ulaştı!\n\nHedef \`${completedIso}\` tarihinde tamamlandı.`,
    },
    yo: {
      languageLabel: "Yorùbá",
      intlLocale: "yo-NG",
      defaultPostTitle: ({ subredditName }) =>
        `Ẹ káàbọ̀ sí r/${subredditName}!`,
      welcome: ({ subredditName }) => `Ẹ káàbọ̀ sí r/${subredditName}`,
      subscribeButton: ({ subredditName }) =>
        `Ṣe alabapin sí r/${subredditName}`,
      subscribedButton: ({ subredditName }) =>
        `O ti ṣe alabapin sí r/${subredditName}`,
      shareUsernameLabel:
        "Fi orúkọ olumulo mi hàn nígbà tí mo bá ṣe alabapin",
      thanksTitle: "Ẹ ṣé fún alabapin!",
      thanksBody: ({ subscribersText }) =>
        `Àwọn alabapin ${subscribersText} wà ní àwùjọ báyìí!`,
      thanksReturnButton: "Padà sí ojúewé ṣáájú",
      completedTitle: ({ subredditName, goalText }) =>
        `r/${subredditName} ti dé ${goalText} alabapin!`,
      completedGoalFallback: "ìfojúsùn náà",
      completedReachedAt: ({ timeText, dateText }) =>
        `Ìfojúsùn dé ní ${timeText} ní ${dateText}`,
      completedJustNow: "Ìfojúsùn ṣẹ̀ṣẹ̀ dé!",
      promoAriaLabel: ({ promoSubreddit }) =>
        `Wo àwọn ìfojúsùn alabapin mìíràn ní r/${promoSubreddit}`,
      subscriberNotice: ({ username }) =>
        username
          ? `u/${username} ṣẹ̀ṣẹ̀ ṣe alabapin!`
          : "Ọmọ ẹgbẹ́ tuntun ṣẹ̀ṣẹ̀ ṣe alabapin!",
      subscribeSuccessToast: "Ẹ ṣé fún alabapin!",
      subscribeErrorToast: "Alabapin kò ṣiṣẹ́.",
      loginRequired: "Jọwọ wọlé láti ṣe alabapin.",
      loadError: "Kò le ṣàkójọpọ̀ data Subscriber Goal.",
      fallbackActive: ({ subredditName, subscribersText, goalText }) =>
        `Ẹ káàbọ̀ sí r/${subredditName}\n\n${subscribersText} / ${goalText} alabapin.\n  Ẹ ràn wá lọ́wọ́ láti dé ìfojúsùn wa!\n\nṢàbẹ̀wò sí ìfìwéránṣẹ́ yìí lórí Shreddit láti lo àwọn iṣẹ́ ìbánisọ̀rọ̀.`,
      fallbackCompleted: ({ subredditName, goalText, completedIso }) =>
        `r/${subredditName} ti dé ${goalText} alabapin!\n\nÌfojúsùn dé ní \`${completedIso}\`.`,
    },
  };

export function resolveSubGoalLanguage(value: unknown): SubGoalLanguage {
  return typeof value === "string" &&
    subGoalLanguages.includes(value as SubGoalLanguage)
    ? (value as SubGoalLanguage)
    : defaultSubGoalLanguage;
}

export function getSubGoalPostMessages(language: unknown): SubGoalPostMessages {
  return subGoalPostMessages[resolveSubGoalLanguage(language)];
}
