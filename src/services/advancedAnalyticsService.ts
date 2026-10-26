import {
  PostgresAnalyticsRepository,
  type AnalyticsFilters,
  type AnalyticsFilterPriority,
  type AnalyticsFilterStatus,
} from '../repositories/postgresAnalyticsRepository';
import {
  PostgresAdvancedAnalyticsRepository,
  type AnalyticsDataCoverage,
  type DailyAnalytics,
  type DepartmentAnalytics,
  type StaffAnalytics,
  type TagAnalytics,
} from '../repositories/postgresAdvancedAnalyticsRepository';
import {
  getGuildAnalyticsSummary,
  ANALYTICS_PERIODS,
  type AnalyticsPeriodDays,
  type GuildAnalyticsSummary,
} from './analyticsService';
import { getGuildConfig } from './configService';
import { getAdvancedSettings } from './advancedSettingsService';

export const MAX_ANALYTICS_EXPORT_CHARACTERS = 1_000_000;
export const MAX_ANALYTICS_EXPORT_ROWS = 2_000;

export interface AnalyticsComparison {
  current: number | null;
  previous: number | null;
  changePercent: number | null;
}

export interface AdvancedAnalyticsComparisons {
  ticketsCreated: AnalyticsComparison;
  firstResolvedTickets: AnalyticsComparison;
  closeActions: AnalyticsComparison;
  reopenedTickets: AnalyticsComparison;
  avgFirstResponseMinutes: AnalyticsComparison;
  avgResolutionMinutes: AnalyticsComparison;
  reopenRatePercent: AnalyticsComparison;
}

export interface NamedDepartmentAnalytics extends DepartmentAnalytics {
  departmentName: string;
}

export interface NamedTagAnalytics extends TagAnalytics {
  tagName: string;
}

export interface AdvancedAnalyticsReport {
  guildId: string;
  periodDays: AnalyticsPeriodDays;
  generatedAt: string;
  periodStartAt: string;
  periodEndAt: string;
  previousPeriodStartAt: string;
  previousPeriodEndAt: string;
  filters: AnalyticsFilters;
  summary: GuildAnalyticsSummary;
  previousSummary: GuildAnalyticsSummary;
  comparisons: AdvancedAnalyticsComparisons;
  departments: NamedDepartmentAnalytics[];
  staff: StaffAnalytics[];
  tags: NamedTagAnalytics[];
  daily: DailyAnalytics[];
  previousDaily: DailyAnalytics[];
  coverage: AnalyticsDataCoverage;
  firstResponseCoveragePercent: number | null;
}

export interface AdvancedAnalyticsDependencies {
  rollupRepository: PostgresAnalyticsRepository;
  detailRepository: PostgresAdvancedAnalyticsRepository;
}

function isPeriod(value: number): value is AnalyticsPeriodDays {
  return (ANALYTICS_PERIODS as readonly number[]).includes(value);
}

function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(label + ' must be a string ID.');
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > 64 || !/^[A-Za-z0-9_-]{1,64}$/.test(normalized)) {
    throw new Error(label + ' must contain 1–64 letters, numbers, underscores or hyphens.');
  }
  return normalized;
}

/** Validate all filters server-side before they become SQL parameter values. */
export function parseAnalyticsFilters(input: {
  departmentId?: unknown;
  tagId?: unknown;
  priority?: unknown;
  status?: unknown;
} = {}): AnalyticsFilters {
  const departmentId = optionalId(input.departmentId, 'Department');
  const tagId = optionalId(input.tagId, 'Tag');
  let priority: AnalyticsFilterPriority | undefined;
  let status: AnalyticsFilterStatus | undefined;

  if (input.priority !== undefined && input.priority !== null && input.priority !== '') {
    if (typeof input.priority !== 'string') throw new Error('Priority filter must be text.');
    const value = input.priority.trim().toLowerCase();
    if (!['low', 'normal', 'high', 'urgent', 'critical'].includes(value)) {
      throw new Error('Priority filter must be low, normal, high, urgent or critical.');
    }
    priority = value as AnalyticsFilterPriority;
  }

  if (input.status !== undefined && input.status !== null && input.status !== '') {
    if (typeof input.status !== 'string') throw new Error('Status filter must be text.');
    const value = input.status.trim().toLowerCase();
    if (!['open', 'claimed', 'pending', 'reopened', 'closed', 'archived'].includes(value)) {
      throw new Error('Status filter is not a supported ticket status.');
    }
    status = value as AnalyticsFilterStatus;
  }

  return { departmentId, tagId, priority, status };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function comparison(current: number | null, previous: number | null): AnalyticsComparison {
  if (current === null || previous === null || previous === 0) {
    return { current, previous, changePercent: null };
  }
  return { current, previous, changePercent: round(((current - previous) / Math.abs(previous)) * 100) };
}

export async function getAdvancedAnalyticsReport(
  guildId: string,
  periodDays: AnalyticsPeriodDays,
  rawFilters: AnalyticsFilters = {},
  now = new Date(),
  dependencies?: Partial<AdvancedAnalyticsDependencies>,
): Promise<AdvancedAnalyticsReport> {
  if (!guildId.trim()) throw new Error('A guild ID is required to generate analytics.');
  if (!isPeriod(periodDays)) throw new Error('Analytics period must be 7, 30 or 90 days.');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Analytics report time must be a valid date.');

  const filters = parseAnalyticsFilters(rawFilters);
  const rollups = dependencies?.rollupRepository ?? new PostgresAnalyticsRepository();
  const details = dependencies?.detailRepository ?? new PostgresAdvancedAnalyticsRepository();
  const periodEnd = new Date(now.getTime());
  const periodStart = new Date(periodEnd.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const previousPeriodEnd = new Date(periodStart.getTime());
  const previousPeriodStart = new Date(previousPeriodEnd.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const startAt = periodStart.toISOString();
  const endAt = periodEnd.toISOString();
  const previousStartAt = previousPeriodStart.toISOString();
  const previousEndAt = previousPeriodEnd.toISOString();

  const [summary, previousSummary, departments, staff, tags, daily, previousDaily, coverage, guildConfig, advancedSettings] = await Promise.all([
    getGuildAnalyticsSummary(guildId, periodDays, periodEnd, rollups, filters),
    getGuildAnalyticsSummary(guildId, periodDays, previousPeriodEnd, rollups, filters),
    details.getDepartmentBreakdown(guildId, startAt, endAt, filters),
    details.getStaffBreakdown(guildId, startAt, endAt, filters),
    details.getTagBreakdown(guildId, startAt, endAt, filters),
    details.getDailyTrends(guildId, startAt, endAt, filters),
    details.getDailyTrends(guildId, previousStartAt, previousEndAt, filters),
    details.getDataCoverage(guildId, startAt, endAt, filters),
    getGuildConfig(guildId),
    getAdvancedSettings(guildId),
  ]);

  const departmentNames = guildConfig.departments;
  const tagNames = new Map<string, string>();
  for (const [id, tag] of Object.entries(advancedSettings.customTags)) tagNames.set(id, tag.name);
  for (const department of Object.values(departmentNames)) {
    for (const [id, tag] of Object.entries(department.tags ?? {})) tagNames.set(id, tag.name);
  }

  const namedDepartments = departments.map((item) => ({
    ...item,
    departmentName: item.departmentId === null
      ? 'Unassigned'
      : departmentNames[item.departmentId]?.name ?? 'Unknown department (' + item.departmentId + ')',
  }));
  const namedTags = tags.map((item) => ({
    ...item,
    tagName: item.tagId === null ? 'Untagged' : tagNames.get(item.tagId) ?? 'Unknown tag (' + item.tagId + ')',
  }));

  const comparisons: AdvancedAnalyticsComparisons = {
    ticketsCreated: comparison(summary.ticketsCreated, previousSummary.ticketsCreated),
    firstResolvedTickets: comparison(summary.firstResolvedTickets, previousSummary.firstResolvedTickets),
    closeActions: comparison(summary.closeActions, previousSummary.closeActions),
    reopenedTickets: comparison(summary.reopenedTickets, previousSummary.reopenedTickets),
    avgFirstResponseMinutes: comparison(summary.avgFirstResponseMinutes, previousSummary.avgFirstResponseMinutes),
    avgResolutionMinutes: comparison(summary.avgResolutionMinutes, previousSummary.avgResolutionMinutes),
    reopenRatePercent: comparison(summary.reopenRatePercent, previousSummary.reopenRatePercent),
  };

  return {
    guildId,
    periodDays,
    generatedAt: periodEnd.toISOString(),
    periodStartAt: startAt,
    periodEndAt: endAt,
    previousPeriodStartAt: previousStartAt,
    previousPeriodEndAt: previousEndAt,
    filters,
    summary,
    previousSummary,
    comparisons,
    departments: namedDepartments,
    staff,
    tags: namedTags,
    daily,
    previousDaily,
    coverage,
    firstResponseCoveragePercent: summary.firstResponseEligible > 0
      ? round((summary.firstResponseSamples / summary.firstResponseEligible) * 100)
      : null,
  };
}

function safeCsvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[\t\r\n ]*[=+\-@]/.test(text)) text = "'" + text;
  if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

const CSV_COLUMNS = [
  'record_type', 'period_start_utc', 'period_end_utc', 'entity_id', 'entity_name',
  'tickets_created', 'active_tickets', 'open_tickets', 'claimed_tickets', 'pending_tickets',
  'urgent_or_critical_tickets', 'first_resolved_tickets', 'close_actions', 'reopened_tickets',
  'first_response_eligible', 'first_response_samples', 'avg_first_response_minutes',
  'avg_resolution_minutes', 'tickets_claimed', 'tickets_closed', 'staff_replies',
  'first_responses', 'active_workload', 'tag_id', 'day',
] as const;

/** Formula-neutralized, bounded CSV containing summary, department, staff, tag and trend rows. */
export function buildAdvancedAnalyticsCsv(report: AdvancedAnalyticsReport): string {
  const rows: unknown[][] = [Array.from(CSV_COLUMNS)];
  const summary = report.summary;
  rows.push([
    'summary', report.periodStartAt, report.periodEndAt, report.guildId, 'Guild overview',
    summary.ticketsCreated, summary.activeTickets, summary.openTickets, summary.claimedTickets,
    summary.pendingTickets, summary.urgentOrCriticalTickets, summary.firstResolvedTickets,
    summary.closeActions, summary.reopenedTickets, summary.firstResponseEligible,
    summary.firstResponseSamples, summary.avgFirstResponseMinutes, summary.avgResolutionMinutes,
  ]);
  for (const item of report.departments) rows.push([
    'department', report.periodStartAt, report.periodEndAt, item.departmentId ?? '', item.departmentName,
    item.ticketsCreated, item.activeTickets, item.openTickets, item.claimedTickets, item.pendingTickets,
    item.urgentOrCriticalTickets, item.firstResolvedTickets, '', item.reopenedTickets,
    item.firstResponseEligible, item.firstResponseSamples, item.avgFirstResponseMinutes,
    item.avgResolutionMinutes,
  ]);
  for (const item of report.staff) rows.push([
    'staff', report.periodStartAt, report.periodEndAt, item.staffId, 'Staff ID ' + item.staffId,
    '', '', '', '', '', '', '', '', '', '', item.firstResponses, item.avgFirstResponseMinutes,
    '', item.ticketsClaimed, item.ticketsClosed, item.staffReplies, item.firstResponses, item.activeWorkload,
  ]);
  for (const item of report.tags) rows.push([
    'tag', report.periodStartAt, report.periodEndAt, item.tagId ?? '', item.tagName,
    item.ticketsCreated, item.activeTickets, '', '', '', item.urgentOrCriticalTickets,
    item.firstResolvedTickets, '', '',
  ]);
  for (const item of report.daily) rows.push([
    'daily', report.periodStartAt, report.periodEndAt, '', '', item.ticketsCreated, '', '', '', '',
    '', item.firstResolvedTickets, '', '', '', '', '', '', '', '', '', '', '', '', item.day,
  ]);

  if (rows.length > MAX_ANALYTICS_EXPORT_ROWS) {
    throw new Error('The analytics export exceeds the safe row limit. Narrow the reporting filters and retry.');
  }
  const csv = rows.map((row) => {
    const padded = Array.from({ length: CSV_COLUMNS.length }, (_, index) => row[index]);
    return padded.map(safeCsvCell).join(',');
  }).join('\r\n') + '\r\n';
  if (csv.length > MAX_ANALYTICS_EXPORT_CHARACTERS) {
    throw new Error('The analytics export exceeds the 1 MB safety limit. Narrow the reporting filters and retry.');
  }
  return csv;
}
