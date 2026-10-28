import assert from 'node:assert/strict';
import test from 'node:test';

import type { GuildAnalyticsSummary } from '../src/services/analyticsService';
import { buildAnalyticsEmbed } from '../src/interactions/analyticsPresentation';

const summary = {
  periodDays: 7,
  periodStartAt: '2026-10-01T00:00:00.000Z',
  periodEndAt: '2026-10-08T00:00:00.000Z',
  generatedAt: '2026-10-08T12:30:00.000Z',
  ticketsCreated: 12,
  firstResolvedTickets: 8,
  closeActions: 10,
  reopenedTickets: 2,
  reopenedAfterFirstClose: 1,
  activeTickets: 6,
  openTickets: 2,
  claimedTickets: 3,
  pendingTickets: 1,
  urgentOrCriticalTickets: 2,
  oldestActiveCreatedAt: '2026-10-04T00:00:00.000Z',
  avgFirstResponseMinutes: 25.5,
  avgResolutionMinutes: 310,
  reopenRatePercent: 12.5,
  firstResponseEligible: 10,
  firstResponseSamples: 8,
} as unknown as GuildAnalyticsSummary;

test('analytics presentation consistently brands the embed and applies the server theme color', () => {
  const embed = buildAnalyticsEmbed(summary, 0x168aad).toJSON();
  assert.equal(embed.color, 0x168aad);
  assert.equal(embed.author?.name, 'QueryFixr · Support Analytics');
  assert.match(embed.author?.icon_url ?? '', /^https:\/\/i\.ibb\.co\//);
  assert.equal(embed.footer?.text, 'QueryFixr • Analytics • PostgreSQL source of truth · Times shown in UTC');
  assert.ok(embed.title?.includes('Last 7 days'));
  assert.ok(embed.description?.includes('UTC'));
});

test('analytics report makes response coverage and unsupported metrics explicit', () => {
  const embed = buildAnalyticsEmbed(summary).toJSON();
  const fields = embed.fields ?? [];
  assert.ok(fields.some((field) => field.name === 'First response' && field.value.includes('Coverage')));
  assert.ok(fields.some((field) => field.name === 'Data definitions and coverage' && field.value.includes('SLA compliance and customer satisfaction are not shown')));
});
