import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateOutboxRetryDelayMs } from '../src/core/events/outboxProcessor';

test('uses discord.js retryAfter milliseconds rather than a shorter exponential retry', () => {
  assert.equal(
    calculateOutboxRetryDelayMs(1, { retryAfter: 195_000 }),
    196_000,
  );
});

test('converts raw Discord retry_after seconds to milliseconds with a safety margin', () => {
  assert.equal(
    calculateOutboxRetryDelayMs(2, {
      rawError: { retry_after: 195, global: true },
    }),
    196_000,
  );
});

test('honors Retry-After headers', () => {
  assert.equal(
    calculateOutboxRetryDelayMs(1, {
      headers: { get: (name: string) => name === 'retry-after' ? '12.5' : null },
    }),
    13_500,
  );
});

test('honors textual retry-after messages from wrapped API errors', () => {
  assert.equal(
    calculateOutboxRetryDelayMs(1, new Error('Discord rate limit: retry after 195s')),
    1_000,
  );
  assert.equal(
    calculateOutboxRetryDelayMs(3, new Error('queued after another 195s')),
    196_000,
  );
});

test('uses bounded exponential backoff when the error has no server cooldown', () => {
  assert.equal(calculateOutboxRetryDelayMs(1), 1_000);
  assert.equal(calculateOutboxRetryDelayMs(2), 2_000);
  assert.equal(calculateOutboxRetryDelayMs(20), 15 * 60_000);
});
