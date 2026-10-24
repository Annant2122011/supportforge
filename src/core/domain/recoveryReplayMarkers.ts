import { createHash } from 'node:crypto';

const RECOVERY_SEGMENT_PATTERN = /\u2063[\u200B\u200C]{64}\u2063/g;

/**
 * A deterministic invisible marker lets a retry recognize individual messages
 * already accepted by Discord when the corresponding Neon ledger write failed.
 * It reduces duplicates; it cannot make the Discord send and DB write atomic.
 */
export function recoverySegmentMarker(
  recoveryEventId: string,
  originalMessageId: string,
  segmentKey: string,
): string {
  const hex = createHash('sha256')
    .update(recoveryEventId + ':' + originalMessageId + ':' + segmentKey)
    .digest('hex')
    .slice(0, 16);
  const bits = hex.split('').map((character) =>
    Number.parseInt(character, 16).toString(2).padStart(4, '0'),
  ).join('');
  return '\u2063' + bits.split('').map((bit) => bit === '0' ? '\u200B' : '\u200C').join('') + '\u2063';
}

export function extractRecoverySegmentMarkers(candidates: readonly string[]): string[] {
  const markers: string[] = [];
  for (const candidate of candidates) {
    RECOVERY_SEGMENT_PATTERN.lastIndex = 0;
    for (const match of candidate.matchAll(RECOVERY_SEGMENT_PATTERN)) {
      markers.push(match[0]);
    }
  }
  return markers;
}
