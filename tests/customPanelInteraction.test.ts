import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCustomPanelInteractionId } from '../src/core/domain/customPanelInteraction';

test('public custom-panel button IDs resolve stable panel and button identifiers', () => {
  assert.deepEqual(
    parseCustomPanelInteractionId('ticket:custom:abc123def456:buttonbill1'),
    { action: 'start', panelId: 'abc123def456', buttonId: 'buttonbill1' },
  );
});

test('confirmation and cancellation IDs bind to the original public message and initiating user', () => {
  assert.deepEqual(
    parseCustomPanelInteractionId('ticket:custom:confirm:abc123def456:buttonbill1:12345678901234567:23456789012345678'),
    {
      action: 'confirm',
      panelId: 'abc123def456',
      buttonId: 'buttonbill1',
      sourceMessageId: '12345678901234567',
      promptOwnerId: '23456789012345678',
    },
  );
  assert.equal(
    parseCustomPanelInteractionId('ticket:custom:cancel:abc123def456:buttonbill1:12345678901234567:23456789012345678')?.action,
    'cancel',
  );
});

test('custom-panel interaction parser rejects malformed, truncated and tampered IDs', () => {
  for (const value of [
    'ticket:custom',
    'ticket:custom:abc123def456',
    'ticket:custom:abc123def456:buttonbill1:extra',
    'ticket:custom:confirm:abc123def456:buttonbill1',
    'ticket:custom:confirm:abc123def456:buttonbill1:not-a-message:23456789012345678',
    'ticket:custom:confirm:abc123def456:buttonbill1:12345678901234567:invalid-user',
    'ticket:custom:confirm:ABC!23def456:buttonbill1:12345678901234567:23456789012345678',
  ]) {
    assert.equal(parseCustomPanelInteractionId(value), null, value);
  }
});
