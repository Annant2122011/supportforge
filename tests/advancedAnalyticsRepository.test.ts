import assert from 'node:assert/strict';
import test from 'node:test';

import type { DatabaseExecutor } from '../src/core/persistence/database';
import { PostgresAdvancedAnalyticsRepository } from '../src/repositories/postgresAdvancedAnalyticsRepository';

const FILTERS = {
  departmentId: 'billing',
  priority: 'urgent' as const,
  status: 'claimed' as const,
  tagId: 'refund',
};
const GUILD = '123456789012345678';
const START = '2026-10-18T12:00:00.000Z';
const END = '2026-10-25T12:00:00.000Z';

function repositoryWithRows() {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const executor = {
    query: async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values });
      let row: Record<string, unknown>;
      if (sql.includes('AS oldest_active_created_at')) {
        row = {
          department_id: 'billing',
          tickets_created: '8',
          active_tickets: '4',
          open_tickets: '1',
          claimed_tickets: '2',
          pending_tickets: '1',
          urgent_or_critical_tickets: '1',
          first_resolved_tickets: '3',
          reopened_tickets: '1',
          first_response_eligible: '4',
          first_response_samples: '3',
          avg_first_response_minutes: '12.34',
          avg_resolution_minutes: '75.55',
          oldest_active_created_at: '2026-10-19T10:00:00.000Z',
        };
      } else if (sql.includes('AS active_workload')) {
        row = {
          staff_id: '223456789012345678',
          tickets_claimed: '3',
          tickets_closed: '2',
          staff_replies: '14',
          first_responses: '3',
          active_workload: '2',
          avg_first_response_minutes: '9.96',
        };
      } else if (sql.includes('AS tag_id')) {
        row = {
          tag_id: 'refund',
          tickets_created: '5',
          active_tickets: '2',
          first_resolved_tickets: '2',
          urgent_or_critical_tickets: '1',
        };
      } else if (sql.includes('AS period_tickets')) {
        row = {
          period_tickets: '20',
          created_event_tickets: '18',
          message_events: '100',
          attributed_message_events: '84',
          unknown_author_messages: '8',
          missing_timestamp_messages: '8',
          lifecycle_events: '30',
        };
      } else {
        row = {
          day: '2026-10-22',
          tickets_created: '4',
          first_resolved_tickets: '2',
        };
      }
      return {
        rows: [row],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as never;
    },
  } as unknown as DatabaseExecutor;
  return { repository: new PostgresAdvancedAnalyticsRepository(executor), calls };
}

test('department breakdown maps counts, durations and first-response coverage', async () => {
  const { repository, calls } = repositoryWithRows();
  const result = await repository.getDepartmentBreakdown(GUILD, START, END, FILTERS);

  assert.equal(result[0]?.departmentId, 'billing');
  assert.equal(result[0]?.ticketsCreated, 8);
  assert.equal(result[0]?.avgFirstResponseMinutes, 12.3);
  assert.equal(result[0]?.avgResolutionMinutes, 75.6);
  assert.equal(result[0]?.firstResponseSamples, 3);
  assert.match(calls[0]?.sql ?? '', /IS NOT DISTINCT FROM/);
  assert.match(calls[0]?.sql ?? '', /messageTimestamp/);
  assert.match(calls[0]?.sql ?? '', /e\.guild_id = \$1/);
  assert.deepEqual(calls[0]?.values, [GUILD, START, END, 'billing', 'urgent', 'claimed', 'refund']);
});

test('staff breakdown includes only high-confidence attributable staff IDs', async () => {
  const { repository, calls } = repositoryWithRows();
  const result = await repository.getStaffBreakdown(GUILD, START, END, FILTERS);

  assert.equal(result[0]?.staffId, '223456789012345678');
  assert.equal(result[0]?.ticketsClaimed, 3);
  assert.equal(result[0]?.activeWorkload, 2);
  assert.equal(result[0]?.avgFirstResponseMinutes, 10);
  assert.match(calls[0]?.sql ?? '', /actor_attribution = 'actorKnown'/);
  assert.match(calls[0]?.sql ?? '', /actor_confidence = 'high'/);
  assert.match(calls[0]?.sql ?? '', /UNNEST\(t\.claimed_by_ids\)/);
});

test('tag breakdown uses NULL-safe grouping so untagged tickets are not lost', async () => {
  const { repository, calls } = repositoryWithRows();
  const result = await repository.getTagBreakdown(GUILD, START, END, FILTERS);

  assert.equal(result[0]?.tagId, 'refund');
  assert.equal(result[0]?.ticketsCreated, 5);
  assert.equal(result[0]?.urgentOrCriticalTickets, 1);
  assert.match(calls[0]?.sql ?? '', /IS NOT DISTINCT FROM tags\.tag_id/);
});

test('daily trend series and data-coverage reports map aggregate data safely', async () => {
  const { repository, calls } = repositoryWithRows();
  const daily = await repository.getDailyTrends(GUILD, START, END, FILTERS);
  const coverage = await repository.getDataCoverage(GUILD, START, END, FILTERS);

  assert.deepEqual(daily, [{
    day: '2026-10-22',
    ticketsCreated: 4,
    firstResolvedTickets: 2,
  }]);
  assert.deepEqual(coverage, {
    periodTickets: 20,
    ticketsWithCreatedEvent: 18,
    messageEvents: 100,
    attributedMessageEvents: 84,
    unknownAuthorMessages: 8,
    missingTimestampMessages: 8,
    lifecycleEvents: 30,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.values, [GUILD, START, END, 'billing', 'urgent', 'claimed', 'refund']);
  assert.match(calls[1]?.sql ?? '', /unknown_author_messages/);
  assert.match(calls[1]?.sql ?? '', /missing_timestamp_messages/);
});
