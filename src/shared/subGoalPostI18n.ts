export const subGoalLanguages = [
  "de",
  "en",
  "es",
  "fr",
  "it",
  "nl",
  "pt",
  "ro",
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
        `Ahora hay ${subscribersText} suscriptores en la comunidad!`,
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
