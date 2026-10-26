import { EmbedBuilder } from 'discord.js';

/** Shared identity for public-facing QueryFixr embeds. Discord controls the layout, so use consistent accents and concise titles instead of fake CSS. */
export const QUERYFIXR_ACCENT_COLOR = 0x5865f2;
export const QUERYFIXR_LOGO_URL = 'https://i.ibb.co/p6VGzczV/HTcx0584-Os-Oe-YAj-O5qp61-x5-PHKm89.png';

export function applyQueryFixrBranding(
  embed: EmbedBuilder,
  section: string,
  accentColor = QUERYFIXR_ACCENT_COLOR,
): EmbedBuilder {
  const safeSection = section.trim().replace(/\s+/g, ' ').slice(0, 180) || 'Support';
  return embed
    .setColor(accentColor)
    .setAuthor({
      name: 'QueryFixr · ' + safeSection,
      iconURL: QUERYFIXR_LOGO_URL,
    });
}

export function queryFixrFooter(section: string, detail?: string): string {
  const safeSection = section.trim().replace(/\s+/g, ' ').slice(0, 160) || 'Support';
  const safeDetail = detail?.trim().replace(/\s+/g, ' ').slice(0, 160);
  return ('QueryFixr • ' + safeSection + (safeDetail ? ' • ' + safeDetail : '')).slice(0, 2048);
}
