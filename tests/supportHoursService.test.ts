import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultSupportHoursPolicy,
  evaluateSupportHoursSchedule,
  parseSupportHoursIntervals,
  parseSupportHoursWeeklySchedule,
  resolveEffectiveSupportHoursPolicy,
  validateSupportHoursPolicy,
  validateSupportHoursSchedule,
  type SupportHoursPolicy,
  type SupportHoursWeeklySchedule,
} from '../src/services/supportHoursService';

const schedule = (overrides: Partial<SupportHoursWeeklySchedule> = {}): SupportHoursWeeklySchedule => ({
  monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [],
  ...overrides,
});

const policy = (overrides: Partial<SupportHoursPolicy> = {}): SupportHoursPolicy => ({
  id: 'guild',
  scopeType: 'guild',
  scopeId: null,
  enabled: true,
  timezone: 'UTC',
  outsideHoursBehavior: 'restrict',
  weeklySchedule: schedule({
    monday: [{ start: '09:00', end: '17:00' }],
    tuesday: [{ start: '09:00', end: '17:00' }],
  }),
  version: 1,
  updatedAt: '2026-10-19T00:00:00.000Z',
  updatedBy: null,
  ...overrides,
});

test('parses closed days, multiple intervals and overnight intervals', () => {
  assert.deepEqual(parseSupportHoursIntervals('closed'), []);
  assert.deepEqual(parseSupportHoursIntervals('09:00-12:00, 13:00-17:00'), [
    { start: '09:00', end: '12:00' },
    { start: '13:00', end: '17:00' },
  ]);
  assert.deepEqual(parseSupportHoursIntervals('22:00-02:00'), [
    { start: '22:00', end: '02:00' },
  ]);
  assert.throws(() => parseSupportHoursIntervals('9am-5pm'), /HH:mm/);
  assert.throws(() => parseSupportHoursIntervals('09:00-09:00'), /non-zero duration/);
});

test('validates time zones and interval overlap, including the next day', () => {
  const base = createDefaultSupportHoursPolicy();
  assert.throws(() => validateSupportHoursPolicy({ ...base, timezone: 'Mars/Olympus' }), /Unknown IANA time zone/);
  assert.throws(() => validateSupportHoursSchedule(schedule({
    monday: [{ start: '22:00', end: '02:00' }],
    tuesday: [{ start: '01:00', end: '03:00' }],
  })), /must not overlap/);
  assert.throws(() => validateSupportHoursSchedule(schedule({
    monday: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }],
  })), /must not overlap/);
});

test('resolves policy precedence as panel, department, then guild', () => {
  const guild = policy();
  const department = policy({ id: 'department:billing', scopeType: 'department', scopeId: 'billing' });
  const panel = policy({ id: 'panel:urgent', scopeType: 'panel', scopeId: 'urgent' });
  assert.equal(resolveEffectiveSupportHoursPolicy([guild, department, panel], {
    departmentId: 'billing', panelId: 'urgent',
  })?.id, 'panel:urgent');
  assert.equal(resolveEffectiveSupportHoursPolicy([guild, department, panel], {
    departmentId: 'billing',
  })?.id, 'department:billing');
  assert.equal(resolveEffectiveSupportHoursPolicy([guild, department, panel], {})?.id, 'guild');
  assert.equal(resolveEffectiveSupportHoursPolicy([], {}), null);
});

test('evaluates weekly boundaries and returns the next opening in the configured time zone', () => {
  const p = policy({ timezone: 'UTC' });
  const open = evaluateSupportHoursSchedule(p, new Date('2026-10-19T09:00:00.000Z'));
  assert.equal(open.isOpen, true);
  assert.equal(open.nextOpeningAt, null);

  const before = evaluateSupportHoursSchedule(p, new Date('2026-10-19T08:59:00.000Z'));
  assert.equal(before.isOpen, false);
  assert.equal(before.nextOpeningAt?.toISOString(), '2026-10-19T09:00:00.000Z');

  const closingBoundary = evaluateSupportHoursSchedule(p, new Date('2026-10-19T17:00:00.000Z'));
  assert.equal(closingBoundary.isOpen, false);
  assert.equal(closingBoundary.nextOpeningAt?.toISOString(), '2026-10-20T09:00:00.000Z');
});

test('handles a schedule interval that crosses midnight', () => {
  const p = policy({
    weeklySchedule: schedule({ monday: [{ start: '22:00', end: '02:00' }] }),
  });
  assert.equal(evaluateSupportHoursSchedule(p, new Date('2026-10-20T01:59:00.000Z')).isOpen, true);
  assert.equal(evaluateSupportHoursSchedule(p, new Date('2026-10-20T02:00:00.000Z')).isOpen, false);
  assert.equal(
    evaluateSupportHoursSchedule(p, new Date('2026-10-20T02:00:00.000Z')).nextOpeningAt?.toISOString(),
    '2026-10-26T22:00:00.000Z',
  );
});

test('handles a nonexistent spring-forward opening by moving to the first valid local minute', () => {
  const p = policy({
    timezone: 'America/New_York',
    weeklySchedule: schedule({ sunday: [{ start: '02:30', end: '03:30' }] }),
  });
  const during = evaluateSupportHoursSchedule(p, new Date('2026-03-08T07:10:00.000Z'));
  assert.equal(during.isOpen, true);
});

test('uses deterministic earlier opening and later closing when local time repeats in autumn', () => {
  const p = policy({
    timezone: 'America/New_York',
    weeklySchedule: schedule({ sunday: [{ start: '01:15', end: '01:45' }] }),
  });
  assert.equal(evaluateSupportHoursSchedule(p, new Date('2026-11-01T05:30:00.000Z')).isOpen, true);
  assert.equal(evaluateSupportHoursSchedule(p, new Date('2026-11-01T06:30:00.000Z')).isOpen, true);
});

test('parses a complete seven-day schedule and rejects missing or duplicate weekdays', () => {
  const parsed = parseSupportHoursWeeklySchedule([
    'monday=09:00-12:00,13:00-17:00',
    'tuesday=09:00-17:00',
    'wednesday=09:00-17:00',
    'thursday=09:00-17:00',
    'friday=09:00-17:00',
    'saturday=10:00-14:00',
    'sunday=closed',
  ].join('\n'));
  assert.equal(parsed.monday.length, 2);
  assert.equal(parsed.saturday[0]?.start, '10:00');
  assert.deepEqual(parsed.sunday, []);
  assert.throws(() => parseSupportHoursWeeklySchedule('monday=09:00-17:00'), /Include all seven weekdays/);
  assert.throws(() => parseSupportHoursWeeklySchedule([
    'monday=closed', 'monday=closed', 'tuesday=closed', 'wednesday=closed',
    'thursday=closed', 'friday=closed', 'saturday=closed', 'sunday=closed',
  ].join('\n')), /more than once/);
});

test('validates a normalized weekly schedule without mutating the caller object', () => {
  const original = schedule({ monday: [{ start: '09:00', end: '17:00' }] });
  const normalized = validateSupportHoursSchedule(original);
  assert.deepEqual(normalized.monday, [{ start: '09:00', end: '17:00' }]);
  assert.notEqual(normalized.monday, original.monday);
});
