import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPrivateThreadCloseTranscript,
  privateThreadCloseTranscriptMarker,
} from '../src/services/privateThreadTicketService';

test('private-thread transcript marker is canonical and stable across equivalent timestamps', () => {
  const utc = privateThreadCloseTranscriptMarker('ticket-1', '2026-10-26T12:00:00.000Z');
  const offset = privateThreadCloseTranscriptMarker('ticket-1', '2026-10-26T17:30:00.000+05:30');

  assert.equal(utc, offset);
  assert.match(utc, /ticket=ticket-1/);
  assert.match(utc, /attempt=2026-10-26T12:00:00.000Z/);
});

test('private-thread transcript recovery requires the exact marker as a message line', () => {
  const marker = privateThreadCloseTranscriptMarker('ticket-42', '2026-10-26T12:00:00.000Z');

  assert.equal(isPrivateThreadCloseTranscript('Transcript\n' + marker + '\nTicket: <#123>', marker), true);
  assert.equal(isPrivateThreadCloseTranscript('Transcript\n' + marker + '-copy', marker), false);
  assert.equal(isPrivateThreadCloseTranscript('Transcript ' + marker, marker), false);
  assert.equal(isPrivateThreadCloseTranscript('Transcript without a marker', marker), false);
});

test('private-thread transcript marker rejects missing ticket IDs and invalid timestamps', () => {
  assert.throws(() => privateThreadCloseTranscriptMarker('   ', '2026-10-26T12:00:00.000Z'));
  assert.throws(() => privateThreadCloseTranscriptMarker('ticket-1', 'not-a-timestamp'));
});
