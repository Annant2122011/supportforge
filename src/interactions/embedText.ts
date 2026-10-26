/**
 * Safe bounded text helpers for Discord embeds.
 *
 * Discord imposes hard per-field/title/description limits. A server-authored
 * description should be shortened with a visible notice rather than causing
 * the whole support panel update to fail.
 */
export function truncateDiscordText(
  input: string,
  maximumLength: number,
  notice = '… (shortened to fit Discord limits)',
): string {
  if (!Number.isInteger(maximumLength) || maximumLength < 0) {
    throw new RangeError('maximumLength must be a non-negative integer.');
  }
  if (maximumLength === 0) return '';
  if (input.length <= maximumLength) return input;

  const suffix = notice.length <= maximumLength ? notice : '';
  const budget = Math.max(0, maximumLength - suffix.length - (suffix.length > 0 ? 1 : 0));
  let output = '';
  for (const character of input) {
    if (output.length + character.length > budget) break;
    output += character;
  }
  output = output.trimEnd();
  if (suffix) {
    const separator = output && !/\s$/.test(output) ? ' ' : '';
    return (output + separator + suffix).slice(0, maximumLength);
  }
  return output;
}

/** Builds a bounded block without ever splitting a Unicode surrogate pair. */
export function composeDiscordDescription(
  sections: readonly string[],
  maximumLength = 4096,
): string {
  return truncateDiscordText(
    sections.filter((section) => section.trim().length > 0).map((section) => section.trim()).join('\n\n'),
    maximumLength,
  );
}
