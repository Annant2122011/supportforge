import { resolveLocale, type SupportedLocale } from './localeRegistry';
import enUS from './locales/en-US';
import hiIN from './locales/hi-IN';
import bnIN from './locales/bn-IN';

export type TranslationKey = keyof typeof enUS;
export type TranslationParams = Readonly<Record<string, string | number | boolean | null | undefined>>;

const CATALOGS: Readonly<Record<SupportedLocale, Record<TranslationKey, string>>> = {
  'en-US': enUS,
  'hi-IN': hiIN,
  'bn-IN': bnIN,
};

/**
 * Replace placeholders once only. Replacement output is never re-parsed, so
 * user-provided braces or dollar signs cannot become template instructions.
 * Unknown placeholders remain visible instead of silently erasing context.
 */
function interpolate(template: string, params: TranslationParams = {}): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => {
    const value = params[name];
    if (value === null || value === undefined) return placeholder;
    return String(value);
  });
}

export function translate(
  localeInput: unknown,
  key: TranslationKey,
  params: TranslationParams = {},
): string {
  const locale = resolveLocale(localeInput);
  const template = CATALOGS[locale][key];
  if (typeof template !== 'string' || !template.trim()) {
    throw new Error('Missing translation for locale ' + locale + ' and key ' + key + '.');
  }
  return interpolate(template, params);
}

/** Format a finite number using the selected supported locale. */
export function formatLocaleNumber(
  localeInput: unknown,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  if (!Number.isFinite(value)) {
    throw new RangeError('Cannot format a non-finite number as a localized value.');
  }
  const locale = resolveLocale(localeInput);
  return new Intl.NumberFormat(locale, options).format(value);
}

/**
 * Format a date-like input with a stable default date format. Invalid input
 * throws so callers cannot accidentally display "Invalid Date" to users.
 */
export function formatLocaleDate(
  localeInput: unknown,
  value: Date | string | number,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' },
): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError('Cannot format an invalid date as a localized value.');
  }
  const locale = resolveLocale(localeInput);
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/** Exposed for tests/authoring tools to audit catalog coverage. */
export function getTranslationKeys(): readonly TranslationKey[] {
  return Object.keys(enUS) as TranslationKey[];
}

/** Exposed read-only helper for catalog completeness tests and documentation. */
export function hasOwnTranslation(localeInput: unknown, key: TranslationKey): boolean {
  const locale = resolveLocale(localeInput);
  return typeof CATALOGS[locale][key] === 'string' && CATALOGS[locale][key]!.length > 0;
}
