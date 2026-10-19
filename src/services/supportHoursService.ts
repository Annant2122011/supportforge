import { getJsonDocument, setJsonDocument } from './jsonDocumentPersistenceService';

export const SUPPORT_HOURS_DAYS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
] as const;

export type SupportHoursDay = (typeof SUPPORT_HOURS_DAYS)[number];
export type SupportHoursScopeType = 'guild' | 'department' | 'panel';
export type OutsideHoursBehavior = 'allow' | 'restrict';

export interface SupportHoursInterval {
  start: string;
  end: string;
}

export type SupportHoursWeeklySchedule = Record<SupportHoursDay, SupportHoursInterval[]>;

export interface SupportHoursPolicy {
  id: string;
  scopeType: SupportHoursScopeType;
  scopeId: string | null;
  enabled: boolean;
  timezone: string;
  outsideHoursBehavior: OutsideHoursBehavior;
  weeklySchedule: SupportHoursWeeklySchedule;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SupportHoursPolicyInput {
  scopeType: SupportHoursScopeType;
  scopeId?: string | null;
  enabled: boolean;
  timezone: string;
  outsideHoursBehavior: OutsideHoursBehavior;
  weeklySchedule: SupportHoursWeeklySchedule;
  updatedBy?: string | null;
}

export interface SupportHoursContext {
  departmentId?: string;
  panelId?: string;
}

export interface SupportHoursDecision {
  configured: boolean;
  policyEnabled: boolean;
  isOpen: boolean;
  ticketCreationAllowed: boolean;
  timezone: string;
  outsideHoursBehavior: OutsideHoursBehavior;
  nextOpeningAt: Date | null;
  scopeType: SupportHoursScopeType | null;
  scopeId: string | null;
  policyVersion: number | null;
  reason: 'unconfigured' | 'disabled' | 'open' | 'closed-allowed' | 'closed-restricted';
}

interface SupportHoursStore {
  version: 1;
  guilds: Record<string, Record<string, SupportHoursPolicy>>;
}

const DOCUMENT_KEY = 'support-hours';
const DEFAULT_TIMEZONE = 'UTC';
let state: SupportHoursStore | null = null;
let writeQueue: Promise<void> = Promise.resolve();

const EMPTY_SCHEDULE = (): SupportHoursWeeklySchedule => ({
  monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [],
});

const DAY_INDEX: Record<SupportHoursDay, number> = {
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
};

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    FORMATTERS.set(timezone, formatter);
  }
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  weekday: SupportHoursDay;
  hour: number;
  minute: number;
}

function zonedParts(instant: Date, timezone: string): ZonedParts {
  if (!Number.isFinite(instant.getTime())) throw new Error('The reference time is invalid.');
  let parts: Record<string, string> = {};
  for (const part of formatterFor(timezone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const weekday = parts.weekday?.toLowerCase();
  if (!(SUPPORT_HOURS_DAYS as readonly string[]).includes(weekday ?? '')) {
    throw new Error('The time zone did not produce a valid weekday.');
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekday as SupportHoursDay,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function normalizeDate(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addLocalDays(year: number, month: number, day: number, count: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + count));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function localDateKey(year: number, month: number, day: number): string {
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function localMinuteOfDay(parts: ZonedParts): number {
  return parts.hour * 60 + parts.minute;
}

function parseClock(value: string, allow24 = false): number {
  const match = /^(?:([01]\d|2[0-3]):([0-5]\d)|(24:00))$/.exec(value);
  if (!match || (match[3] && !allow24)) throw new Error('Times must use HH:mm format' + (allow24 ? ', with 24:00 allowed as an interval end.' : '.'));
  return match[3] ? 1440 : Number(match[1]) * 60 + Number(match[2]);
}

function policyKey(scopeType: SupportHoursScopeType, scopeId?: string | null): string {
  if (scopeType === 'guild') return 'guild';
  const normalized = scopeId?.trim();
  if (!normalized) throw new Error('A department or panel ID is required for that support-hours scope.');
  return scopeType + ':' + normalized;
}

function getEmptyStore(): SupportHoursStore {
  return { version: 1, guilds: {} };
}

async function loadState(): Promise<SupportHoursStore> {
  if (state) return state;
  const saved = await getJsonDocument<SupportHoursStore>(DOCUMENT_KEY);
  if (saved === undefined) {
    state = getEmptyStore();
    return state;
  }
  if (!saved || typeof saved !== 'object' || saved.version !== 1 || !saved.guilds ||
      typeof saved.guilds !== 'object' || Array.isArray(saved.guilds)) {
    throw new Error('Support-hours data is malformed. Existing database data was not overwritten.');
  }
  for (const [guildId, policies] of Object.entries(saved.guilds)) {
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)) {
      throw new Error('Support-hours policies are malformed for guild ' + guildId + '.');
    }
  }
  state = saved;
  return state;
}

export async function initializeSupportHoursService(): Promise<void> {
  await loadState();
}

async function persistState(): Promise<void> {
  if (!state) return;
  const snapshot = JSON.parse(JSON.stringify(state)) as SupportHoursStore;
  writeQueue = writeQueue.catch(() => undefined).then(() => setJsonDocument(DOCUMENT_KEY, snapshot));
  await writeQueue;
}

export function createEmptySupportHoursSchedule(): SupportHoursWeeklySchedule {
  return EMPTY_SCHEDULE();
}

export function createDefaultSupportHoursPolicy(
  scopeType: SupportHoursScopeType = 'guild',
  scopeId: string | null = null,
): SupportHoursPolicyInput {
  return {
    scopeType,
    scopeId,
    enabled: false,
    timezone: DEFAULT_TIMEZONE,
    outsideHoursBehavior: 'restrict',
    weeklySchedule: EMPTY_SCHEDULE(),
    updatedBy: null,
  };
}

export function parseSupportHoursIntervals(input: string): SupportHoursInterval[] {
  const value = input.trim();
  if (!value || value.toLowerCase() === 'closed') return [];
  const pieces = value.split(',').map((part) => part.trim());
  if (pieces.length > 8) throw new Error('A day can contain at most 8 intervals.');
  const intervals: SupportHoursInterval[] = pieces.map((piece) => {
    const match = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(piece);
    if (!match) throw new Error('Use intervals such as 09:00-12:00,13:00-17:00, or type closed.');
    const start = match[1]!;
    const end = match[2]!;
    const startMinute = parseClock(start);
    const endMinute = parseClock(end, true);
    if (startMinute === endMinute || (endMinute !== 1440 && startMinute === 0 && endMinute === 0)) {
      throw new Error('An interval must have a non-zero duration.');
    }
    return { start, end };
  });
  return intervals;
}

function intervalDuration(start: number, end: number): number {
  if (end === 1440) return 1440 - start;
  return end > start ? end - start : 1440 - start + end;
}

export function validateSupportHoursSchedule(schedule: SupportHoursWeeklySchedule): SupportHoursWeeklySchedule {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new Error('A weekly schedule is required.');
  }
  const normalized = EMPTY_SCHEDULE();
  const occupied = new Uint8Array(7 * 1440);
  for (const day of SUPPORT_HOURS_DAYS) {
    const rawIntervals = (schedule as Record<string, unknown>)[day];
    if (!Array.isArray(rawIntervals) || rawIntervals.length > 8) {
      throw new Error('Each weekday must contain an interval array with at most 8 intervals.');
    }
    const intervals: SupportHoursInterval[] = [];
    for (const raw of rawIntervals) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Schedule intervals must be objects with start and end values.');
      const candidate = raw as Partial<SupportHoursInterval>;
      if (typeof candidate.start !== 'string' || typeof candidate.end !== 'string') throw new Error('Every interval needs start and end times.');
      const start = parseClock(candidate.start);
      const end = parseClock(candidate.end, true);
      if (start === end) throw new Error('An interval must have a non-zero duration.');
      intervals.push({ start: candidate.start, end: candidate.end });
      const dayStart = DAY_INDEX[day] * 1440 + start;
      const duration = intervalDuration(start, end);
      if (duration <= 0 || duration > 1440) throw new Error('Interval duration must be greater than 0 and at most 24 hours.');
      for (let minute = 0; minute < duration; minute += 1) {
        const slot = (dayStart + minute) % (7 * 1440);
        if (occupied[slot]) throw new Error('Support-hours intervals must not overlap, including across midnight.');
        occupied[slot] = 1;
      }
    }
    intervals.sort((a, b) => parseClock(a.start) - parseClock(b.start));
    normalized[day] = intervals;
  }
  return normalized;
}

export function validateSupportHoursPolicy(input: SupportHoursPolicyInput): SupportHoursPolicyInput {
  if (!input || typeof input !== 'object') throw new Error('A support-hours policy is required.');
  if (input.scopeType !== 'guild' && input.scopeType !== 'department' && input.scopeType !== 'panel') {
    throw new Error('Support-hours scope must be guild, department, or panel.');
  }
  if (input.scopeType === 'guild' && input.scopeId != null && input.scopeId !== '') {
    throw new Error('The guild-wide support-hours scope does not take a scope ID.');
  }
  if (input.scopeType !== 'guild' && !input.scopeId?.trim()) {
    throw new Error('A department or panel ID is required for that scope.');
  }
  if (typeof input.enabled !== 'boolean') throw new Error('Support-hours enabled must be a boolean.');
  if (input.outsideHoursBehavior !== 'allow' && input.outsideHoursBehavior !== 'restrict') {
    throw new Error('Outside-hours behavior must be allow or restrict.');
  }
  if (typeof input.timezone !== 'string' || input.timezone.length > 100 || !input.timezone.trim()) {
    throw new Error('Enter a valid IANA time zone such as Asia/Kolkata.');
  }
  try {
    formatterFor(input.timezone.trim()).format(new Date());
  } catch {
    throw new Error('Unknown IANA time zone: ' + input.timezone);
  }
  return {
    scopeType: input.scopeType,
    scopeId: input.scopeType === 'guild' ? null : input.scopeId!.trim(),
    enabled: input.enabled,
    timezone: input.timezone.trim(),
    outsideHoursBehavior: input.outsideHoursBehavior,
    weeklySchedule: validateSupportHoursSchedule(input.weeklySchedule),
    updatedBy: input.updatedBy ?? null,
  };
}

export async function getSupportHoursPolicies(guildId: string): Promise<SupportHoursPolicy[]> {
  const current = await loadState();
  const policies = Object.values(current.guilds[guildId] ?? {});
  return JSON.parse(JSON.stringify(policies)) as SupportHoursPolicy[];
}

export async function getSupportHoursPolicy(
  guildId: string,
  scopeType: SupportHoursScopeType,
  scopeId?: string | null,
): Promise<SupportHoursPolicy | null> {
  const current = await loadState();
  const policy = current.guilds[guildId]?.[policyKey(scopeType, scopeId)];
  return policy ? JSON.parse(JSON.stringify(policy)) as SupportHoursPolicy : null;
}

export async function saveSupportHoursPolicy(
  guildId: string,
  input: SupportHoursPolicyInput,
): Promise<SupportHoursPolicy> {
  const normalized = validateSupportHoursPolicy(input);
  const current = await loadState();
  current.guilds[guildId] ??= {};
  const key = policyKey(normalized.scopeType, normalized.scopeId);
  const previous = current.guilds[guildId][key];
  const policy: SupportHoursPolicy = {
    ...normalized,
    id: previous?.id ?? key,
    scopeId: normalized.scopeId,
    version: (previous?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  current.guilds[guildId][key] = policy;
  await persistState();
  return JSON.parse(JSON.stringify(policy)) as SupportHoursPolicy;
}

export async function deleteSupportHoursPolicy(
  guildId: string,
  scopeType: SupportHoursScopeType,
  scopeId?: string | null,
): Promise<boolean> {
  const current = await loadState();
  const key = policyKey(scopeType, scopeId);
  const policies = current.guilds[guildId];
  if (!policies || !policies[key]) return false;
  delete policies[key];
  if (!Object.keys(policies).length) delete current.guilds[guildId];
  await persistState();
  return true;
}

export function resolveEffectiveSupportHoursPolicy(
  policies: readonly SupportHoursPolicy[],
  context: SupportHoursContext = {},
): SupportHoursPolicy | null {
  const find = (type: SupportHoursScopeType, id?: string | null) =>
    policies.find((policy) => policy.scopeType === type &&
      (type === 'guild' ? true : policy.scopeId === id)) ?? null;
  return find('panel', context.panelId) ??
    find('department', context.departmentId) ??
    find('guild');
}

function offsetMinutesAt(instantMs: number, timezone: string): number {
  const rounded = Math.floor(instantMs / 60_000) * 60_000;
  const parts = zonedParts(new Date(rounded), timezone);
  const wallClockMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return (wallClockMs - rounded) / 60_000;
}

function localMinuteToInstant(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timezone: string,
  preferLater = false,
): Date {
  let targetYear = year;
  let targetMonth = month;
  let targetDay = day;
  let targetMinute = minuteOfDay;
  if (targetMinute >= 1440) {
    const normalized = addLocalDays(targetYear, targetMonth, targetDay, Math.floor(targetMinute / 1440));
    targetYear = normalized.year; targetMonth = normalized.month; targetDay = normalized.day;
    targetMinute %= 1440;
  }
  const base = Date.UTC(targetYear, targetMonth - 1, targetDay, Math.floor(targetMinute / 60), targetMinute % 60);
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) offsets.add(offsetMinutesAt(base + hours * 3_600_000, timezone));
  const candidates: number[] = [];
  for (const offset of offsets) {
    const candidate = base - offset * 60_000;
    const parts = zonedParts(new Date(candidate), timezone);
    if (parts.year === targetYear && parts.month === targetMonth && parts.day === targetDay &&
        localMinuteOfDay(parts) === targetMinute) candidates.push(candidate);
  }
  if (candidates.length) return new Date(preferLater ? Math.max(...candidates) : Math.min(...candidates));

  // DST can remove a local wall-clock time. Resolve a nonexistent opening
  // to the first real minute on the same local date after the scheduled time.
  let fallback: number | null = null;
  for (let offset = -4 * 60; offset <= 4 * 60; offset += 1) {
    const candidate = base + offset * 60_000;
    const parts = zonedParts(new Date(candidate), timezone);
    if (parts.year === targetYear && parts.month === targetMonth && parts.day === targetDay &&
        localMinuteOfDay(parts) >= targetMinute) {
      if (fallback === null || candidate < fallback) fallback = candidate;
    }
  }
  if (fallback !== null) return new Date(fallback);
  throw new Error('Could not resolve a scheduled local time in time zone ' + timezone + '.');
}

function intervalInstants(
  year: number,
  month: number,
  day: number,
  interval: SupportHoursInterval,
  timezone: string,
): { start: Date; end: Date } {
  const startMinute = parseClock(interval.start);
  const endMinute = parseClock(interval.end, true);
  const endDateOffset = endMinute === 1440 || endMinute <= startMinute ? 1 : 0;
  const endDate = addLocalDays(year, month, day, endDateOffset);
  return {
    start: localMinuteToInstant(year, month, day, startMinute, timezone),
    end: localMinuteToInstant(endDate.year, endDate.month, endDate.day, endMinute === 1440 ? 0 : endMinute, timezone, true),
  };
}

export function evaluateSupportHoursSchedule(
  policy: Pick<SupportHoursPolicy, 'timezone' | 'weeklySchedule'>,
  now = new Date(),
): { isOpen: boolean; nextOpeningAt: Date | null } {
  const timezone = policy.timezone;
  const normalizedSchedule = validateSupportHoursSchedule(policy.weeklySchedule);
  const localNow = zonedParts(now, timezone);
  const previousDayDate = addLocalDays(localNow.year, localNow.month, localNow.day, -1);
  const previousWeekdayIndex = (DAY_INDEX[localNow.weekday] + 6) % 7;
  const dayAndIndex = [
    { date: previousDayDate, day: SUPPORT_HOURS_DAYS[previousWeekdayIndex]! },
    { date: { year: localNow.year, month: localNow.month, day: localNow.day }, day: localNow.weekday },
  ];

  for (const item of dayAndIndex) {
    for (const interval of normalizedSchedule[item.day]) {
      const span = intervalInstants(item.date.year, item.date.month, item.date.day, interval, timezone);
      if (span.start.getTime() <= now.getTime() && now.getTime() < span.end.getTime()) {
        return { isOpen: true, nextOpeningAt: null };
      }
    }
  }

  const candidates: Date[] = [];
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = addLocalDays(localNow.year, localNow.month, localNow.day, offset);
    const day = SUPPORT_HOURS_DAYS[(DAY_INDEX[localNow.weekday] + offset) % 7]!;
    for (const interval of normalizedSchedule[day]) {
      const span = intervalInstants(date.year, date.month, date.day, interval, timezone);
      if (span.start.getTime() > now.getTime()) candidates.push(span.start);
    }
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return { isOpen: false, nextOpeningAt: candidates[0] ?? null };
}

export async function evaluateSupportHours(
  guildId: string,
  context: SupportHoursContext = {},
  now = new Date(),
): Promise<SupportHoursDecision> {
  const policies = await getSupportHoursPolicies(guildId);
  const policy = resolveEffectiveSupportHoursPolicy(policies, context);
  if (!policy) {
    return {
      configured: false, policyEnabled: false, isOpen: true, ticketCreationAllowed: true,
      timezone: DEFAULT_TIMEZONE, outsideHoursBehavior: 'allow', nextOpeningAt: null,
      scopeType: null, scopeId: null, policyVersion: null, reason: 'unconfigured',
    };
  }
  if (!policy.enabled) {
    return {
      configured: true, policyEnabled: false, isOpen: true, ticketCreationAllowed: true,
      timezone: policy.timezone, outsideHoursBehavior: policy.outsideHoursBehavior, nextOpeningAt: null,
      scopeType: policy.scopeType, scopeId: policy.scopeId, policyVersion: policy.version, reason: 'disabled',
    };
  }
  const schedule = evaluateSupportHoursSchedule(policy, now);
  const ticketCreationAllowed = schedule.isOpen || policy.outsideHoursBehavior === 'allow';
  return {
    configured: true,
    policyEnabled: true,
    isOpen: schedule.isOpen,
    ticketCreationAllowed,
    timezone: policy.timezone,
    outsideHoursBehavior: policy.outsideHoursBehavior,
    nextOpeningAt: schedule.nextOpeningAt,
    scopeType: policy.scopeType,
    scopeId: policy.scopeId,
    policyVersion: policy.version,
    reason: schedule.isOpen ? 'open' : ticketCreationAllowed ? 'closed-allowed' : 'closed-restricted',
  };
}

export function formatSupportHoursInstant(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h12',
    timeZoneName: 'short',
  }).format(instant);
}
