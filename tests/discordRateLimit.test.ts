import assert from 'node:assert/strict';
import test from 'node:test';

import { getDiscordRetryAfterMs } from '../src/utils/discordRateLimit';
import { getFactoryResetRetryDelayMs } from '../src/services/factoryResetService';

test('discord.js retryAfter is treated as milliseconds and is not truncated', () => {
  assert.equal(getDiscordRetryAfterMs({ retryAfter: 195_000 }), 195_000);
  assert.equal(getFactoryResetRetryDelayMs({ retryAfter: 195_000 }), 195_250);
});

test('raw Discord retry_after values are interpreted as seconds', () => {
  assert.equal(getDiscordRetryAfterMs({ retry_after: 420 }), 420_000);
  assert.equal(getFactoryResetRetryDelayMs({ data: { retry_after: 420 } }), 420_250);
  assert.equal(
    getDiscordRetryAfterMs({ rawError: { retry_after: 1.25 } }),
    1_250,
  );
});

test('Retry-After response headers and textual cooldowns are normalized', () => {
  assert.equal(
    getDiscordRetryAfterMs({ headers: { get: (key: string) => key === 'retry-after' ? '2.5' : null } }),
    2_500,
  );
  assert.equal(
    getDiscordRetryAfterMs(new Error('Discord rate limit; retry after=420s')),
    420_000,
  );
  assert.equal(
    getDiscordRetryAfterMs(new Error('Rate limited, try again in another 1200ms')),
    null,
  );
});

test('non-rate-limit errors do not schedule a retry', () => {
  assert.equal(getDiscordRetryAfterMs(new Error('Missing permissions')), null);
  assert.equal(getFactoryResetRetryDelayMs(new Error('Missing permissions')), null);
});
