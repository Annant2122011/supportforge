import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import {
  calculateCsatPercentage,
  compareCsatMetric,
  isCsatCohortVisible,
  MAX_CSAT_EXPORT_CHARACTERS,
  MAX_CSAT_EXPORT_ROWS,
  neutralizeCsatCsvCell,
  type CsatInsightCounts,
  type CsatInsightFilters,
  type CsatInsightGroup,
  type CsatInsightGroupBy,
  type CsatInsightsReport,
  type CsatInsightPeriod,
} from '../core/domain/csatReporting';
import { getAdvancedSettings } from './advancedSettingsService';
import { getGuildConfig } from './configService';
import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { CSAT_SURVEY_MAX_DELIVERY_ATTEMPTS } from '../core/domain/csatSurvey';

const MAX_RETRIES = CSAT_SURVEY_MAX_DELIVERY_ATTEMPTS;
const COMMENT_PAGE_SIZE = 5;

interface RawCsatCounts extends QueryResultRow {
  survey_ledger_entries: string | number;
  invitations_sent: string | number;
  queued: string | number;
  failed: string | number;
  retry_exhausted: string | number;
  expired: string | number;
  ratings: string | number;
  survey_responses: string | number;
  average_rating: string | number | null;
  positive: string | number;
  neutral: string | number;
  negative: string | number;
}

interface RawEligibleCount extends QueryResultRow {
  eligible_tickets: string | number;
}

interface RawCsatGroup extends RawCsatCounts {
  group_id: string;
}

function number(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validatedDays(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error('CSAT report window must be a whole number from 1 to 366 days.');
  }
  return days;
}

function validatedFilters(filters: CsatInsightFilters): CsatInsightFilters {
  const validateId = (value: string | undefined, label: string): string | undefined => {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.trim())) {
      throw new Error(label + ' filter must contain 1–64 letters, numbers, underscores or hyphens.');
    }
    return value.trim();
  };
  const departmentId = validateId(filters.departmentId, 'Department');
  const tagId = validateId(filters.tagId, 'Tag');
  const priority = filters.priority;
  if (priority !== undefined && !['low', 'normal', 'high', 'urgent', 'critical'].includes(priority)) {
    throw new Error('Priority filter is not supported.');
  }
  return { departmentId, tagId, priority };
}

function filterValues(guildId: string, startAt: string, endAt: string, filters: CsatInsightFilters) {
  return [guildId, startAt, endAt, filters.departmentId ?? null, filters.tagId ?? null, filters.priority ?? null];
}

function mapCounts(row: RawCsatCounts, eligibleTickets: number, minimumCohortSize: number): CsatInsightCounts {
  const ratings = number(row.ratings);
  const sent = number(row.invitations_sent);
  const surveyResponses = number(row.survey_responses);
  const visible = isCsatCohortVisible(ratings, minimumCohortSize);
  return {
    eligibleTickets,
    surveyLedgerEntries: number(row.survey_ledger_entries),
    invitationsSent: sent,
    queued: number(row.queued),
    failed: number(row.failed),
    retryExhausted: number(row.retry_exhausted),
    expired: number(row.expired),
    ratings,
    surveyResponses,
    averageRating: visible && row.average_rating !== null ? number(row.average_rating) : null,
    positive: visible ? number(row.positive) : null,
    neutral: visible ? number(row.neutral) : null,
    negative: visible ? number(row.negative) : null,
    responseRatePercent: calculateCsatPercentage(surveyResponses, sent),
    coveragePercent: calculateCsatPercentage(sent, eligibleTickets),
    ratingsSuppressed: !visible,
  };
}

async function loadEligibleTicketCount(
  guildId: string,
  startAt: string,
  endAt: string,
  filters: CsatInsightFilters,
): Promise<number> {
  const result = await getPostgresPool().query<RawEligibleCount>(
    'SELECT (' +
      'SELECT COUNT(*)::int FROM support_csat_surveys ledger ' +
      'JOIN tickets t ON t.id=ledger.ticket_id AND t.guild_id=ledger.guild_id ' +
      'WHERE ledger.guild_id=$1 AND ledger.closed_at >= $2::timestamptz AND ledger.closed_at < $3::timestamptz ' +
        'AND t.deleted_at IS NULL AND ($4::text IS NULL OR t.department_id=$4) ' +
        'AND ($5::text IS NULL OR t.tag_id=$5) AND ($6::text IS NULL OR LOWER(COALESCE(t.priority,\'normal\'))=$6)' +
    ') + (' +
      'SELECT COUNT(DISTINCT t.id)::int FROM tickets t ' +
      'JOIN support_csat_survey_settings settings ON settings.guild_id=t.guild_id AND settings.enabled=TRUE AND settings.enabled_at IS NOT NULL ' +
      'JOIN LATERAL (' +
        'SELECT e.id,e.created_at FROM ticket_events e WHERE e.ticket_id=t.id AND e.guild_id=t.guild_id ' +
          "AND e.event_type='ticket.status_changed' AND e.payload->>'to'='closed' AND e.created_at>=settings.enabled_at " +
          'ORDER BY e.created_at DESC,e.id DESC LIMIT 1' +
      ') closure ON TRUE ' +
      "WHERE t.guild_id=$1 AND t.status IN ('closed','archived') AND t.deleted_at IS NULL AND t.owner_id IS NOT NULL " +
        'AND closure.created_at >= $2::timestamptz AND closure.created_at < $3::timestamptz ' +
        'AND ($4::text IS NULL OR t.department_id=$4) AND ($5::text IS NULL OR t.tag_id=$5) ' +
        "AND ($6::text IS NULL OR LOWER(COALESCE(t.priority,'normal'))=$6) " +
        'AND NOT EXISTS (SELECT 1 FROM support_csat_surveys existing WHERE existing.guild_id=t.guild_id AND existing.ticket_id=t.id)' +
    ') AS eligible_tickets',
    filterValues(guildId, startAt, endAt, filters),
  );
  return number(result.rows[0]?.eligible_tickets);
}

async function loadSurveyCounts(
  guildId: string,
  startAt: string,
  endAt: string,
  filters: CsatInsightFilters,
  minimumCohortSize: number,
): Promise<CsatInsightCounts> {
  const values = filterValues(guildId, startAt, endAt, filters);
  const [eligibleTickets, aggregate] = await Promise.all([
    loadEligibleTicketCount(guildId, startAt, endAt, filters),
    getPostgresPool().query<RawCsatCounts>(
      'SELECT COUNT(DISTINCT s.id)::int AS survey_ledger_entries,' +
        'COUNT(DISTINCT s.id) FILTER (WHERE s.sent_at IS NOT NULL)::int AS invitations_sent,' +
        "COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('pending','sending'))::int AS queued," +
        "COUNT(DISTINCT s.id) FILTER (WHERE s.status='failed')::int AS failed," +
        "COUNT(DISTINCT s.id) FILTER (WHERE s.status='failed' AND s.delivery_attempts >= $7)::int AS retry_exhausted," +
        "COUNT(DISTINCT s.id) FILTER (WHERE s.status='expired')::int AS expired," +
        'COUNT(DISTINCT r.id)::int AS ratings,' +
        'COUNT(DISTINCT r.id) FILTER (WHERE s.sent_at IS NOT NULL AND r.created_at>=s.sent_at)::int AS survey_responses,' +
        'AVG(r.rating)::numeric(4,2) AS average_rating,' +
        'COUNT(DISTINCT r.id) FILTER (WHERE r.rating>=4)::int AS positive,' +
        'COUNT(DISTINCT r.id) FILTER (WHERE r.rating=3)::int AS neutral,' +
        'COUNT(DISTINCT r.id) FILTER (WHERE r.rating<=2)::int AS negative ' +
      'FROM support_csat_surveys s JOIN tickets t ON t.id=s.ticket_id AND t.guild_id=s.guild_id ' +
      'LEFT JOIN support_csat_responses r ON r.guild_id=s.guild_id AND r.ticket_id=s.ticket_id AND r.user_id=s.owner_id ' +
      'WHERE s.guild_id=$1 AND s.closed_at >= $2::timestamptz AND s.closed_at < $3::timestamptz ' +
        'AND t.deleted_at IS NULL AND ($4::text IS NULL OR t.department_id=$4) ' +
        'AND ($5::text IS NULL OR t.tag_id=$5) AND ($6::text IS NULL OR LOWER(COALESCE(t.priority,\'normal\'))=$6)',
      [...values, MAX_RETRIES],
    ),
  ]);
  const row = aggregate.rows[0];
  if (!row) throw new Error('CSAT report aggregate query returned no result row.');
  return mapCounts(row, eligibleTickets, minimumCohortSize);
}

const GROUP_EXPRESSIONS: Record<CsatInsightGroupBy, string> = {
  department: "COALESCE(NULLIF(t.department_id,''),'__unassigned__')",
  tag: "COALESCE(NULLIF(t.tag_id,''),'__untagged__')",
  priority: "LOWER(COALESCE(NULLIF(t.priority,''),'normal'))",
};

interface RawCsatEligibleGroup extends QueryResultRow {
  group_id: string;
  eligible_tickets: string | number;
}

async function loadUnqueuedEligibleGroups(
  guildId: string,
  startAt: string,
  endAt: string,
  filters: CsatInsightFilters,
  groupBy: CsatInsightGroupBy,
): Promise<Map<string, number>> {
  const expression = GROUP_EXPRESSIONS[groupBy];
  const result = await getPostgresPool().query<RawCsatEligibleGroup>(
    'SELECT ' + expression + ' AS group_id,COUNT(DISTINCT t.id)::int AS eligible_tickets ' +
    'FROM tickets t ' +
    'JOIN support_csat_survey_settings settings ON settings.guild_id=t.guild_id AND settings.enabled=TRUE AND settings.enabled_at IS NOT NULL ' +
    'JOIN LATERAL (' +
      'SELECT e.id,e.created_at FROM ticket_events e WHERE e.ticket_id=t.id AND e.guild_id=t.guild_id ' +
        "AND e.event_type='ticket.status_changed' AND e.payload->>'to'='closed' AND e.created_at>=settings.enabled_at " +
        'ORDER BY e.created_at DESC,e.id DESC LIMIT 1' +
    ') closure ON TRUE ' +
    "WHERE t.guild_id=$1 AND t.status IN ('closed','archived') AND t.deleted_at IS NULL AND t.owner_id IS NOT NULL " +
      'AND closure.created_at >= $2::timestamptz AND closure.created_at < $3::timestamptz ' +
      'AND ($4::text IS NULL OR t.department_id=$4) AND ($5::text IS NULL OR t.tag_id=$5) ' +
      "AND ($6::text IS NULL OR LOWER(COALESCE(t.priority,'normal'))=$6) " +
      'AND NOT EXISTS (SELECT 1 FROM support_csat_surveys existing WHERE existing.guild_id=t.guild_id AND existing.ticket_id=t.id) ' +
    'GROUP BY ' + expression,
    filterValues(guildId, startAt, endAt, filters),
  );
  return new Map(result.rows.map((row) => [row.group_id, number(row.eligible_tickets)]));
}

async function loadGroups(
  guildId: string,
  startAt: string,
  endAt: string,
  filters: CsatInsightFilters,
  minimumCohortSize: number,
  groupBy: CsatInsightGroupBy,
): Promise<{ groups: CsatInsightGroup[]; suppressed: number }> {
  const expression = GROUP_EXPRESSIONS[groupBy];
  const result = await getPostgresPool().query<RawCsatGroup>(
    'SELECT ' + expression + ' AS group_id,' +
      'COUNT(DISTINCT s.id)::int AS survey_ledger_entries,' +
      'COUNT(DISTINCT s.id) FILTER (WHERE s.sent_at IS NOT NULL)::int AS invitations_sent,' +
      "COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('pending','sending'))::int AS queued," +
      "COUNT(DISTINCT s.id) FILTER (WHERE s.status='failed')::int AS failed," +
      "COUNT(DISTINCT s.id) FILTER (WHERE s.status='failed' AND s.delivery_attempts >= $7)::int AS retry_exhausted," +
      "COUNT(DISTINCT s.id) FILTER (WHERE s.status='expired')::int AS expired," +
      'COUNT(DISTINCT r.id)::int AS ratings,' +
      'COUNT(DISTINCT r.id) FILTER (WHERE s.sent_at IS NOT NULL AND r.created_at>=s.sent_at)::int AS survey_responses,' +
      'AVG(r.rating)::numeric(4,2) AS average_rating,' +
      'COUNT(DISTINCT r.id) FILTER (WHERE r.rating>=4)::int AS positive,' +
      'COUNT(DISTINCT r.id) FILTER (WHERE r.rating=3)::int AS neutral,' +
      'COUNT(DISTINCT r.id) FILTER (WHERE r.rating<=2)::int AS negative ' +
    'FROM support_csat_surveys s JOIN tickets t ON t.id=s.ticket_id AND t.guild_id=s.guild_id ' +
    'LEFT JOIN support_csat_responses r ON r.guild_id=s.guild_id AND r.ticket_id=s.ticket_id AND r.user_id=s.owner_id ' +
    'WHERE s.guild_id=$1 AND s.closed_at >= $2::timestamptz AND s.closed_at < $3::timestamptz ' +
      'AND t.deleted_at IS NULL AND ($4::text IS NULL OR t.department_id=$4) ' +
      'AND ($5::text IS NULL OR t.tag_id=$5) AND ($6::text IS NULL OR LOWER(COALESCE(t.priority,\'normal\'))=$6) ' +
    'GROUP BY ' + expression + ' ORDER BY COUNT(DISTINCT s.id) DESC LIMIT 100',
    [...filterValues(guildId, startAt, endAt, filters), MAX_RETRIES],
  );
  const visibleRows = result.rows.filter((row) => isCsatCohortVisible(number(row.ratings), minimumCohortSize));
  const suppressed = result.rows.length - visibleRows.length;
  const [config, advanced, unqueuedEligible] = await Promise.all([
    getGuildConfig(guildId),
    getAdvancedSettings(guildId),
    loadUnqueuedEligibleGroups(guildId, startAt, endAt, filters, groupBy),
  ]);
  const groups = visibleRows.map((row) => {
    const id = row.group_id;
    const label = groupBy === 'department'
      ? (id === '__unassigned__' ? 'Unassigned' : config.departments[id]?.name ?? 'Other department')
      : groupBy === 'tag'
        ? (id === '__untagged__' ? 'Untagged' :
          advanced.customTags[id]?.name ??
          Object.values(config.departments).map((dept) => dept.tags?.[id]?.name).find(Boolean) ??
          'Other tag')
        : id.charAt(0).toUpperCase() + id.slice(1);
    const eligibleTickets = number(row.survey_ledger_entries) + (unqueuedEligible.get(id) ?? 0);
    const counts = mapCounts(row, eligibleTickets, minimumCohortSize);
    return { ...counts, id, label };
  });
  return { groups, suppressed };
}

function period(startAt: string, endAt: string, counts: CsatInsightCounts): CsatInsightPeriod {
  return { startAt, endAt, counts };
}

export async function getCsatInsightsReport(
  guildId: string,
  options: {
    days?: number;
    filters?: CsatInsightFilters;
    groupBy?: CsatInsightGroupBy | null;
    now?: Date;
  } = {},
): Promise<CsatInsightsReport> {
  if (!guildId.trim()) throw new Error('A guild ID is required to generate CSAT insights.');
  const days = validatedDays(options.days ?? 30);
  const filters = validatedFilters(options.filters ?? {});
  const groupBy = options.groupBy ?? null;
  if (groupBy !== null && !['department', 'tag', 'priority'].includes(groupBy)) {
    throw new Error('CSAT grouping must be department, tag or priority.');
  }
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('CSAT report time must be a valid date.');
  const currentEnd = now;
  const currentStart = new Date(now.getTime() - days * 24 * 60 * 60_000);
  const previousEnd = currentStart;
  const previousStart = new Date(currentStart.getTime() - days * 24 * 60 * 60_000);
  const settingsResult = await getPostgresPool().query<QueryResultRow & { minimum_cohort_size: number }>(
    'SELECT minimum_cohort_size FROM support_csat_survey_settings WHERE guild_id=$1',
    [guildId],
  );
  const configuredMinimum = Number(settingsResult.rows[0]?.minimum_cohort_size ?? 5);
  const minimumCohortSize = Number.isInteger(configuredMinimum) && configuredMinimum >= 1 && configuredMinimum <= 100
    ? configuredMinimum
    : 5;
  const [currentCounts, previousCounts, grouped] = await Promise.all([
    loadSurveyCounts(guildId, currentStart.toISOString(), currentEnd.toISOString(), filters, minimumCohortSize),
    loadSurveyCounts(guildId, previousStart.toISOString(), previousEnd.toISOString(), filters, minimumCohortSize),
    groupBy
      ? loadGroups(guildId, currentStart.toISOString(), currentEnd.toISOString(), filters, minimumCohortSize, groupBy)
      : Promise.resolve({ groups: [], suppressed: 0 }),
  ]);
  return {
    guildId,
    days,
    generatedAt: now.toISOString(),
    filters,
    groupBy,
    minimumCohortSize,
    current: period(currentStart.toISOString(), currentEnd.toISOString(), currentCounts),
    previous: period(previousStart.toISOString(), previousEnd.toISOString(), previousCounts),
    comparison: {
      averageRatingChange: compareCsatMetric(currentCounts.averageRating, previousCounts.averageRating),
      surveyResponsesChange: compareCsatMetric(currentCounts.surveyResponses, previousCounts.surveyResponses),
      responseRateChange: compareCsatMetric(currentCounts.responseRatePercent, previousCounts.responseRatePercent),
    },
    groups: grouped.groups,
    suppressedGroupCount: grouped.suppressed,
  };
}

const CSAT_CSV_HEADER = [
  'record_type', 'period_start_utc', 'period_end_utc', 'group_by', 'group',
  'eligible_tickets', 'survey_ledger_entries', 'invitations_sent', 'queued',
  'failed', 'retry_exhausted', 'expired', 'ratings', 'survey_responses',
  'response_rate_percent', 'coverage_percent', 'average_rating', 'positive',
  'neutral', 'negative', 'ratings_suppressed',
] as const;

export function buildCsatInsightsCsv(report: CsatInsightsReport): string {
  const rows: unknown[][] = [Array.from(CSAT_CSV_HEADER)];
  for (const [name, entry] of [['current', report.current], ['previous', report.previous]] as const) {
    const counts = entry.counts;
    rows.push([
      name, entry.startAt, entry.endAt, report.groupBy ?? '', 'All groups',
      counts.eligibleTickets, counts.surveyLedgerEntries, counts.invitationsSent,
      counts.queued, counts.failed, counts.retryExhausted, counts.expired,
      counts.ratings, counts.surveyResponses, counts.responseRatePercent,
      counts.coveragePercent, counts.averageRating, counts.positive, counts.neutral,
      counts.negative, counts.ratingsSuppressed,
    ]);
  }
  for (const group of report.groups) {
    rows.push([
      'group', report.current.startAt, report.current.endAt, report.groupBy ?? '',
      group.label, group.eligibleTickets, group.surveyLedgerEntries,
      group.invitationsSent, group.queued, group.failed, group.retryExhausted,
      group.expired, group.ratings, group.surveyResponses, group.responseRatePercent,
      group.coveragePercent, group.averageRating, group.positive, group.neutral,
      group.negative, group.ratingsSuppressed,
    ]);
  }
  if (rows.length > MAX_CSAT_EXPORT_ROWS) {
    throw new Error('The CSAT export exceeds the safe row limit. Narrow the reporting filters and retry.');
  }
  const csv = rows.map((row) => row.map(neutralizeCsatCsvCell).join(',')).join('\r\n') + '\r\n';
  if (csv.length > MAX_CSAT_EXPORT_CHARACTERS) {
    throw new Error('The CSAT export exceeds the 1 MB safety limit. Narrow the reporting filters and retry.');
  }
  return csv;
}

export interface CsatCommentItem {
  ticketLabel: string;
  createdAt: string;
  comment: string;
  rating: number;
}

export interface CsatCommentPage {
  page: number;
  pageCount: number;
  total: number;
  items: CsatCommentItem[];
}

export async function getCsatCommentPage(
  guildId: string,
  actorId: string,
  isAdministrator: boolean,
  roleIds: string[],
  page = 1,
  days = 30,
): Promise<CsatCommentPage> {
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error('Comment page must be from 1 to 100.');
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Comment review window must be from 1 to 3,650 days.');
  const pool = getPostgresPool();
  const settings = await pool.query<QueryResultRow & { comment_review_role_id: string | null }>(
    'SELECT comment_review_role_id FROM support_csat_survey_settings WHERE guild_id=$1',
    [guildId],
  );
  const reviewerRoleId = settings.rows[0]?.comment_review_role_id ?? null;
  if (!isAdministrator && (!reviewerRoleId || !roleIds.includes(reviewerRoleId))) {
    throw new Error('You are not authorized to review private customer comments.');
  }
  const offset = (page - 1) * COMMENT_PAGE_SIZE;
  const [items, totalResult] = await Promise.all([
    pool.query<QueryResultRow & { ticket_number: string | null; ticket_id: string; created_at: Date | string; comment: string; rating: number }>(
      'SELECT t.ticket_number,r.ticket_id,r.created_at,r.comment,r.rating ' +
        'FROM support_csat_responses r JOIN tickets t ON t.id=r.ticket_id AND t.guild_id=r.guild_id ' +
        'WHERE r.guild_id=$1 AND r.comment<>\'\' AND r.comment_redacted_at IS NULL ' +
        'AND r.created_at>=NOW()-($2 * INTERVAL \'1 day\') AND t.deleted_at IS NULL ' +
        'ORDER BY r.created_at DESC,r.id DESC LIMIT $3 OFFSET $4',
      [guildId, days, COMMENT_PAGE_SIZE, offset],
    ),
    pool.query<QueryResultRow & { total: string | number }>(
      'SELECT COUNT(*)::int AS total FROM support_csat_responses r JOIN tickets t ON t.id=r.ticket_id AND t.guild_id=r.guild_id ' +
        'WHERE r.guild_id=$1 AND r.comment<>\'\' AND r.comment_redacted_at IS NULL ' +
        'AND r.created_at>=NOW()-($2 * INTERVAL \'1 day\') AND t.deleted_at IS NULL',
      [guildId, days],
    ),
  ]);
  const total = number(totalResult.rows[0]?.total);
  await pool.query(
    'INSERT INTO support_csat_audit_events (id,guild_id,actor_id,action,detail) ' +
      "VALUES ($1,$2,$3,'comments_viewed',$4::jsonb)",
    [randomUUID(), guildId, actorId, JSON.stringify({ page, days, records: items.rowCount ?? 0 })],
  );
  return {
    page,
    pageCount: Math.max(1, Math.ceil(total / COMMENT_PAGE_SIZE)),
    total,
    items: items.rows.map((row) => ({
      ticketLabel: row.ticket_number ? '#' + row.ticket_number : row.ticket_id.slice(0, 8),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      comment: row.comment,
      rating: Number(row.rating),
    })),
  };
}

export async function updateCsatSurveyGovernance(
  guildId: string,
  actorId: string,
  updates: {
    minimumCohortSize?: number;
    commentRetentionDays?: number;
    commentReviewRoleId?: string | null;
  },
): Promise<void> {
  if (updates.minimumCohortSize !== undefined &&
      (!Number.isInteger(updates.minimumCohortSize) || updates.minimumCohortSize < 1 || updates.minimumCohortSize > 100)) {
    throw new Error('The minimum CSAT cohort must be a whole number from 1 to 100.');
  }
  if (updates.commentRetentionDays !== undefined &&
      (!Number.isInteger(updates.commentRetentionDays) || updates.commentRetentionDays < 1 || updates.commentRetentionDays > 3650)) {
    throw new Error('Comment retention must be a whole number from 1 to 3,650 days.');
  }
  if (updates.commentReviewRoleId !== undefined && updates.commentReviewRoleId !== null &&
      !/^\d{17,20}$/.test(updates.commentReviewRoleId)) {
    throw new Error('The comment-review role must be a valid Discord role ID or null.');
  }
  const pool = getPostgresPool();
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(
      'INSERT INTO support_csat_survey_settings ' +
        '(guild_id,updated_by,minimum_cohort_size,comment_retention_days,comment_review_role_id) ' +
        'VALUES ($1,$2,COALESCE($3,5),COALESCE($4,180),$5) ' +
        'ON CONFLICT (guild_id) DO UPDATE SET ' +
        'minimum_cohort_size=COALESCE($3,support_csat_survey_settings.minimum_cohort_size),' +
        'comment_retention_days=COALESCE($4,support_csat_survey_settings.comment_retention_days),' +
        'comment_review_role_id=CASE WHEN $6::boolean THEN $5 ELSE support_csat_survey_settings.comment_review_role_id END,' +
        'updated_by=$2,updated_at=NOW()',
      [guildId, actorId, updates.minimumCohortSize ?? null, updates.commentRetentionDays ?? null,
        updates.commentReviewRoleId ?? null, updates.commentReviewRoleId !== undefined],
    );
    await connection.query(
      'INSERT INTO support_csat_audit_events (id,guild_id,actor_id,action,detail) ' +
        "VALUES ($1,$2,$3,'governance_updated',$4::jsonb)",
      [randomUUID(), guildId, actorId, JSON.stringify({
        minimumCohortSize: updates.minimumCohortSize ?? null,
        commentRetentionDays: updates.commentRetentionDays ?? null,
        commentReviewRoleChanged: updates.commentReviewRoleId !== undefined,
      })],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export async function redactExpiredCsatComments(): Promise<number> {
  const pool = getPostgresPool();
  const result = await pool.query<QueryResultRow & { guild_id: string; redacted_count: number | string }>(
    'WITH redacted AS (' +
      'UPDATE support_csat_responses r SET comment=\'\',comment_redacted_at=NOW(),updated_at=NOW() ' +
      'FROM tickets t LEFT JOIN support_csat_survey_settings settings ON settings.guild_id=t.guild_id ' +
      'WHERE t.id=r.ticket_id AND t.guild_id=r.guild_id AND r.comment<>\'\' AND r.comment_redacted_at IS NULL ' +
      'AND r.created_at <= NOW()-(COALESCE(settings.comment_retention_days,180) * INTERVAL \'1 day\') ' +
      'RETURNING r.guild_id' +
    ') INSERT INTO support_csat_audit_events (id,guild_id,actor_id,action,detail) ' +
      "SELECT md5(random()::text || clock_timestamp()::text || guild_id),guild_id,NULL,'comments_redacted'," +
        "jsonb_build_object('records',COUNT(*)) FROM redacted GROUP BY guild_id RETURNING guild_id, (detail->>'records')::int AS redacted_count",
  );
  return result.rows.reduce((total, row) => total + number(row.redacted_count), 0);
}
