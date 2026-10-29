import { IntlMessageFormat } from "intl-messageformat";
import catalogData from "./messages.json";

export type AppLanguage = keyof typeof catalogData.locales;
export type MessageKey = keyof typeof catalogData.definitions;
export type MessageValues = Readonly<Record<string, string | number>>;

type MessagePolicy = "required" | "fallback";
type MessageDefinition = {
  description: string;
  policy: MessagePolicy;
  placeholders: Record<string, string>;
  protectedTokens: string[];
};
type CatalogLocale = {
  label: string;
  locale: string;
  messages: Partial<Record<MessageKey, string>>;
};

const catalog = catalogData as {
  schemaVersion: number;
  defaultLanguage: AppLanguage;
  languageOrder: AppLanguage[];
  definitions: Record<MessageKey, MessageDefinition>;
  locales: Record<AppLanguage, CatalogLocale>;
};

const formatterCache = new Map<string, IntlMessageFormat>();
export const appLanguages = Object.freeze([...catalog.languageOrder]);
export const defaultAppLanguage = catalog.defaultLanguage;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const languageAliases: Readonly<Record<string, AppLanguage>> = {
  "pt-br": "pt",
  pt_br: "pt",
};

export function resolveAppLanguage(value: unknown): AppLanguage {
  if (typeof value !== "string") return defaultAppLanguage;
  if (hasOwn(catalog.locales, value)) return value as AppLanguage;
  const normalized = value.toLowerCase();
  if (hasOwn(languageAliases, normalized)) {
    return languageAliases[normalized] as AppLanguage;
  }
  return defaultAppLanguage;
}

export function isMessageKey(value: unknown): value is MessageKey {
  return typeof value === "string" && hasOwn(catalog.definitions, value);
}

export function getLanguageMetadata(language: unknown): {
  label: string;
  locale: string;
} {
  const resolved = resolveAppLanguage(language);
  const { label, locale } = catalog.locales[resolved];
  return { label, locale };
}

export function getMessageTemplate(
  language: unknown,
  key: MessageKey,
): { language: AppLanguage; locale: string; template: string } {
  const resolved = resolveAppLanguage(language);
  const localized = catalog.locales[resolved].messages[key];
  if (localized !== undefined && localized.length > 0) {
    return {
      language: resolved,
      locale: catalog.locales[resolved].locale,
      template: localized,
    };
  }
  if (catalog.definitions[key].policy === "required") {
    throw new Error(`Required translation ${key} is missing for ${resolved}.`);
  }
  const fallback = catalog.locales[catalog.defaultLanguage].messages[key];
  if (fallback === undefined || fallback.length === 0) {
    throw new Error(`English fallback translation ${key} is missing.`);
  }
  return {
    language: catalog.defaultLanguage,
    locale: catalog.locales[catalog.defaultLanguage].locale,
    template: fallback,
  };
}

export function translate(
  language: unknown,
  key: MessageKey,
  values: MessageValues = {},
): string {
  if (!hasOwn(catalog.definitions, key)) {
    throw new Error(`Unknown localization key: ${String(key)}`);
  }
  const resolved = getMessageTemplate(language, key);
  const placeholders = new Set(
    Object.keys(catalog.definitions[key].placeholders),
  );
  for (const name of placeholders) {
    if (!hasOwn(values, name)) {
      throw new Error(`Localization value ${name} is required for ${key}.`);
    }
  }
  for (const name of Object.keys(values)) {
    if (!placeholders.has(name)) {
      throw new Error(`Localization value ${name} is not used by ${key}.`);
    }
  }
  const cacheKey = `${resolved.locale}\u0000${key}\u0000${resolved.template}`;
  let formatter = formatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new IntlMessageFormat(resolved.template, resolved.locale);
    formatterCache.set(cacheKey, formatter);
  }
  return String(formatter.format(values));
}

export function getTranslationCoverage(): Array<{
  language: AppLanguage;
  missingFallbackKeys: MessageKey[];
}> {
  return appLanguages.map((language) => ({
    language,
    missingFallbackKeys: (Object.keys(catalog.definitions) as MessageKey[])
      .filter((key) => catalog.definitions[key].policy === "fallback")
      .filter((key) => !catalog.locales[language].messages[key]),
  }));
}

export const localizationCatalog = catalog;
