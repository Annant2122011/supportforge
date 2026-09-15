/**
 * SupportForge demo tier system.
 *
 * IMPORTANT — this is a DEMO paywall, not a real billing system:
 * tiers are held in memory only, reset whenever the bot restarts,
 * and there is no payment processing anywhere in this file. It
 * exists so a server can preview what Premium/Pro unlock before
 * any real subscription system is built (Stripe, a web dashboard,
 * a database-backed entitlement table, etc.).
 */

export type SupportForgeTier = 'free' | 'premium-demo' | 'pro-demo';

const guildTiers = new Map<string, SupportForgeTier>();

export function getGuildTier(guildId: string): SupportForgeTier {
  return guildTiers.get(guildId) ?? 'free';
}

export function setGuildTier(
  guildId: string,
  tier: SupportForgeTier,
): void {
  guildTiers.set(guildId, tier);
}

export function isPremiumOrHigher(guildId: string): boolean {
  const tier = getGuildTier(guildId);

  return tier === 'premium-demo' || tier === 'pro-demo';
}

export function isProTier(guildId: string): boolean {
  return getGuildTier(guildId) === 'pro-demo';
}

export function tierLabel(tier: SupportForgeTier): string {
  switch (tier) {
    case 'free':
      return 'Free';
    case 'premium-demo':
      return 'Premium (Demo)';
    case 'pro-demo':
      return 'Pro (Demo)';
  }
}

/**
 * Standard "this is locked behind a paid tier" reply content,
 * used by every premium-gated command so the messaging is
 * consistent.
 */
export function premiumRequiredMessage(
  requiredTier: 'premium-demo' | 'pro-demo',
): string {
  const label =
    requiredTier === 'pro-demo' ? 'Pro' : 'Premium';

  return (
    `🔒 This is a **${label}** feature.\n\n` +
    `An administrator can preview it with ` +
    `\`/supportforge premium toggle-demo\` — this switches the ` +
    `server into demo mode with no payment involved, purely to ` +
    `try the feature out.`
  );
}
