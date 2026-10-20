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
  assert.equal(canPrivateThreadTicketAction('claimed', 'unclaim'), true);
  assert.equal(canPrivateThreadTicketAction('pending', 'resume'), true);
  assert.equal(canPrivateThreadTicketAction('closed', 'reopen'), true);
  assert.equal(canPrivateThreadTicketAction('archived', 'close'), false);
  assert.deepEqual(getPrivateThreadTicketActions('archived'), []);
});
