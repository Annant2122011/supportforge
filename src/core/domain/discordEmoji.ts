/**
 * Accept Unicode emoji sequences and Discord custom-emoji identifiers, but
 * reject arbitrary words that would otherwise be saved and later break a
 * component refresh at Discord's API boundary.
 */
export function normalizeDiscordEmoji(value: unknown, fieldName = 'Emoji'): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(fieldName + ' must be an emoji string.');
  const candidate = value.trim();
  if (!candidate) return undefined;

  const custom = /^<a?:[a-zA-Z0-9_]{2,32}:\d{17,20}>$/.test(candidate);
  const unicode =
    /\p{Extended_Pictographic}/u.test(candidate) ||
    /^\p{Regional_Indicator}{2}$/u.test(candidate) ||
    /\u20E3/u.test(candidate);
  if (!custom && !unicode) {
    throw new Error(fieldName + ' must be a Unicode emoji or Discord custom emoji such as <:support:12345678901234567>.');
  }
  if (candidate.length > 100) {
    throw new Error(fieldName + ' cannot exceed 100 characters.');
  }
  return candidate;
}
