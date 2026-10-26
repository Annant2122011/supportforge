import assert from 'node:assert/strict';
import test from 'node:test';

import { composeDiscordDescription, truncateDiscordText } from '../src/interactions/embedText';

test('Discord text helper leaves normal content untouched', () => {
  assert.equal(truncateDiscordText('QueryFixr support', 100), 'QueryFixr support');
  assert.equal(composeDiscordDescription(['Intro', '', 'Ticket departments']), 'Intro\n\nTicket departments');
});

test('Discord text helper visibly truncates overlong content within the platform limit', () => {
  const result = truncateDiscordText('A'.repeat(5000), 4096);
  assert.ok(result.length <= 4096);
  assert.ok(result.startsWith('A'));
  assert.ok(result.includes('shortened to fit Discord limits'));
  assert.equal(composeDiscordDescription(['x'.repeat(5000)], 4000).length <= 4000, true);
});

test('Discord text helper never leaves a dangling UTF-16 surrogate', () => {
  const source = 'A'.repeat(8) + '😀' + 'B'.repeat(12);
  const result = truncateDiscordText(source, 10, '…');
  assert.equal(result.length <= 10, true);
  assert.equal(/[\uD800-\uDBFF]$/.test(result), false);
  assert.equal(/[\uDC00-\uDFFF]$/.test(result), false);
});

test('Discord text helper validates limits rather than silently accepting invalid input', () => {
  assert.throws(() => truncateDiscordText('copy', -1), RangeError);
});
