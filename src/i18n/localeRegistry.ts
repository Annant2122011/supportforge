export const SUPPORTED_LOCALES = ['en-US', 'hi-IN', 'bn-IN'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

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
