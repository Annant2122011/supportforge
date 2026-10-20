import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDiscordEmoji } from '../src/core/domain/discordEmoji';

test('emoji validation accepts common Unicode emoji and keycaps', () => {
  assert.equal(normalizeDiscordEmoji('🎫'), '🎫');
  assert.equal(normalizeDiscordEmoji('👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦');
  assert.equal(normalizeDiscordEmoji('1️⃣'), '1️⃣');
  assert.equal(normalizeDiscordEmoji('🇮🇳'), '🇮🇳');
});

test('emoji validation accepts syntactically valid Discord custom emoji IDs', () => {
  assert.equal(
    normalizeDiscordEmoji('<:support:12345678901234567>'),
    '<:support:12345678901234567>',
  );
  assert.equal(
    normalizeDiscordEmoji('<a:support_wave:12345678901234567>'),
    '<a:support_wave:12345678901234567>',
  );
});

test('emoji validation rejects arbitrary strings and malformed custom emoji syntax', () => {
  for (const value of ['ticket', 'blue star', '<:bad:123>', '<support:12345678901234567>', 'not-an-emoji']) {
    assert.throws(() => normalizeDiscordEmoji(value), /emoji/i, value);
  }
  assert.equal(normalizeDiscordEmoji(''), undefined);
  assert.equal(normalizeDiscordEmoji(null), undefined);
});

test('emoji validation rejects unsupported types and overlong values', () => {
  assert.throws(() => normalizeDiscordEmoji(42), /must be an emoji string/);
  assert.throws(() => normalizeDiscordEmoji('🎫'.repeat(60)), /cannot exceed 100 characters/);
});
