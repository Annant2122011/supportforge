/**
 * Migrate only exact, application-owned default strings from historical brand
 * spellings to the current built-in default. Never rewrite arbitrary settings:
 * department names, tags, custom panel copy, button labels, and messages are
 * server-owned content even when they happen to mention a previous brand.
 */
const LEGACY_BRAND_NAMES = ['SupportForge', 'ResolveX', 'ResolvX', 'SUPPORTFORGE'] as const;

export function normalizeManagedBrandDefault(
  value: unknown,
  canonicalDefault: string,
): unknown {
  if (typeof value !== 'string' || !canonicalDefault.includes('QueryFixr')) {
    return value;
  }

  const legacyDefaults = LEGACY_BRAND_NAMES.map((brand) =>
    canonicalDefault.replaceAll('QueryFixr', brand),
  );

  return legacyDefaults.includes(value as (typeof legacyDefaults)[number])
    ? canonicalDefault
    : value;
}
