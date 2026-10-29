import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateSlaTarget, findFirstClaimAt, findFirstResolutionAt, isValidSlaScope, type SlaLifecycleEvent } from '../src/core/domain/supportSla';
import type { SupportHoursWeeklySchedule } from '../src/services/supportHoursService';

const start = '2026-10-23T10:00:00.000Z';

function events(...values: Array<[string, string, Record<string, unknown>?]>): SlaLifecycleEvent[] {
  return values.map(([type, occurredAt, payload]) => ({ type, occurredAt, payload }));
}

function input(overrides: Partial<Parameters<typeof evaluateSlaTarget>[0]> = {}) {
  return {
    startedAt: start,
    observedAt: '2026-10-23T11:00:00.000Z',
    currentStatus: 'open',
    targetMinutes: 60,
    warningRatio: 0.8,
    pauseWhilePending: true,
    events: [] as SlaLifecycleEvent[],
    ...overrides,
  };
}

test('SLA elapsed clock enters warning then breach deterministically', () => {
  assert.equal(evaluateSlaTarget(input({ observedAt: '2026-10-23T10:50:00.000Z' })).progress, 'warning');
  const late = evaluateSlaTarget(input({ observedAt: '2026-10-23T11:01:00.000Z' }));
  assert.equal(late.progress, 'breached');
  assert.equal(late.elapsedMinutes, 61);
  assert.equal(late.remainingMinutes, 0);
});

test('pending time is excluded from SLA elapsed time and pending clock is labelled paused', () => {
  const lifecycle = events(
    ['ticket.pending', '2026-10-23T10:20:00.000Z'],
  );
  const paused = evaluateSlaTarget(input({
    observedAt: '2026-10-23T11:00:00.000Z',
    currentStatus: 'pending',
    targetMinutes: 60,
    events: lifecycle,
  }));
  assert.equal(paused.progress, 'paused');
  assert.equal(paused.elapsedMinutes, 20);
  assert.equal(paused.pausedMinutes, 40);

  const resumed = evaluateSlaTarget(input({
    observedAt: '2026-10-23T11:10:00.000Z',
    events: events(
      ['ticket.pending', '2026-10-23T10:20:00.000Z'],
      ['ticket.resumed', '2026-10-23T11:00:00.000Z'],
    ),
  }));
  assert.equal(resumed.elapsedMinutes, 30);
  assert.equal(resumed.pausedMinutes, 40);
  assert.equal(resumed.progress, 'running');
});

test('resolution SLA clock resets at the latest reopen and then pauses on pending', () => {
  const result = evaluateSlaTarget(input({
    clockKind: 'resolution',
    currentStatus: 'pending',
    startedAt: start,
    observedAt: '2026-10-23T12:00:00.000Z',
    targetMinutes: 45,
    events: events(
      ['ticket.closed', '2026-10-23T10:20:00.000Z'],
      ['ticket.reopened', '2026-10-23T11:30:00.000Z'],
      ['ticket.pending', '2026-10-23T11:45:00.000Z'],
    ),
  }));
  assert.equal(result.startedAt, '2026-10-23T11:30:00.000Z');
  assert.equal(result.elapsedMinutes, 15);
  assert.equal(result.pausedMinutes, 15);
  assert.equal(result.progress, 'paused');
});

test('claim SLA uses the first valid persisted claim transition and completes at that timestamp', () => {
  const lifecycle = events(
    ['ticket.status_changed', '2026-10-23T09:59:00.000Z', { from: 'open', to: 'claimed' }],
    ['ticket.status_changed', '2026-10-23T10:18:00.000Z', { from: 'open', to: 'claimed' }],
    ['ticket.status_changed', '2026-10-23T10:25:00.000Z', { from: 'open', to: 'claimed' }],
  );
  const claimedAt = findFirstClaimAt(lifecycle, start);
  assert.equal(claimedAt, '2026-10-23T10:18:00.000Z');
  const completed = evaluateSlaTarget(input({
    clockKind: 'claim',
    completedAt: claimedAt,
    observedAt: '2026-10-23T11:00:00.000Z',
    targetMinutes: 30,
    events: lifecycle,
  }));
  assert.equal(completed.progress, 'met');
  assert.equal(completed.elapsedMinutes, 18);
  assert.equal(completed.remainingMinutes, 12);

  const overdue = evaluateSlaTarget(input({
    clockKind: 'claim',
    observedAt: '2026-10-23T10:31:00.000Z',
    targetMinutes: 30,
  }));
  assert.equal(overdue.progress, 'breached');
  assert.equal(overdue.elapsedMinutes, 31);
  assert.equal(findFirstClaimAt(events(['ticket.status_changed', '2026-10-23T10:10:00.000Z', { to: 'open' }]), start), null);
});

test('resolution completion recognizes durable status-change payloads and isolates reopen cycles', () => {
  const lifecycle = events(
    ['ticket.status_changed', '2026-10-23T10:20:00.000Z', { from: 'open', to: 'closed' }],
    ['ticket.status_changed', '2026-10-23T10:30:00.000Z', { from: 'closed', to: 'reopened' }],
    ['ticket.status_changed', '2026-10-23T10:45:00.000Z', { from: 'reopened', to: 'closed' }],
    ['ticket.status_changed', '2026-10-23T10:50:00.000Z', { from: 'closed', to: 'archived' }],
  );
  assert.equal(findFirstResolutionAt(lifecycle, start), '2026-10-23T10:20:00.000Z');
  assert.equal(findFirstResolutionAt(lifecycle, '2026-10-23T10:30:00.000Z'), '2026-10-23T10:45:00.000Z');
  assert.equal(findFirstResolutionAt(events(['ticket.status_changed', '2026-10-23T10:45:00.000Z', { to: 'pending' }]), start), null);
});

test('business-hours SLA excludes nights and weekends and subtracts only scheduled pending minutes', () => {
  const weeklySchedule: SupportHoursWeeklySchedule = {
    monday: [{ start: '09:00', end: '17:00' }],
    tuesday: [{ start: '09:00', end: '17:00' }],
    wednesday: [{ start: '09:00', end: '17:00' }],
    thursday: [{ start: '09:00', end: '17:00' }],
    friday: [{ start: '09:00', end: '17:00' }],
    saturday: [],
    sunday: [],
  };
  const businessTime = { timezone: 'UTC', weeklySchedule };
  const result = evaluateSlaTarget(input({
    startedAt: '2026-10-23T16:00:00.000Z',
    observedAt: '2026-10-26T10:00:00.000Z',
    targetMinutes: 180,
    pauseWhilePending: true,
    businessTime,
    events: events(
      ['ticket.pending', '2026-10-23T16:30:00.000Z'],
      ['ticket.resumed', '2026-10-26T09:30:00.000Z'],
    ),
  }));
  assert.equal(result.elapsedMinutes, 60);
  assert.equal(result.pausedMinutes, 60);
  assert.equal(result.progress, 'running');
});

test('business-hours SLA keeps exact threshold semantics', () => {
  const weeklySchedule: SupportHoursWeeklySchedule = {
    monday: [{ start: '09:00', end: '17:00' }],
    tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [],
  };
  const businessTime = { timezone: 'UTC', weeklySchedule };
  const atWarning = evaluateSlaTarget(input({
    startedAt: '2026-10-26T09:00:00.000Z',
    observedAt: '2026-10-26T09:48:00.000Z',
    targetMinutes: 60,
    warningRatio: 0.8,
    businessTime,
  }));
  assert.equal(atWarning.progress, 'warning');
  const atDeadline = evaluateSlaTarget(input({
    startedAt: '2026-10-26T09:00:00.000Z',
    observedAt: '2026-10-26T10:00:00.000Z',
    targetMinutes: 60,
    businessTime,
  }));
  assert.equal(atDeadline.progress, 'breached');
});

test('invalid dates and scopes are handled safely', () => {
  assert.equal(evaluateSlaTarget(input({ startedAt: 'not-a-date' })).elapsedMinutes, 0);
  assert.equal(isValidSlaScope('*', '*'), true);
  assert.equal(isValidSlaScope('billing_department', 'critical'), true);
  assert.equal(isValidSlaScope('department with spaces', '*'), false);
  assert.equal(isValidSlaScope('*', 'dangerous-sql'), false);
});
