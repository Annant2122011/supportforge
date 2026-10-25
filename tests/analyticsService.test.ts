import assert from 'node:assert/strict';
import test from 'node:test';

import type { DatabaseExecutor } from '../src/core/persistence/database';
import { PostgresAnalyticsRepository } from '../src/repositories/postgresAnalyticsRepository';
import {
  getGuildAnalyticsSummary,
  parseAnalyticsPeriod,
  type AnalyticsPeriodDays,
} from '../src/services/analyticsService';

const aggregateRow = {
  tickets_created: '18',
  active_tickets: '9',
  open_tickets: '4',
  claimed_tickets: '3',
  pending_tickets: '2',
  urgent_or_critical_tickets: '2',
  oldest_active_created_at: '2026-10-20T08:00:00.000Z',
  first_resolved_tickets: '4',
  close_actions: '5',
  reopened_tickets: '2',
  reopened_after_first_close: '1',
  first_response_eligible: '12',
  first_response_samples: '10',
  avg_first_response_minutes: '27.26',
  avg_resolution_minutes: '138.84',
};

function executorWithRow(row: Record<string, unknown>, onQuery?: (sql: string, values?: readonly unknown[]) => void): DatabaseExecutor {
  return {
    query: async (sql: string, values?: readonly unknown[]) => {
      onQuery?.(sql, values);
      return {
        rows: [row],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as never;
    },
  } as unknown as DatabaseExecutor;
}

test('analytics repository normalizes PostgreSQL numeric and timestamp values', async () => {
  const repository = new PostgresAnalyticsRepository(executorWithRow(aggregateRow));
  const result = await repository.getGuildRollup(
    'guild-1',
    '2026-10-18T12:00:00.000Z',
    '2026-10-25T12:00:00.000Z',
  );

  assert.equal(result.ticketsCreated, 18);
  assert.equal(result.activeTickets, 9);
  assert.equal(result.firstResolvedTickets, 4);
  assert.equal(result.avgFirstResponseMinutes, 27.3);
  assert.equal(result.avgResolutionMinutes, 138.8);
  assert.equal(result.oldestActiveCreatedAt, '2026-10-20T08:00:00.000Z');
});

test('analytics report uses a rolling UTC window and computes reopen rate', async () => {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const repository = new PostgresAnalyticsRepository(executorWithRow(aggregateRow, (sql, values) => {
    calls.push({ sql, values });
  }));
  const summary = await getGuildAnalyticsSummary(
    'guild-1',
    7,
    new Date('2026-10-25T12:00:00.000Z'),
    repository,
  );

  assert.equal(summary.periodStartAt, '2026-10-18T12:00:00.000Z');
  assert.equal(summary.periodEndAt, '2026-10-25T12:00:00.000Z');
  assert.equal(summary.generatedAt, '2026-10-25T12:00:00.000Z');
  assert.equal(summary.reopenRatePercent, 25);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.values, [
    'guild-1',
    '2026-10-18T12:00:00.000Z',
    '2026-10-25T12:00:00.000Z',
  ]);
  assert.match(calls[0]?.sql ?? '', /messageAuthorType/);
  assert.match(calls[0]?.sql ?? '', /deleted_at IS NULL/);
});

test('analytics gracefully reports missing duration samples and zero-denominator reopen rate', async () => {
  const row = {
    ...aggregateRow,
    first_resolved_tickets: '0',
    reopened_after_first_close: '0',
    first_response_eligible: '0',
    first_response_samples: '0',
    avg_first_response_minutes: null,
    avg_resolution_minutes: null,
    oldest_active_created_at: null,
  };
  const repository = new PostgresAnalyticsRepository(executorWithRow(row));
  const summary = await getGuildAnalyticsSummary(
    'guild-1',
    30,
    new Date('2026-10-25T12:00:00.000Z'),
    repository,
  );

  assert.equal(summary.avgFirstResponseMinutes, null);
  assert.equal(summary.avgResolutionMinutes, null);
  assert.equal(summary.reopenRatePercent, null);
  assert.equal(summary.oldestActiveCreatedAt, null);
});

test('analytics rejects invalid guild IDs, period lengths and report dates', async () => {
  const repository = new PostgresAnalyticsRepository(executorWithRow(aggregateRow));
  await assert.rejects(
    getGuildAnalyticsSummary('   ', 7, new Date('2026-10-25T12:00:00.000Z'), repository),
    /guild ID is required/,
  );
  await assert.rejects(
    getGuildAnalyticsSummary('guild-1', 31 as AnalyticsPeriodDays, new Date('2026-10-25T12:00:00.000Z'), repository),
    /period must be 7, 30, or 90 days/,
  );
  await assert.rejects(
    getGuildAnalyticsSummary('guild-1', 7, new Date('invalid'), repository),
    /valid date/,
  );
});

test('invalid aggregate numeric values are normalized instead of leaking NaN', async () => {
  const repository = new PostgresAnalyticsRepository(executorWithRow({
    ...aggregateRow,
    tickets_created: 'not-a-number',
    avg_first_response_minutes: 'Infinity',
    avg_resolution_minutes: '-2',
  }));
  const result = await repository.getGuildRollup(
    'guild-1',
    '2026-10-18T12:00:00.000Z',
    '2026-10-25T12:00:00.000Z',
  );

  assert.equal(result.ticketsCreated, 0);
  assert.equal(result.avgFirstResponseMinutes, null);
  assert.equal(result.avgResolutionMinutes, null);
});


test('analytics period parser defaults only when omitted and rejects unknown labels', () => {
  assert.equal(parseAnalyticsPeriod(undefined), 7);
  assert.equal(parseAnalyticsPeriod(null), 7);
  assert.equal(parseAnalyticsPeriod('7d'), 7);
  assert.equal(parseAnalyticsPeriod('30d'), 30);
  assert.equal(parseAnalyticsPeriod('90d'), 90);
  assert.throws(() => parseAnalyticsPeriod('365d'), /period must be 7d, 30d, or 90d/);
});
