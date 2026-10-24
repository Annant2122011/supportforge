import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractQuickReplySendMarkers,
  quickReplySendMarker,
} from '../src/core/domain/quickReplySendMarkers';

test('quick-reply send markers are deterministic and scoped to one interaction and payload', () => {
  const first = quickReplySendMarker('12345678901234567', 'guild-1', 'ticket-1', 'reply-1');
  const retry = quickReplySendMarker('12345678901234567', 'guild-1', 'ticket-1', 'reply-1');
  const otherInteraction = quickReplySendMarker('12345678901234568', 'guild-1', 'ticket-1', 'reply-1');
  const otherTicket = quickReplySendMarker('12345678901234567', 'guild-1', 'ticket-2', 'reply-1');
  assert.equal(first, retry);
  assert.equal(first.length, 66);
  assert.equal(new Set([first, otherInteraction, otherTicket]).size, 3);
});

test('quick-reply marker extraction finds markers but ignores malformed lookalikes', () => {
  const marker = quickReplySendMarker('12345678901234567', 'guild-1', 'ticket-1', 'reply-1');
  assert.deepEqual(extractQuickReplySendMarkers(['answer ' + marker, 'ordinary message']), [marker]);
  assert.deepEqual(extractQuickReplySendMarkers(['\\u2063' + '\\u200B'.repeat(63) + '\\u2063']), []);
});
