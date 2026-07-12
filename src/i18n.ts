import { de } from "./i18n/locales/de";
import { es } from "./i18n/locales/es";
import { fr } from "./i18n/locales/fr";
import { ja } from "./i18n/locales/ja";
import { ko } from "./i18n/locales/ko";
import { pt } from "./i18n/locales/pt";
import { ptBR } from "./i18n/locales/pt-br";
import { ru } from "./i18n/locales/ru";
import { zhCN } from "./i18n/locales/zh-cn";
import { zhTW } from "./i18n/locales/zh-tw";
import type { App } from "obsidian";

export const BUTTER_LANGUAGE_OPTIONS = [
  { value: "auto", label: "Auto (match Obsidian)", translateLabel: true },
  { value: "en", label: "English", translateLabel: true },
  { value: "zh-CN", label: "简体中文", translateLabel: false },
  { value: "zh-TW", label: "繁體中文", translateLabel: false },
  { value: "ja", label: "日本語", translateLabel: false },
  { value: "ko", label: "한국어", translateLabel: false },
  { value: "es", label: "Español", translateLabel: false },
  { value: "de", label: "Deutsch", translateLabel: false },
  { value: "fr", label: "Français", translateLabel: false },
  { value: "pt", label: "Português", translateLabel: false },
  { value: "pt-BR", label: "Português (Brasil)", translateLabel: false },
  { value: "ru", label: "Русский", translateLabel: false },
] as const;

export type ButterLanguageSetting = (typeof BUTTER_LANGUAGE_OPTIONS)[number]["value"];
type ResolvedLanguage = Exclude<ButterLanguageSetting, "auto">;

let currentLanguage: ResolvedLanguage = "en";

export type MessageKey = keyof typeof zhCN;
type LocalizedLanguage = Exclude<ResolvedLanguage, "en">;
export type TranslationTable = Readonly<Record<MessageKey, string>>;

const translations = {
  de,
  es,
  fr,
  ja,
  ko,
  pt,
  "pt-BR": ptBR,
  ru,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
} satisfies Record<LocalizedLanguage, TranslationTable>;

export function setI18nLanguage(language: ResolvedLanguage): void {
  currentLanguage = language;
}

export function getI18nLanguage(): ResolvedLanguage {
  return currentLanguage;
}

export function resolveI18nLanguage(
  app: App,
  setting: ButterLanguageSetting | undefined,
): ResolvedLanguage {
  if (setting && isResolvedLanguage(setting)) return setting;
  const configLanguage = readObsidianLanguage(app).toLowerCase().replace(/_/g, "-");
  if (
    configLanguage.startsWith("zh-tw") ||
    configLanguage.startsWith("zh-hk") ||
    configLanguage.startsWith("zh-mo") ||
    configLanguage.startsWith("zh-hant")
  ) {
    return "zh-TW";
  }
  if (
    configLanguage === "zh" ||
    configLanguage.startsWith("zh-cn") ||
    configLanguage.startsWith("zh-sg") ||
    configLanguage.startsWith("zh-hans")
  ) {
    return "zh-CN";
  }
  if (configLanguage.startsWith("pt-br")) return "pt-BR";

  const baseLanguage = configLanguage.split("-")[0];
  if (
    baseLanguage === "de" ||
    baseLanguage === "es" ||
    baseLanguage === "fr" ||
    baseLanguage === "ja" ||
    baseLanguage === "ko" ||
    baseLanguage === "pt" ||
    baseLanguage === "ru"
  ) {
    return baseLanguage;
  }
  return "en";
}

export function tx(text: MessageKey): string {
  if (currentLanguage === "en") return text;
  return translations[currentLanguage][text];
}

export function txKnown(text: string): string {
  return isMessageKey(text) ? tx(text) : text;
}

export function tv(template: MessageKey, values: Record<string, string | number>): string {
  return tx(template).replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

type I18nTimeUnit = "minute" | "hour" | "day";

interface RelativeTimeFormatter {
  format(value: number, unit: I18nTimeUnit): string;
}

type RelativeTimeFormatConstructor = new (
  locales?: string | string[],
  options?: { numeric?: "always" | "auto" },
) => RelativeTimeFormatter;

const singularTimeUnitKeys = {
  minute: "minute",
  hour: "hour",
  day: "day",
} as const satisfies Record<I18nTimeUnit, MessageKey>;

const pluralTimeUnitKeys = {
  minute: "minutes",
  hour: "hours",
  day: "days",
} as const satisfies Record<I18nTimeUnit, MessageKey>;

export function formatI18nUnit(unit: I18nTimeUnit, count: number): string {
  try {
    const unitPart = new Intl.NumberFormat(currentLanguage, {
      style: "unit",
      unit,
      unitDisplay: "long",
    }).formatToParts(count).find((part) => part.type === "unit");
    if (unitPart?.value) return unitPart.value;
  } catch {
    // Fall through for older embedded browsers without Intl unit formatting.
  }
  return tx(count === 1 ? singularTimeUnitKeys[unit] : pluralTimeUnitKeys[unit]);
}

export function formatI18nRelativeTime(
  count: number,
  unit: I18nTimeUnit,
  numeric: "always" | "auto" = "always",
): string {
  try {
    const RelativeTimeFormat = (Intl as unknown as {
      RelativeTimeFormat?: RelativeTimeFormatConstructor;
    }).RelativeTimeFormat;
    if (!RelativeTimeFormat) throw new Error("RelativeTimeFormat unavailable");
    return new RelativeTimeFormat(currentLanguage, { numeric }).format(-count, unit);
  } catch {
    if (numeric === "auto" && unit === "day" && count === 1) return tx("yesterday");
    return tv("{count} {unit} ago", { count, unit: formatI18nUnit(unit, count) });
  }
}

export function isMessageKey(value: string): value is MessageKey {
  return Object.prototype.hasOwnProperty.call(zhCN, value);
}

function readObsidianLanguage(app: App): string {
  const config = (app as unknown as {
    vault?: { getConfig?: (key: string) => unknown };
  }).vault?.getConfig?.("language");
  if (typeof config === "string" && config) return config;

  const momentLocale = (window as unknown as {
    moment?: { locale?: () => unknown };
  }).moment?.locale?.();
  if (typeof momentLocale === "string" && momentLocale) return momentLocale;

  const navigatorLanguage = window.navigator.language;
  return navigatorLanguage || "en";
}

function isResolvedLanguage(value: string): value is ResolvedLanguage {
  return value === "en" || Object.prototype.hasOwnProperty.call(translations, value);
}
