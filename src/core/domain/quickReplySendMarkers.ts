import { createHash } from 'node:crypto';

const QUICK_REPLY_MARKER_PATTERN = /\u2063[\u200B\u200C]{64}\u2063/g;

/**
 * Deterministic, invisible marker for reconciling a send after Discord accepts
 * it but PostgreSQL completion persistence fails. This reduces duplicates; it
 * does not make Discord and PostgreSQL one atomic transaction.
 */
export function quickReplySendMarker(
  interactionId: string,
  guildId: string,
  ticketId: string,
  quickReplyId: string,
): string {
  const bits = createHash('sha256')
    .update(interactionId + ':' + guildId + ':' + ticketId + ':' + quickReplyId)
    .digest('hex')
    .slice(0, 16)
    .split('')
    .map((character) => Number.parseInt(character, 16).toString(2).padStart(4, '0'))
    .join('');
  return '\u2063' + bits.split('').map((bit) => bit === '0' ? '\u200B' : '\u200C').join('') + '\u2063';
}

export function extractQuickReplySendMarkers(candidates: readonly string[]): string[] {
  const markers: string[] = [];
  for (const candidate of candidates) {
    QUICK_REPLY_MARKER_PATTERN.lastIndex = 0;
    for (const match of candidate.matchAll(QUICK_REPLY_MARKER_PATTERN)) {
      markers.push(match[0]);
    }
  }
  return markers;
}
