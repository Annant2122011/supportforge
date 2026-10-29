import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateBusinessElapsedMinutes } from '../src/core/domain/supportBusinessTime';
import type { SupportHoursWeeklySchedule } from '../src/services/supportHoursService';

const emptySchedule = (): SupportHoursWeeklySchedule => ({
  monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [],
});

test('business-time clock counts only support-hour overlaps across weekends', () => {
  const weeklySchedule = emptySchedule();
  weeklySchedule.monday = [{ start: '09:00', end: '17:00' }];
  weeklySchedule.tuesday = [{ start: '09:00', end: '17:00' }];
  weeklySchedule.wednesday = [{ start: '09:00', end: '17:00' }];
  weeklySchedule.thursday = [{ start: '09:00', end: '17:00' }];
  weeklySchedule.friday = [{ start: '09:00', end: '17:00' }];

  const result = calculateBusinessElapsedMinutes(
    '2026-10-23T16:00:00.000Z',
    '2026-10-26T10:00:00.000Z',
    { timezone: 'UTC', weeklySchedule },
  );
  assert.deepEqual(result, { elapsedMinutes: 120, pausedMinutes: 0 });
});

test('pending pauses subtract only scheduled minutes, not an entire wall-clock interval', () => {
  const weeklySchedule = emptySchedule();
  weeklySchedule.friday = [{ start: '09:00', end: '17:00' }];
  weeklySchedule.monday = [{ start: '09:00', end: '17:00' }];

  const result = calculateBusinessElapsedMinutes(
    '2026-10-23T16:00:00.000Z',
    '2026-10-26T10:00:00.000Z',
    { timezone: 'UTC', weeklySchedule },
    [{ startAt: '2026-10-23T16:30:00.000Z', endAt: '2026-10-26T09:30:00.000Z' }],
  );
  assert.deepEqual(result, { elapsedMinutes: 60, pausedMinutes: 60 });
});

test('business-time intervals follow the same DST boundaries as support hours', () => {
  const weeklySchedule = emptySchedule();
  weeklySchedule.sunday = [{ start: '01:00', end: '04:00' }];
  const springForward = calculateBusinessElapsedMinutes(
    '2026-03-08T06:00:00.000Z',
    '2026-03-08T08:00:00.000Z',
    { timezone: 'America/New_York', weeklySchedule },
  );
  assert.equal(springForward.elapsedMinutes, 120);

  weeklySchedule.sunday = [{ start: '01:00', end: '02:00' }];
  const fallBack = calculateBusinessElapsedMinutes(
    '2026-11-01T05:00:00.000Z',
    '2026-11-01T07:00:00.000Z',
    { timezone: 'America/New_York', weeklySchedule },
  );
  assert.equal(fallBack.elapsedMinutes, 120);
});

test('invalid timezone or timestamp fails visibly instead of manufacturing a zero SLA duration', () => {
  const weeklySchedule = emptySchedule();
  assert.throws(() => calculateBusinessElapsedMinutes(
    'not-a-date',
    '2026-10-26T10:00:00.000Z',
    { timezone: 'UTC', weeklySchedule },
  ));
  assert.throws(() => calculateBusinessElapsedMinutes(
    '2026-10-26T09:00:00.000Z',
    '2026-10-26T10:00:00.000Z',
    { timezone: 'Not/A_Timezone', weeklySchedule },
  ));
});
