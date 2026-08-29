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
    return null;
  }
}
