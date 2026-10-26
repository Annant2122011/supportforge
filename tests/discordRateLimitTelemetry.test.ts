import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDiscordRateLimitSummary,
  recordDiscordRateLimit,
  resetDiscordRateLimitTelemetryForTests,
} from '../src/services/discordRateLimitTelemetry';

test('rate-limit telemetry summarizes recent events and highest-frequency routes', () => {
  resetDiscordRateLimitTelemetryForTests();
  const now = Date.parse('2026-10-23T12:00:00.000Z');

  recordDiscordRateLimit({
    method: 'patch',
    route: '/channels/123456789012345678',
    scope: 'user',
    retryAfterMs: 1200,
    global: false,
  }, now);
  recordDiscordRateLimit({
    method: 'PATCH',
    route: '/channels/123456789012345679',
    scope: 'user',
    retryAfterMs: 3500,
    global: true,
    sublimitTimeoutMs: 5000,
  }, now + 1000);

  const summary = getDiscordRateLimitSummary(now + 1000);
  assert.equal(summary.eventCount, 2);
  assert.equal(summary.globalEventCount, 1);
  assert.equal(summary.longestRetryAfterMs, 5000);
  assert.deepEqual(summary.topRoutes, [{ route: 'PATCH /channels/:id', count: 2 }]);
});

test('rate-limit telemetry applies a sliding 15 minute window and ignores future events', () => {
  resetDiscordRateLimitTelemetryForTests();
  const now = Date.parse('2026-10-23T12:00:00.000Z');
  recordDiscordRateLimit({
    method: 'GET', route: '/guilds/123456789012345678', scope: 'shared',
    retryAfterMs: 1000, global: false,
  }, now - 16 * 60_000);
  recordDiscordRateLimit({
    method: 'GET', route: '/guilds/123456789012345678', scope: 'shared',
    retryAfterMs: 1500, global: false,
  }, now + 60_000);

  assert.equal(getDiscordRateLimitSummary(now).eventCount, 0);
});

test('rate-limit telemetry is bounded to avoid unbounded memory growth', () => {
  resetDiscordRateLimitTelemetryForTests();
  const now = Date.parse('2026-10-23T12:00:00.000Z');
  for (let i = 0; i < 650; i += 1) {
    recordDiscordRateLimit({
      method: 'PATCH', route: '/channels/123456789012345678',
      scope: 'user', retryAfterMs: i, global: false,
    }, now + i);
  }

  const summary = getDiscordRateLimitSummary(now + 650);
  assert.equal(summary.eventCount, 500);
  assert.equal(summary.topRoutes[0]?.count, 500);
});

test('rate-limit telemetry strips snowflakes and never includes URL query strings', () => {
  resetDiscordRateLimitTelemetryForTests();
  const now = Date.parse('2026-10-23T12:00:00.000Z');
  recordDiscordRateLimit({
    method: 'GET',
    route: '/channels/123456789012345678/messages?token=should-not-appear',
    scope: 'user',
    retryAfterMs: 100,
    global: false,
  }, now);

  const summary = getDiscordRateLimitSummary(now);
  assert.equal(summary.topRoutes[0]?.route, 'GET /channels/:id/messages');
  assert.equal(JSON.stringify(summary).includes('should-not-appear'), false);
});
