import {
  isSubGoalColorTheme,
  type SubGoalColorTheme,
} from "./subGoalColorTheme";
import {
  getAfterSubscribePresetMessages,
  type SubGoalLanguage,
} from "./subGoalPostI18n";

export const afterSubscribeActionTypes = ["disabled", "link"] as const;
export const dynamicAfterSubscribeActionTypes = [
  "top-post-day",
  "newest-post",
] as const;
export type DynamicAfterSubscribeActionType =
  (typeof dynamicAfterSubscribeActionTypes)[number];
export type AfterSubscribeActionType =
  | (typeof afterSubscribeActionTypes)[number]
  | (typeof dynamicAfterSubscribeActionTypes)[number];

export const afterSubscribePresetTypes = [
  "web-link",
  "discord",
  "top-post-day",
  "wiki",
  "create-post",
  "share-picture",
  "newest-post",
] as const;
export type AfterSubscribePreset = (typeof afterSubscribePresetTypes)[number];

export const defaultAfterSubscribeColorTheme: SubGoalColorTheme = "blue";

export function getDefaultAfterSubscribePreset(
  _subredditType: unknown,
): AfterSubscribePreset {
  return "top-post-day";
}

export type AfterSubscribeAction =
  | { type: "disabled" }
  | {
      type: "link";
      buttonText: string;
      url: string;
      colorTheme: SubGoalColorTheme;
    }
  | {
      type: (typeof dynamicAfterSubscribeActionTypes)[number];
      buttonText: string;
      colorTheme: SubGoalColorTheme;
    };

export type AutomaticAfterSubscribeAction = Extract<
  AfterSubscribeAction,
  { type: DynamicAfterSubscribeActionType }
>;

export function getAutomaticAfterSubscribeAction(
  configuredAction: AfterSubscribeAction,
  language: SubGoalLanguage,
): AutomaticAfterSubscribeAction | null {
  if (configuredAction.type === "disabled") return null;
  const type =
    configuredAction.type === "top-post-day" ? "newest-post" : "top-post-day";
  const preferredColor = type === "top-post-day" ? "blue" : "green";
  const alternateColor = preferredColor === "blue" ? "green" : "blue";
  const messages = getAfterSubscribePresetMessages(language);
  return {
    type,
    buttonText:
      type === "top-post-day"
        ? messages.viewTopPostToday
        : messages.viewMostRecentPostToday,
    colorTheme:
      configuredAction.colorTheme === preferredColor
        ? alternateColor
        : preferredColor,
  };
}

export const defaultAfterSubscribeAction: AfterSubscribeAction = {
  type: "disabled",
};

export type ResolveAfterSubscribeActionResult = {
  action: AfterSubscribeAction;
  invalidConfiguration: boolean;
};

export function createTopPostFallbackAction({
  language,
  colorTheme,
}: {
  language: SubGoalLanguage;
  colorTheme: SubGoalColorTheme;
}): {
  type: "top-post-day";
  buttonText: string;
  colorTheme: SubGoalColorTheme;
} {
  return {
    type: "top-post-day",
    buttonText: getAfterSubscribePresetMessages(language).viewTopPostToday,
    colorTheme,
  };
}

export function createDefaultAfterSubscribeAction({
  language,
}: {
  language: SubGoalLanguage;
  subredditName: string;
  subredditType: unknown;
}): AfterSubscribeAction {
  return createTopPostFallbackAction({
    language,
    colorTheme: defaultAfterSubscribeColorTheme,
  });
}

export function createDefaultCreatePostAction({
  language,
  subredditName,
}: {
  language: SubGoalLanguage;
  subredditName: string;
}): Extract<AfterSubscribeAction, { type: "link" }> {
  return {
    type: "link",
    buttonText: getAfterSubscribePresetMessages(language).createNewPost,
    url: `https://www.reddit.com/r/${subredditName}/submit/`,
    colorTheme: defaultAfterSubscribeColorTheme,
  };
}

export function resolveAfterSubscribeAction({
  type,
  buttonText,
  url,
  colorTheme,
  fallbackColorTheme,
  invalidConfigurationFallback,
}: {
  type: unknown;
  buttonText: unknown;
  url: unknown;
  colorTheme: unknown;
  fallbackColorTheme: SubGoalColorTheme;
  invalidConfigurationFallback?: AfterSubscribeAction;
}): ResolveAfterSubscribeActionResult {
  const isDynamicType = dynamicAfterSubscribeActionTypes.includes(
    type as (typeof dynamicAfterSubscribeActionTypes)[number],
  );
  if (type !== "link" && !isDynamicType) {
    return {
      action: defaultAfterSubscribeAction,
      invalidConfiguration: false,
    };
  }

  const normalizedButtonText =
    typeof buttonText === "string" ? buttonText.trim() : "";
  const buttonTextLength = Array.from(normalizedButtonText).length;
  const normalizedUrl = type === "link" ? normalizeSecureUrl(url) : null;
  if (
    buttonTextLength < 5 ||
    buttonTextLength > 50 ||
    (!isDynamicType && normalizedUrl === null)
  ) {
    return {
      action: invalidConfigurationFallback ?? defaultAfterSubscribeAction,
      invalidConfiguration: true,
    };
  }

  const resolvedColorTheme = isSubGoalColorTheme(colorTheme)
    ? colorTheme
    : fallbackColorTheme;
  if (isDynamicType) {
    return {
      action: {
        type: type as (typeof dynamicAfterSubscribeActionTypes)[number],
        buttonText: normalizedButtonText,
        colorTheme: resolvedColorTheme,
      },
      invalidConfiguration: false,
    };
  }

  return {
    action: {
      type: "link",
      buttonText: normalizedButtonText,
      url: normalizedUrl as string,
      colorTheme: resolvedColorTheme,
    },
    invalidConfiguration: false,
  };
}

export function isAfterSubscribePreset(
  value: unknown,
): value is AfterSubscribePreset {
  return afterSubscribePresetTypes.includes(value as AfterSubscribePreset);
}

export function resolveAfterSubscribePreset(
  value: unknown,
  action: AfterSubscribeAction,
): AfterSubscribePreset | null {
  if (isAfterSubscribePreset(value)) {
    return value;
  }
  if (action.type === "top-post-day" || action.type === "newest-post") {
    return action.type;
  }
  if (action.type === "disabled") {
    return null;
  }
  if (action.type !== "link") {
    return null;
  }
  try {
    const url = new URL(action.url);
    if (/^\/r\/[^/]+\/submit\/?$/i.test(url.pathname)) {
      return "create-post";
    }
  } catch {
    // diagnostic-allow-silent: malformed legacy URLs intentionally use fallback behavior.
    // Resolved link actions already contain a valid URL. Fall through safely
    // for malformed legacy data.
  }
  return "web-link";
}

function normalizeSecureUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || !parsed.hostname) {
      return null;
    }
    return parsed.toString();
  } catch {
    // diagnostic-allow-silent: URL parsing is an expected validation probe.
    return null;
  }
}
