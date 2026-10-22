export const SUPPORTED_LOCALES = ['en-US', 'hi-IN', 'bn-IN', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR', 'ar', 'ja-JP'] as const;

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
  { value: 'es-ES', label: 'Spanish (Spain)', nativeLabel: 'Español' },
  { value: 'fr-FR', label: 'French', nativeLabel: 'Français' },
  { value: 'de-DE', label: 'German', nativeLabel: 'Deutsch' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)', nativeLabel: 'Português' },
  { value: 'ar', label: 'Arabic', nativeLabel: 'العربية' },
  { value: 'ja-JP', label: 'Japanese', nativeLabel: '日本語' },
];

const LANGUAGE_ALIASES: Readonly<Record<string, SupportedLocale>> = {
  en: 'en-US', 'en-us': 'en-US',
  hi: 'hi-IN', 'hi-in': 'hi-IN',
  bn: 'bn-IN', 'bn-in': 'bn-IN',
  es: 'es-ES', 'es-es': 'es-ES',
  fr: 'fr-FR', 'fr-fr': 'fr-FR',
  de: 'de-DE', 'de-de': 'de-DE',
  pt: 'pt-BR', 'pt-br': 'pt-BR', 'pt-pt': 'pt-BR',
  ar: 'ar', 'ar-sa': 'ar',
  ja: 'ja-JP', 'ja-jp': 'ja-JP',
};

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Resolve legacy aliases and malformed persisted values safely to English. */
export function resolveLocale(value: unknown): SupportedLocale {
  if (isSupportedLocale(value)) return value;
  if (typeof value !== 'string') return 'en-US';
  return LANGUAGE_ALIASES[value.trim().toLowerCase()] ?? 'en-US';
}

export function getLocaleOption(value: unknown): LocaleOption {
  const locale = resolveLocale(value);
  return LOCALE_OPTIONS.find((option) => option.value === locale) ?? LOCALE_OPTIONS[0]!;
}

export function getLocaleLabel(value: unknown): string {
  const option = getLocaleOption(value);
  return option.value === 'en-US' ? option.label : option.label + ' · ' + option.nativeLabel;
}
