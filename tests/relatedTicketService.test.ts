import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalRelatedTicketPair } from '../src/services/relatedTicketService';

test('related ticket pairs trim identifiers and use a stable lexical order', () => {
  assert.deepEqual(canonicalRelatedTicketPair(' ticket-b ', 'ticket-a'), ['ticket-a', 'ticket-b']);
  assert.deepEqual(canonicalRelatedTicketPair('ticket-a', 'ticket-b'), ['ticket-a', 'ticket-b']);
});

test('related ticket pairs reject empty identifiers and self-links after normalization', () => {
  assert.throws(() => canonicalRelatedTicketPair('', 'ticket-b'), /Both ticket IDs are required/);
  assert.throws(() => canonicalRelatedTicketPair('   ', 'ticket-b'), /Both ticket IDs are required/);
  assert.throws(() => canonicalRelatedTicketPair(' ticket-a ', 'ticket-a'), /cannot be linked to itself/);
});
