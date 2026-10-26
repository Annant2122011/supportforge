import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAdvancedAnalyticsCsv,
  MAX_ANALYTICS_EXPORT_ROWS,
  parseAnalyticsFilters,
  type AdvancedAnalyticsReport,
} from '../src/services/advancedAnalyticsService';

const summary = {
  ticketsCreated: 12,
  activeTickets: 6,
  openTickets: 2,
  claimedTickets: 2,
  pendingTickets: 1,
  urgentOrCriticalTickets: 1,
  oldestActiveCreatedAt: '2026-10-20T08:00:00.000Z',
  firstResolvedTickets: 5,
  closeActions: 6,
  reopenedTickets: 2,
  reopenedAfterFirstClose: 1,
  firstResponseEligible: 8,
  firstResponseSamples: 7,
  avgFirstResponseMinutes: 18.5,
  avgResolutionMinutes: 87.2,
  guildId: 'guild-1',
  periodDays: 7 as const,
  periodStartAt: '2026-10-18T12:00:00.000Z',
  periodEndAt: '2026-10-25T12:00:00.000Z',
  generatedAt: '2026-10-25T12:00:00.000Z',
  reopenRatePercent: 20,
};

const comparison = (current: number | null, previous: number | null, changePercent: number | null) => ({
  current, previous, changePercent,
});

function reportFixture(overrides: Partial<AdvancedAnalyticsReport> = {}): AdvancedAnalyticsReport {
  return {
    guildId: 'guild-1',
    periodDays: 7,
    generatedAt: summary.generatedAt,
    periodStartAt: summary.periodStartAt,
    periodEndAt: summary.periodEndAt,
    previousPeriodStartAt: '2026-10-11T12:00:00.000Z',
    previousPeriodEndAt: summary.periodStartAt,
    filters: {},
    summary,
    previousSummary: { ...summary, ticketsCreated: 10 },
    comparisons: {
      ticketsCreated: comparison(12, 10, 20),
      firstResolvedTickets: comparison(5, 4, 25),
      closeActions: comparison(6, 5, 20),
      reopenedTickets: comparison(2, 2, 0),
      avgFirstResponseMinutes: comparison(18.5, 20, -7.5),
      avgResolutionMinutes: comparison(87.2, 90, -3.1),
      reopenRatePercent: comparison(20, 25, -20),
    },
    departments: [{
      departmentId: 'billing',
      departmentName: 'Billing',
      ticketsCreated: 5,
      activeTickets: 2,
      openTickets: 1,
      claimedTickets: 1,
      pendingTickets: 0,
      urgentOrCriticalTickets: 1,
      firstResolvedTickets: 2,
      reopenedTickets: 1,
      firstResponseEligible: 3,
      firstResponseSamples: 2,
      avgFirstResponseMinutes: 17.5,
      avgResolutionMinutes: 72,
      oldestActiveCreatedAt: '2026-10-20T08:00:00.000Z',
    }],
    staff: [{
      staffId: '123456789012345678',
      ticketsClaimed: 3,
      ticketsClosed: 2,
      staffReplies: 15,
      firstResponses: 2,
      activeWorkload: 1,
      avgFirstResponseMinutes: 16,
    }],
    tags: [{
      tagId: 'refund',
      tagName: 'Refund',
      ticketsCreated: 4,
      activeTickets: 2,
      firstResolvedTickets: 1,
      urgentOrCriticalTickets: 0,
    }],
    daily: [{ day: '2026-10-20', ticketsCreated: 2, firstResolvedTickets: 1 }],
    previousDaily: [{ day: '2026-10-13', ticketsCreated: 3, firstResolvedTickets: 2 }],
    coverage: {
      periodTickets: 12,
      ticketsWithCreatedEvent: 10,
      messageEvents: 60,
      attributedMessageEvents: 50,
      unknownAuthorMessages: 5,
      missingTimestampMessages: 5,
      lifecycleEvents: 18,
    },
    firstResponseCoveragePercent: 87.5,
    ...overrides,
  };
}

test('analytics filters canonicalize allowed values and omit blank filters', () => {
  assert.deepEqual(parseAnalyticsFilters({
    departmentId: ' billing ',
    tagId: '',
    priority: 'URGENT',
    status: 'ReOpened',
  }), {
    departmentId: 'billing',
    tagId: undefined,
    priority: 'urgent',
    status: 'reopened',
  });
  assert.deepEqual(parseAnalyticsFilters(), {
    departmentId: undefined,
    tagId: undefined,
    priority: undefined,
    status: undefined,
  });
});

test('analytics filters reject unsafe IDs and unsupported enum values', () => {
  assert.throws(() => parseAnalyticsFilters({ departmentId: 'billing; DROP TABLE tickets' }), /Department/);
  assert.throws(() => parseAnalyticsFilters({ tagId: 'tag with spaces' }), /Tag/);
  assert.throws(() => parseAnalyticsFilters({ priority: 'blocker' }), /Priority filter/);
  assert.throws(() => parseAnalyticsFilters({ status: 'deleted' }), /status/);
  assert.throws(() => parseAnalyticsFilters({ status: 123 }), /must be text/);
});

test('CSV export covers each analytics family and escapes commas, quotes, and newlines', () => {
  const report = reportFixture({
    departments: [{
      ...reportFixture().departments[0]!,
      departmentName: 'Billing, "Refunds"\nEscalations',
    }],
  });
  const csv = buildAdvancedAnalyticsCsv(report);
  assert.ok(csv.startsWith('record_type,period_start_utc,period_end_utc'));
  assert.match(csv, /summary/);
  assert.match(csv, /department/);
  assert.match(csv, /staff/);
  assert.match(csv, /tag/);
  assert.match(csv, /daily/);
  assert.match(csv, /"Billing, ""Refunds""\nEscalations"/);
});

test('CSV export neutralizes spreadsheet formula prefixes in user-controlled labels', () => {
  const report = reportFixture({
    departments: [{
      ...reportFixture().departments[0]!,
      departmentName: '=HYPERLINK("https://evil.example","click")',
    }],
    tags: [{
      ...reportFixture().tags[0]!,
      tagName: '+SUM(1,1)',
    }],
  });
  const csv = buildAdvancedAnalyticsCsv(report);
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes("'+SUM(1"));
});

test('CSV export refuses row counts above the hard safety limit', () => {
  const department = reportFixture().departments[0]!;
  const departments = Array.from({ length: MAX_ANALYTICS_EXPORT_ROWS }, (_, index) => ({
    ...department,
    departmentId: 'd' + index,
    departmentName: 'Department ' + index,
  }));
  assert.throws(
    () => buildAdvancedAnalyticsCsv(reportFixture({ departments })),
    /safe row limit/,
  );
});
