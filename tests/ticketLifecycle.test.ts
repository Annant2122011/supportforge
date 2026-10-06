import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTicketStatusTransition,
  canTransitionTicketStatus,
  getAllowedTicketStatusTransitions,
} from '../src/core/domain/ticketLifecycle';

test('allows normal open ticket progression', () => {
  assert.equal(canTransitionTicketStatus('open', 'claimed'), true);
  assert.equal(canTransitionTicketStatus('claimed', 'pending'), true);
  assert.equal(canTransitionTicketStatus('pending', 'closed'), true);
});

test('allows reopen only from a closed ticket', () => {
  assert.equal(canTransitionTicketStatus('closed', 'reopened'), true);
  assert.equal(canTransitionTicketStatus('open', 'reopened'), false);
  assert.equal(canTransitionTicketStatus('archived', 'reopened'), false);
});

test('archived tickets have no further lifecycle transitions', () => {
  assert.deepEqual(getAllowedTicketStatusTransitions('archived'), []);
});

test('rejects invalid lifecycle transitions', () => {
  assert.throws(
    () => assertTicketStatusTransition('open', 'archived'),
    /open -> archived/,
  );

  assert.throws(
    () => assertTicketStatusTransition('closed', 'pending'),
    /closed -> pending/,
  );
});

test('exposes a stable transition table for application services', () => {
  assert.deepEqual(
    getAllowedTicketStatusTransitions('closed'),
    ['reopened', 'archived'],
  );
});
