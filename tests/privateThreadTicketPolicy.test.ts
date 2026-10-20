import assert from 'node:assert/strict';
import testCase from 'node:test';
import { getPrivateThreadTicketActions, canPrivateThreadTicketAction, normalizeTicketWorkspaceMode } from '../src/core/domain/privateThreadTicketPolicy';

testCase('workspace mode normalizes legacy and unknown settings to safe text-channel defaults', () => {
  assert.equal(normalizeTicketWorkspaceMode(undefined), 'text-channels');
  assert.equal(normalizeTicketWorkspaceMode('unexpected'), 'text-channels');
  assert.equal(normalizeTicketWorkspaceMode('private-threads'), 'private-threads');
});

testCase('private-thread ticket controls are gated by durable lifecycle state', () => {
  assert.deepEqual(getPrivateThreadTicketActions('open'), ['claim', 'pending', 'close']);
  assert.deepEqual(getPrivateThreadTicketActions('reopened'), ['claim', 'pending', 'close']);
  assert.deepEqual(getPrivateThreadTicketActions('claimed'), ['claim', 'unclaim', 'pending', 'close']);
  assert.deepEqual(getPrivateThreadTicketActions('pending'), ['resume', 'close']);
  assert.deepEqual(getPrivateThreadTicketActions('closed'), ['reopen', 'archive']);
  assert.deepEqual(getPrivateThreadTicketActions('archived'), []);
  assert.equal(canPrivateThreadTicketAction('claimed', 'unclaim'), true);
  assert.equal(canPrivateThreadTicketAction('pending', 'resume'), true);
  assert.equal(canPrivateThreadTicketAction('closed', 'reopen'), true);
  assert.equal(canPrivateThreadTicketAction('open', 'reopen'), false);
  assert.equal(canPrivateThreadTicketAction('archived', 'close'), false);
});

testCase('unknown persisted lifecycle values fail closed instead of throwing', () => {
  const unknownStatus = 'future-status' as Parameters<typeof getPrivateThreadTicketActions>[0];
  assert.deepEqual(getPrivateThreadTicketActions(unknownStatus), []);
  assert.equal(canPrivateThreadTicketAction(unknownStatus, 'close'), false);
});
