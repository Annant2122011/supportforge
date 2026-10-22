import { resolveLocale, type SupportedLocale } from './localeRegistry';
import enUS from './locales/en-US';
import hiIN from './locales/hi-IN';
import bnIN from './locales/bn-IN';
import esES from './locales/es-ES';
import frFR from './locales/fr-FR';
import deDE from './locales/de-DE';
import ptBR from './locales/pt-BR';
import ar from './locales/ar';
import jaJP from './locales/ja-JP';

export type TranslationKey = keyof typeof enUS;
export type TranslationParams = Readonly<Record<string, string | number | boolean | null | undefined>>;

const CATALOGS: Readonly<Record<SupportedLocale, Readonly<Record<TranslationKey, string>>>> = {
  'en-US': enUS,
  'hi-IN': hiIN,
  'bn-IN': bnIN,
  'es-ES': esES,
  'fr-FR': frFR,
  'de-DE': deDE,
  'pt-BR': ptBR,
  ar,
  'ja-JP': jaJP,
};

/** Single-pass interpolation: parameter content is literal and never reparsed. */
function interpolate(template: string, params: TranslationParams = {}): string {
  return template.replace(/\\{([A-Za-z][A-Za-z0-9_]*)\\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === null || value === undefined ? placeholder : String(value);
  });
}

export function translate(localeInput: unknown, key: TranslationKey, params: TranslationParams = {}): string {
  const locale = resolveLocale(localeInput);
  return interpolate(CATALOGS[locale][key] ?? enUS[key], params);
}

export function formatLocaleNumber(localeInput: unknown, value: number, options?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(value)) throw new RangeError('Cannot format a non-finite number as a localized value.');
  return new Intl.NumberFormat(resolveLocale(localeInput), options).format(value);
}

export function formatLocaleDate(
  localeInput: unknown,
  value: Date | string | number,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' },
): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Cannot format an invalid date as a localized value.');
  return new Intl.DateTimeFormat(resolveLocale(localeInput), options).format(date);
}

export function getTranslationKeys(): readonly TranslationKey[] {
  return Object.keys(enUS) as TranslationKey[];
}

export function hasOwnTranslation(localeInput: unknown, key: TranslationKey): boolean {
  const locale = resolveLocale(localeInput);
  const value = CATALOGS[locale][key];
  return typeof value === 'string' && value.trim().length > 0;
}
