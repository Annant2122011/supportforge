import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateSlaTarget, isValidSlaScope, type SlaLifecycleEvent } from '../src/core/domain/supportSla';

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
  assert.equal(evaluateSlaTarget(input({ observedAt: '2026-10-23T10:45:00.000Z' })).progress, 'warning');
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
    currentStatus: 'open',
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

test('invalid dates and scopes are handled safely', () => {
  assert.equal(evaluateSlaTarget(input({ startedAt: 'not-a-date' })).elapsedMinutes, 0);
  assert.equal(isValidSlaScope('*', '*'), true);
  assert.equal(isValidSlaScope('billing_department', 'critical'), true);
  assert.equal(isValidSlaScope('department with spaces', '*'), false);
  assert.equal(isValidSlaScope('*', 'dangerous-sql'), false);
});
