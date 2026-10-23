export const SUPPORTED_LOCALES = ['en-US', 'hi-IN', 'bn-IN'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export interface LocaleOption {
  value: SupportedLocale;
  label: string;
  nativeLabel: string;
}

export const LOCALE_OPTIONS: readonly LocaleOption[] = [
  { value: 'en-US', label: 'English (United States)', nativeLabel: 'English' },
  { value: 'hi-IN', label: 'Hindi (India)', nativeLabel: 'हिन्दी' },
  { value: 'bn-IN', label: 'Bengali (India)', nativeLabel: 'বাংলা' },
];

const LANGUAGE_ALIASES: Readonly<Record<string, SupportedLocale>> = {
  en: 'en-US',
  'en-us': 'en-US',
  hi: 'hi-IN',
  'hi-in': 'hi-IN',
  bn: 'bn-IN',
  'bn-in': 'bn-IN',
};

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Resolve persisted/user-provided locale input without allowing malformed
 * settings to break startup or message rendering.
 */
export function resolveLocale(value: unknown): SupportedLocale {
  if (isSupportedLocale(value)) return value;
  if (typeof value !== 'string') return 'en-US';
  return LANGUAGE_ALIASES[value.trim().toLowerCase()] ?? 'en-US';
}

export function getLocaleLabel(value: unknown): string {
  const locale = resolveLocale(value);
  const option = LOCALE_OPTIONS.find((candidate) => candidate.value === locale) ?? LOCALE_OPTIONS[0]!;
  return locale === 'en-US' ? option.label : option.label + ' · ' + option.nativeLabel;
}
