import type { SupportHoursWeeklySchedule } from '../../services/supportHoursService';
import { getSupportHoursIntervalInstants, SUPPORT_HOURS_DAYS } from '../../services/supportHoursService';

export interface BusinessPauseInterval {
  startAt: string;
  endAt: string;
}

export interface BusinessTimePolicy {
  timezone: string;
  weeklySchedule: SupportHoursWeeklySchedule;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const WEEKDAY_KEYS = new Map<string, (typeof SUPPORT_HOURS_DAYS)[number]>([
  ['Monday', 'monday'],
  ['Tuesday', 'tuesday'],
  ['Wednesday', 'wednesday'],
  ['Thursday', 'thursday'],
  ['Friday', 'friday'],
  ['Saturday', 'saturday'],
  ['Sunday', 'sunday'],
]);

function localParts(instant: Date, timezone: string): { year: number; month: number; day: number; weekday: (typeof SUPPORT_HOURS_DAYS)[number] } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'long',
  }).formatToParts(instant);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const year = Number(read('year'));
  const month = Number(read('month'));
  const day = Number(read('day'));
  const weekday = WEEKDAY_KEYS.get(read('weekday'));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || !weekday) {
    throw new Error('Could not resolve a local calendar date for time zone ' + timezone + '.');
  }
  return { year, month, day, weekday };
}

function calendarDate(year: number, month: number, day: number, offset: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function instantMs(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(label + ' must be a valid timestamp.');
  return parsed;
}

/**
 * Count scheduled business minutes between two instants. Intervals are resolved
 * by the same timezone/DST engine as ticket admission, so repeated local times
 * are counted as real elapsed time and skipped local times contribute no time.
 * A one-day look-behind includes overnight intervals that cross the start.
 */
export function calculateBusinessElapsedMinutes(
  startedAt: string,
  endedAt: string,
  policy: BusinessTimePolicy,
  pauses: readonly BusinessPauseInterval[] = [],
): { elapsedMinutes: number; pausedMinutes: number } {
  const startMs = instantMs(startedAt, 'Business-time start');
  const endMs = instantMs(endedAt, 'Business-time end');
  if (endMs < startMs) throw new Error('Business-time end cannot precede its start.');
  if (endMs === startMs) return { elapsedMinutes: 0, pausedMinutes: 0 };

  // Validate the timezone before scanning a possibly long interval.
  const first = localParts(new Date(startMs), policy.timezone);
  const last = localParts(new Date(endMs), policy.timezone);
  const startDate = calendarDate(first.year, first.month, first.day, -1);
  const endDate = calendarDate(last.year, last.month, last.day, 1);
  const totalDays = Math.floor((Date.UTC(endDate.year, endDate.month - 1, endDate.day) -
    Date.UTC(startDate.year, startDate.month - 1, startDate.day)) / DAY_MS);
  if (totalDays > 10000) {
    throw new Error('Business-time SLA evaluation is limited to a 10,000-day history window.');
  }

  const safePauses = pauses.map((pause) => {
    const pauseStart = Math.max(startMs, instantMs(pause.startAt, 'Pause start'));
    const pauseEnd = Math.min(endMs, instantMs(pause.endAt, 'Pause end'));
    return pauseEnd > pauseStart ? { startMs: pauseStart, endMs: pauseEnd } : null;
  }).filter((pause): pause is { startMs: number; endMs: number } => pause !== null);

  let scheduledMs = 0;
  let pausedScheduledMs = 0;
  for (let offset = 0; offset <= totalDays; offset += 1) {
    const date = calendarDate(startDate.year, startDate.month, startDate.day, offset);
    const weekday = localParts(new Date(Date.UTC(date.year, date.month - 1, date.day, 12)), 'UTC').weekday;
    const intervals = policy.weeklySchedule[weekday];
    for (const interval of intervals) {
      const span = getSupportHoursIntervalInstants(date.year, date.month, date.day, interval, policy.timezone);
      const overlapStart = Math.max(startMs, span.start.getTime());
      const overlapEnd = Math.min(endMs, span.end.getTime());
      if (overlapEnd <= overlapStart) continue;
      const overlap = overlapEnd - overlapStart;
      scheduledMs += overlap;
      for (const pause of safePauses) {
        pausedScheduledMs += Math.max(
          0,
          Math.min(overlapEnd, pause.endMs) - Math.max(overlapStart, pause.startMs),
        );
      }
    }
  }

  const safeElapsed = Math.max(0, scheduledMs - pausedScheduledMs);
  return {
    elapsedMinutes: Math.floor(safeElapsed / MINUTE_MS),
    pausedMinutes: Math.floor(Math.max(0, pausedScheduledMs) / MINUTE_MS),
  };
}
