import type { QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import type { DatabaseExecutor } from '../core/persistence/database';
import type { AnalyticsFilters } from './postgresAnalyticsRepository';

export interface DepartmentAnalyticsRow extends QueryResultRow {
  department_id: string | null;
  tickets_created: string | number;
  active_tickets: string | number;
  open_tickets: string | number;
  claimed_tickets: string | number;
  pending_tickets: string | number;
  urgent_or_critical_tickets: string | number;
  first_resolved_tickets: string | number;
  reopened_tickets: string | number;
  first_response_eligible: string | number;
  first_response_samples: string | number;
  avg_first_response_minutes: string | number | null;
  avg_resolution_minutes: string | number | null;
  oldest_active_created_at: Date | string | null;
}

export interface StaffAnalyticsRow extends QueryResultRow {
  staff_id: string;
  tickets_claimed: string | number;
  tickets_closed: string | number;
  staff_replies: string | number;
  first_responses: string | number;
  active_workload: string | number;
  avg_first_response_minutes: string | number | null;
}

export interface TagAnalyticsRow extends QueryResultRow {
  tag_id: string | null;
  tickets_created: string | number;
  active_tickets: string | number;
  first_resolved_tickets: string | number;
  urgent_or_critical_tickets: string | number;
}

export interface DataCoverageRow extends QueryResultRow {
  period_tickets: string | number;
  created_event_tickets: string | number;
  message_events: string | number;
  attributed_message_events: string | number;
  unknown_author_messages: string | number;
  missing_timestamp_messages: string | number;
  lifecycle_events: string | number;
}

export interface AnalyticsDataCoverage {
  periodTickets: number;
  ticketsWithCreatedEvent: number;
  messageEvents: number;
  attributedMessageEvents: number;
  unknownAuthorMessages: number;
  missingTimestampMessages: number;
  lifecycleEvents: number;
}

export interface DailyAnalyticsRow extends QueryResultRow {
  day: string | Date;
  tickets_created: string | number;
  first_resolved_tickets: string | number;
}

export interface DepartmentAnalytics {
  departmentId: string | null;
  ticketsCreated: number;
  activeTickets: number;
  openTickets: number;
  claimedTickets: number;
  pendingTickets: number;
  urgentOrCriticalTickets: number;
  firstResolvedTickets: number;
  reopenedTickets: number;
  firstResponseEligible: number;
  firstResponseSamples: number;
  avgFirstResponseMinutes: number | null;
  avgResolutionMinutes: number | null;
  oldestActiveCreatedAt: string | null;
}

export interface StaffAnalytics {
  staffId: string;
  ticketsClaimed: number;
  ticketsClosed: number;
  staffReplies: number;
  firstResponses: number;
  activeWorkload: number;
  avgFirstResponseMinutes: number | null;
}

export interface TagAnalytics {
  tagId: string | null;
  ticketsCreated: number;
  activeTickets: number;
  firstResolvedTickets: number;
  urgentOrCriticalTickets: number;
}

export interface DailyAnalytics {
  day: string;
  ticketsCreated: number;
  firstResolvedTickets: number;
}

function toCount(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function toMinutes(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 10) / 10 : null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const result = value instanceof Date ? value : new Date(value);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
}

function parameters(guildId: string, startAt: string, endAt: string, filters: AnalyticsFilters): unknown[] {
  return [
    guildId,
    startAt,
    endAt,
    filters.departmentId ?? null,
    filters.priority ?? null,
    filters.status ?? null,
    filters.tagId ?? null,
  ];
}

const FILTERED_TICKETS_CTE = String.raw`filtered_tickets AS (
  SELECT t.*
  FROM tickets AS t
  WHERE t.guild_id = $1
    AND t.deleted_at IS NULL
    AND ($4::text IS NULL OR t.department_id = $4)
    AND ($5::text IS NULL OR LOWER(COALESCE(t.priority, 'normal')) = $5)
    AND ($6::text IS NULL OR t.status = $6)
    AND ($7::text IS NULL OR t.tag_id = $7)
)`;

const DEPARTMENT_SQL = 'WITH ' + FILTERED_TICKETS_CTE + String.raw`,
period_tickets AS (
  SELECT * FROM filtered_tickets
  WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
),
first_closure AS (
  SELECT t.id, t.department_id, t.created_at, MIN(e.created_at) AS first_closed_at
  FROM filtered_tickets AS t
  INNER JOIN ticket_events AS e
    ON e.ticket_id = t.id AND e.guild_id = $1 AND e.event_type = 'ticket.closed'
  GROUP BY t.id, t.department_id, t.created_at
),
created AS (
  SELECT department_id, COUNT(*) AS tickets_created FROM period_tickets GROUP BY department_id
),
active AS (
  SELECT department_id,
         COUNT(*) FILTER (WHERE status IN ('open', 'claimed', 'pending', 'reopened')) AS active_tickets,
         COUNT(*) FILTER (WHERE status IN ('open', 'reopened')) AS open_tickets,
         COUNT(*) FILTER (WHERE status = 'claimed') AS claimed_tickets,
         COUNT(*) FILTER (WHERE status = 'pending') AS pending_tickets,
         COUNT(*) FILTER (
           WHERE status IN ('open', 'claimed', 'pending', 'reopened')
             AND LOWER(COALESCE(priority, 'normal')) IN ('urgent', 'critical')
         ) AS urgent_or_critical_tickets,
         MIN(created_at) FILTER (WHERE status IN ('open', 'claimed', 'pending', 'reopened')) AS oldest_active_created_at
  FROM filtered_tickets GROUP BY department_id
),
resolved AS (
  SELECT department_id,
         COUNT(*) AS first_resolved_tickets,
         AVG(EXTRACT(EPOCH FROM (first_closed_at - created_at)) / 60.0) AS avg_resolution_minutes
  FROM first_closure
  WHERE first_closed_at >= $2::timestamptz AND first_closed_at < $3::timestamptz
  GROUP BY department_id
),
reopened AS (
  SELECT t.department_id, COUNT(DISTINCT e.ticket_id) AS reopened_tickets
  FROM filtered_tickets AS t
  INNER JOIN ticket_events AS e ON e.ticket_id = t.id AND e.guild_id = $1
  WHERE e.event_type = 'ticket.reopened'
    AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz
  GROUP BY t.department_id
),
first_customer AS (
  SELECT t.id, t.department_id,
         MIN((e.payload->>'messageTimestamp')::timestamptz) AS first_customer_at
  FROM period_tickets AS t
  INNER JOIN ticket_events AS e ON e.ticket_id = t.id AND e.guild_id = $1
  WHERE e.event_type = 'ticket.message.received'
    AND e.payload->>'messageAuthorType' = 'customer'
    AND e.payload->>'messageTimestamp' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    AND (e.payload->>'messageTimestamp')::timestamptz >= t.created_at
    AND (e.payload->>'messageTimestamp')::timestamptz >= $2::timestamptz
    AND (e.payload->>'messageTimestamp')::timestamptz < $3::timestamptz
    AND e.created_at < $3::timestamptz
  GROUP BY t.id, t.department_id
),
first_staff AS (
  SELECT c.id, c.department_id, c.first_customer_at,
         MIN((e.payload->>'messageTimestamp')::timestamptz) AS first_staff_at
  FROM first_customer AS c
  INNER JOIN ticket_events AS e ON e.ticket_id = c.id AND e.guild_id = $1
  WHERE e.event_type = 'ticket.message.received'
    AND e.payload->>'messageAuthorType' = 'staff'
    AND e.payload->>'messageTimestamp' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    AND (e.payload->>'messageTimestamp')::timestamptz > c.first_customer_at
    AND (e.payload->>'messageTimestamp')::timestamptz < $3::timestamptz
    AND e.created_at < $3::timestamptz
  GROUP BY c.id, c.department_id, c.first_customer_at
),
response AS (
  SELECT c.department_id,
         COUNT(*) AS first_response_eligible,
         COUNT(s.id) AS first_response_samples,
         AVG(EXTRACT(EPOCH FROM (s.first_staff_at - c.first_customer_at)) / 60.0) AS avg_first_response_minutes
  FROM first_customer AS c
  LEFT JOIN first_staff AS s ON s.id = c.id
  GROUP BY c.department_id
),
department_ids AS (
  SELECT department_id FROM created
  UNION SELECT department_id FROM active
  UNION SELECT department_id FROM resolved
  UNION SELECT department_id FROM response
  UNION SELECT department_id FROM reopened
)
SELECT d.department_id,
       COALESCE(c.tickets_created, 0) AS tickets_created,
       COALESCE(a.active_tickets, 0) AS active_tickets,
       COALESCE(a.open_tickets, 0) AS open_tickets,
       COALESCE(a.claimed_tickets, 0) AS claimed_tickets,
       COALESCE(a.pending_tickets, 0) AS pending_tickets,
       COALESCE(a.urgent_or_critical_tickets, 0) AS urgent_or_critical_tickets,
       COALESCE(r.first_resolved_tickets, 0) AS first_resolved_tickets,
       COALESCE(o.reopened_tickets, 0) AS reopened_tickets,
       COALESCE(resp.first_response_eligible, 0) AS first_response_eligible,
       COALESCE(resp.first_response_samples, 0) AS first_response_samples,
       resp.avg_first_response_minutes,
       r.avg_resolution_minutes,
       a.oldest_active_created_at
FROM department_ids AS d
LEFT JOIN created AS c ON c.department_id IS NOT DISTINCT FROM d.department_id
LEFT JOIN active AS a ON a.department_id IS NOT DISTINCT FROM d.department_id
LEFT JOIN resolved AS r ON r.department_id IS NOT DISTINCT FROM d.department_id
LEFT JOIN reopened AS o ON o.department_id IS NOT DISTINCT FROM d.department_id
LEFT JOIN response AS resp ON resp.department_id IS NOT DISTINCT FROM d.department_id
ORDER BY COALESCE(c.tickets_created, 0) DESC, COALESCE(a.active_tickets, 0) DESC, d.department_id NULLS LAST
LIMIT 500`;

const STAFF_SQL = 'WITH ' + FILTERED_TICKETS_CTE + String.raw`,
period_tickets AS (
  SELECT * FROM filtered_tickets
  WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
),
claims AS (
  SELECT e.actor_id AS staff_id, COUNT(DISTINCT e.ticket_id) AS tickets_claimed
  FROM ticket_events AS e INNER JOIN filtered_tickets AS t ON t.id = e.ticket_id
  WHERE e.guild_id = $1 AND e.event_type = 'ticket.claimed'
    AND e.actor_attribution = 'actorKnown' AND e.actor_confidence = 'high'
    AND e.actor_id ~ '^[0-9]{17,20}$'
    AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz
  GROUP BY e.actor_id
),
closures AS (
  SELECT e.actor_id AS staff_id, COUNT(DISTINCT e.ticket_id) AS tickets_closed
  FROM ticket_events AS e INNER JOIN filtered_tickets AS t ON t.id = e.ticket_id
  WHERE e.guild_id = $1 AND e.event_type = 'ticket.closed'
    AND e.actor_attribution = 'actorKnown' AND e.actor_confidence = 'high'
    AND e.actor_id ~ '^[0-9]{17,20}$'
    AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz
  GROUP BY e.actor_id
),
replies AS (
  SELECT e.actor_id AS staff_id, COUNT(*) AS staff_replies
  FROM ticket_events AS e INNER JOIN filtered_tickets AS t ON t.id = e.ticket_id
  WHERE e.guild_id = $1 AND e.event_type = 'ticket.message.received'
    AND e.payload->>'messageAuthorType' = 'staff'
    AND e.actor_attribution = 'actorKnown' AND e.actor_confidence = 'high'
    AND e.actor_id ~ '^[0-9]{17,20}$'
    AND e.payload->>'messageTimestamp' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    AND (e.payload->>'messageTimestamp')::timestamptz >= $2::timestamptz
    AND (e.payload->>'messageTimestamp')::timestamptz < $3::timestamptz
  GROUP BY e.actor_id
),
first_customer AS (
  SELECT t.id, MIN((e.payload->>'messageTimestamp')::timestamptz) AS first_customer_at
  FROM period_tickets AS t INNER JOIN ticket_events AS e ON e.ticket_id = t.id AND e.guild_id = $1
  WHERE e.event_type = 'ticket.message.received'
    AND e.payload->>'messageAuthorType' = 'customer'
    AND e.payload->>'messageTimestamp' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    AND (e.payload->>'messageTimestamp')::timestamptz >= t.created_at
    AND (e.payload->>'messageTimestamp')::timestamptz >= $2::timestamptz
    AND (e.payload->>'messageTimestamp')::timestamptz < $3::timestamptz
  GROUP BY t.id
),
ranked_first_responses AS (
  SELECT c.id AS ticket_id, e.actor_id AS staff_id,
         e.actor_attribution, e.actor_confidence, c.first_customer_at,
         (e.payload->>'messageTimestamp')::timestamptz AS first_staff_at,
         ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY (e.payload->>'messageTimestamp')::timestamptz, e.id) AS response_rank
  FROM first_customer AS c INNER JOIN ticket_events AS e ON e.ticket_id = c.id AND e.guild_id = $1
  WHERE e.event_type = 'ticket.message.received'
    AND e.payload->>'messageAuthorType' = 'staff'
    AND e.payload->>'messageTimestamp' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    AND (e.payload->>'messageTimestamp')::timestamptz > c.first_customer_at
    AND (e.payload->>'messageTimestamp')::timestamptz < $3::timestamptz
),
first_responses AS (
  SELECT staff_id, COUNT(*) AS first_responses,
         AVG(EXTRACT(EPOCH FROM (first_staff_at - first_customer_at)) / 60.0) AS avg_first_response_minutes
  FROM ranked_first_responses
  WHERE response_rank = 1
    AND actor_attribution = 'actorKnown' AND actor_confidence = 'high'
    AND staff_id ~ '^[0-9]{17,20}
workload AS (
  SELECT assigned.staff_id, COUNT(DISTINCT t.id) AS active_workload
  FROM filtered_tickets AS t
  CROSS JOIN LATERAL UNNEST(t.claimed_by_ids) AS assigned(staff_id)
  WHERE t.status IN ('open', 'claimed', 'pending', 'reopened')
    AND assigned.staff_id ~ '^[0-9]{17,20}$'
  GROUP BY assigned.staff_id
),
staff_ids AS (
  SELECT staff_id FROM claims UNION SELECT staff_id FROM closures
  UNION SELECT staff_id FROM replies UNION SELECT staff_id FROM first_responses
  UNION SELECT staff_id FROM workload
)
SELECT ids.staff_id, COALESCE(c.tickets_claimed, 0) AS tickets_claimed,
       COALESCE(cl.tickets_closed, 0) AS tickets_closed,
       COALESCE(r.staff_replies, 0) AS staff_replies,
       COALESCE(fr.first_responses, 0) AS first_responses,
       COALESCE(w.active_workload, 0) AS active_workload,
       fr.avg_first_response_minutes
FROM staff_ids AS ids
LEFT JOIN claims AS c USING (staff_id)
LEFT JOIN closures AS cl USING (staff_id)
LEFT JOIN replies AS r USING (staff_id)
LEFT JOIN first_responses AS fr USING (staff_id)
LEFT JOIN workload AS w USING (staff_id)
ORDER BY COALESCE(w.active_workload, 0) DESC, COALESCE(cl.tickets_closed, 0) DESC, ids.staff_id
LIMIT 500`;

const TAG_SQL = 'WITH ' + FILTERED_TICKETS_CTE + String.raw`,
period_tickets AS (
  SELECT * FROM filtered_tickets WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
),
first_closure AS (
  SELECT t.id, t.tag_id, MIN(e.created_at) AS first_closed_at
  FROM filtered_tickets AS t
  INNER JOIN ticket_events AS e ON e.ticket_id = t.id AND e.guild_id = $1 AND e.event_type = 'ticket.closed'
  GROUP BY t.id, t.tag_id
),
created AS (SELECT tag_id, COUNT(*) AS tickets_created FROM period_tickets GROUP BY tag_id),
active AS (
  SELECT tag_id,
         COUNT(*) FILTER (WHERE status IN ('open', 'claimed', 'pending', 'reopened')) AS active_tickets,
         COUNT(*) FILTER (WHERE status IN ('open', 'claimed', 'pending', 'reopened')
           AND LOWER(COALESCE(priority, 'normal')) IN ('urgent', 'critical')) AS urgent_or_critical_tickets
  FROM filtered_tickets GROUP BY tag_id
),
resolved AS (
  SELECT tag_id, COUNT(*) AS first_resolved_tickets FROM first_closure
  WHERE first_closed_at >= $2::timestamptz AND first_closed_at < $3::timestamptz GROUP BY tag_id
),
tag_ids AS (SELECT tag_id FROM created UNION SELECT tag_id FROM active UNION SELECT tag_id FROM resolved)
SELECT tags.tag_id, COALESCE(c.tickets_created, 0) AS tickets_created,
       COALESCE(a.active_tickets, 0) AS active_tickets,
       COALESCE(r.first_resolved_tickets, 0) AS first_resolved_tickets,
       COALESCE(a.urgent_or_critical_tickets, 0) AS urgent_or_critical_tickets
FROM tag_ids AS tags
LEFT JOIN created AS c ON c.tag_id IS NOT DISTINCT FROM tags.tag_id
LEFT JOIN active AS a ON a.tag_id IS NOT DISTINCT FROM tags.tag_id
LEFT JOIN resolved AS r ON r.tag_id IS NOT DISTINCT FROM tags.tag_id
ORDER BY COALESCE(c.tickets_created, 0) DESC, COALESCE(a.active_tickets, 0) DESC, tags.tag_id NULLS LAST
LIMIT 500`;

const TREND_SQL = 'WITH ' + FILTERED_TICKETS_CTE + String.raw`,
day_grid AS (
  SELECT generate_series(
    date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC'),
    date_trunc('day', ($3::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC'),
    interval '1 day'
  )::date AS day
),
created AS (
  SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS tickets_created
  FROM filtered_tickets WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
  GROUP BY (created_at AT TIME ZONE 'UTC')::date
),
first_closure AS (
  SELECT t.id, MIN(e.created_at) AS first_closed_at
  FROM filtered_tickets AS t
  INNER JOIN ticket_events AS e ON e.ticket_id = t.id AND e.guild_id = $1 AND e.event_type = 'ticket.closed'
  GROUP BY t.id
),
resolved AS (
  SELECT (first_closed_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS first_resolved_tickets
  FROM first_closure WHERE first_closed_at >= $2::timestamptz AND first_closed_at < $3::timestamptz
  GROUP BY (first_closed_at AT TIME ZONE 'UTC')::date
)
SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS day,
       COALESCE(c.tickets_created, 0) AS tickets_created,
       COALESCE(r.first_resolved_tickets, 0) AS first_resolved_tickets
FROM day_grid AS days
LEFT JOIN created AS c USING (day)
LEFT JOIN resolved AS r USING (day)
ORDER BY days.day`;

const DATA_COVERAGE_SQL = 'WITH ' + FILTERED_TICKETS_CTE + String.raw`,
period_tickets AS (
  SELECT * FROM filtered_tickets WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
)
SELECT
  (SELECT COUNT(*) FROM period_tickets) AS period_tickets,
  (SELECT COUNT(DISTINCT e.ticket_id) FROM ticket_events AS e
    INNER JOIN period_tickets AS t ON t.id = e.ticket_id
    WHERE e.guild_id = $1 AND e.event_type = 'ticket.created'
      AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz) AS created_event_tickets,
  (SELECT COUNT(*) FROM ticket_events AS e
    INNER JOIN period_tickets AS t ON t.id = e.ticket_id
    WHERE e.guild_id = $1 AND e.event_type = 'ticket.message.received'
      AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz) AS message_events,
  (SELECT COUNT(*) FROM ticket_events AS e
    INNER JOIN period_tickets AS t ON t.id = e.ticket_id
    WHERE e.guild_id = $1 AND e.event_type = 'ticket.message.received'
      AND e.payload->>'messageAuthorType' IN ('customer', 'staff')
      AND e.payload->>'messageTimestamp' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz) AS attributed_message_events,
  (SELECT COUNT(*) FROM ticket_events AS e
    INNER JOIN period_tickets AS t ON t.id = e.ticket_id
    WHERE e.guild_id = $1 AND e.event_type = 'ticket.message.received'
      AND COALESCE(e.payload->>'messageAuthorType', 'unknown') NOT IN ('customer', 'staff')
      AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz) AS unknown_author_messages,
  (SELECT COUNT(*) FROM ticket_events AS e
    INNER JOIN period_tickets AS t ON t.id = e.ticket_id
    WHERE e.guild_id = $1 AND e.event_type = 'ticket.message.received'
      AND COALESCE(e.payload->>'messageTimestamp', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz) AS missing_timestamp_messages,
  (SELECT COUNT(*) FROM ticket_events AS e
    INNER JOIN period_tickets AS t ON t.id = e.ticket_id
    WHERE e.guild_id = $1
      AND e.event_type IN ('ticket.status_changed', 'ticket.claimed', 'ticket.unclaimed',
        'ticket.pending', 'ticket.resumed', 'ticket.closed', 'ticket.reopened', 'ticket.archived')
      AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz) AS lifecycle_events`;

export class PostgresAdvancedAnalyticsRepository {
  public constructor(private readonly executor: DatabaseExecutor = getPostgresPool()) {}

  public async getDepartmentBreakdown(guildId: string, startAt: string, endAt: string, filters: AnalyticsFilters = {}): Promise<DepartmentAnalytics[]> {
    const result = await this.executor.query<DepartmentAnalyticsRow>(DEPARTMENT_SQL, parameters(guildId, startAt, endAt, filters) as string[]);
    return result.rows.map((row) => ({
      departmentId: row.department_id,
      ticketsCreated: toCount(row.tickets_created),
      activeTickets: toCount(row.active_tickets),
      openTickets: toCount(row.open_tickets),
      claimedTickets: toCount(row.claimed_tickets),
      pendingTickets: toCount(row.pending_tickets),
      urgentOrCriticalTickets: toCount(row.urgent_or_critical_tickets),
      firstResolvedTickets: toCount(row.first_resolved_tickets),
      reopenedTickets: toCount(row.reopened_tickets),
      firstResponseEligible: toCount(row.first_response_eligible),
      firstResponseSamples: toCount(row.first_response_samples),
      avgFirstResponseMinutes: toMinutes(row.avg_first_response_minutes),
      avgResolutionMinutes: toMinutes(row.avg_resolution_minutes),
      oldestActiveCreatedAt: toIso(row.oldest_active_created_at),
    }));
  }

  public async getStaffBreakdown(guildId: string, startAt: string, endAt: string, filters: AnalyticsFilters = {}): Promise<StaffAnalytics[]> {
    const result = await this.executor.query<StaffAnalyticsRow>(STAFF_SQL, parameters(guildId, startAt, endAt, filters) as string[]);
    return result.rows.map((row) => ({
      staffId: row.staff_id,
      ticketsClaimed: toCount(row.tickets_claimed),
      ticketsClosed: toCount(row.tickets_closed),
      staffReplies: toCount(row.staff_replies),
      firstResponses: toCount(row.first_responses),
      activeWorkload: toCount(row.active_workload),
      avgFirstResponseMinutes: toMinutes(row.avg_first_response_minutes),
    }));
  }

  public async getTagBreakdown(guildId: string, startAt: string, endAt: string, filters: AnalyticsFilters = {}): Promise<TagAnalytics[]> {
    const result = await this.executor.query<TagAnalyticsRow>(TAG_SQL, parameters(guildId, startAt, endAt, filters) as string[]);
    return result.rows.map((row) => ({
      tagId: row.tag_id,
      ticketsCreated: toCount(row.tickets_created),
      activeTickets: toCount(row.active_tickets),
      firstResolvedTickets: toCount(row.first_resolved_tickets),
      urgentOrCriticalTickets: toCount(row.urgent_or_critical_tickets),
    }));
  }

  public async getDataCoverage(
    guildId: string,
    startAt: string,
    endAt: string,
    filters: AnalyticsFilters = {},
  ): Promise<AnalyticsDataCoverage> {
    const result = await this.executor.query<DataCoverageRow>(
      DATA_COVERAGE_SQL,
      parameters(guildId, startAt, endAt, filters) as string[],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Analytics coverage query returned no aggregate row.');
    return {
      periodTickets: toCount(row.period_tickets),
      ticketsWithCreatedEvent: toCount(row.created_event_tickets),
      messageEvents: toCount(row.message_events),
      attributedMessageEvents: toCount(row.attributed_message_events),
      unknownAuthorMessages: toCount(row.unknown_author_messages),
      missingTimestampMessages: toCount(row.missing_timestamp_messages),
      lifecycleEvents: toCount(row.lifecycle_events),
    };
  }

  public async getDailyTrends(guildId: string, startAt: string, endAt: string, filters: AnalyticsFilters = {}): Promise<DailyAnalytics[]> {
    const result = await this.executor.query<DailyAnalyticsRow>(TREND_SQL, parameters(guildId, startAt, endAt, filters) as string[]);
    return result.rows.map((row) => ({
      day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10),
      ticketsCreated: toCount(row.tickets_created),
      firstResolvedTickets: toCount(row.first_resolved_tickets),
    }));
  }
}

  GROUP BY staff_id
),
workload AS (
  SELECT assigned.staff_id, COUNT(DISTINCT t.id) AS active_workload
  FROM filtered_tickets AS t
  CROSS JOIN LATERAL UNNEST(t.claimed_by_ids) AS assigned(staff_id)
  WHERE t.status IN ('open', 'claimed', 'pending', 'reopened')
    AND assigned.staff_id ~ '^[0-9]{17,20}$'
  GROUP BY assigned.staff_id
),
staff_ids AS (
  SELECT staff_id FROM claims UNION SELECT staff_id FROM closures
  UNION SELECT staff_id FROM replies UNION SELECT staff_id FROM first_responses
  UNION SELECT staff_id FROM workload
)
SELECT ids.staff_id, COALESCE(c.tickets_claimed, 0) AS tickets_claimed,
       COALESCE(cl.tickets_closed, 0) AS tickets_closed,
       COALESCE(r.staff_replies, 0) AS staff_replies,
       COALESCE(fr.first_responses, 0) AS first_responses,
       COALESCE(w.active_workload, 0) AS active_workload,
       fr.avg_first_response_minutes
FROM staff_ids AS ids
LEFT JOIN claims AS c USING (staff_id)
LEFT JOIN closures AS cl USING (staff_id)
LEFT JOIN replies AS r USING (staff_id)
LEFT JOIN first_responses AS fr USING (staff_id)
LEFT JOIN workload AS w USING (staff_id)
ORDER BY COALESCE(w.active_workload, 0) DESC, COALESCE(cl.tickets_closed, 0) DESC, ids.staff_id
LIMIT 500`;

const TAG_SQL = 'WITH ' + FILTERED_TICKETS_CTE + String.raw`,
period_tickets AS (
  SELECT * FROM filtered_tickets WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
),
first_closure AS (
  SELECT t.id, t.tag_id, MIN(e.created_at) AS first_closed_at
  FROM filtered_tickets AS t
  INNER JOIN ticket_events AS e ON e.ticket_id = t.id AND e.guild_id = $1 AND e.event_type = 'ticket.closed'
  GROUP BY t.id, t.tag_id
),
created AS (SELECT tag_id, COUNT(*) AS tickets_created FROM period_tickets GROUP BY tag_id),
active AS (
  SELECT tag_id,
         COUNT(*) FILTER (WHERE status IN ('open', 'claimed', 'pending', 'reopened')) AS active_tickets,
         COUNT(*) FILTER (WHERE status IN ('open', 'claimed', 'pending', 'reopened')
           AND LOWER(COALESCE(priority, 'normal')) IN ('urgent', 'critical')) AS urgent_or_critical_tickets
  FROM filtered_tickets GROUP BY tag_id
),
resolved AS (
  SELECT tag_id, COUNT(*) AS first_resolved_tickets FROM first_closure
  WHERE first_closed_at >= $2::timestamptz AND first_closed_at < $3::timestamptz GROUP BY tag_id
),
tag_ids AS (SELECT tag_id FROM created UNION SELECT tag_id FROM active UNION SELECT tag_id FROM resolved)
SELECT tags.tag_id, COALESCE(c.tickets_created, 0) AS tickets_created,
       COALESCE(a.active_tickets, 0) AS active_tickets,
       COALESCE(r.first_resolved_tickets, 0) AS first_resolved_tickets,
       COALESCE(a.urgent_or_critical_tickets, 0) AS urgent_or_critical_tickets
FROM tag_ids AS tags
LEFT JOIN created AS c ON c.tag_id IS NOT DISTINCT FROM tags.tag_id
LEFT JOIN active AS a ON a.tag_id IS NOT DISTINCT FROM tags.tag_id
LEFT JOIN resolved AS r ON r.tag_id IS NOT DISTINCT FROM tags.tag_id
ORDER BY COALESCE(c.tickets_created, 0) DESC, COALESCE(a.active_tickets, 0) DESC, tags.tag_id NULLS LAST
LIMIT 500`;

const TREND_SQL = 'WITH ' + FILTERED_TICKETS_CTE + String.raw`,
day_grid AS (
  SELECT generate_series(
    date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC'),
    date_trunc('day', ($3::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC'),
    interval '1 day'
  )::date AS day
),
created AS (
  SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS tickets_created
  FROM filtered_tickets WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
  GROUP BY (created_at AT TIME ZONE 'UTC')::date
),
first_closure AS (
  SELECT t.id, MIN(e.created_at) AS first_closed_at
  FROM filtered_tickets AS t
  INNER JOIN ticket_events AS e ON e.ticket_id = t.id AND e.guild_id = $1 AND e.event_type = 'ticket.closed'
  GROUP BY t.id
),
resolved AS (
  SELECT (first_closed_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS first_resolved_tickets
  FROM first_closure WHERE first_closed_at >= $2::timestamptz AND first_closed_at < $3::timestamptz
  GROUP BY (first_closed_at AT TIME ZONE 'UTC')::date
)
SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS day,
       COALESCE(c.tickets_created, 0) AS tickets_created,
       COALESCE(r.first_resolved_tickets, 0) AS first_resolved_tickets
FROM day_grid AS days
LEFT JOIN created AS c USING (day)
LEFT JOIN resolved AS r USING (day)
ORDER BY days.day`;

const DATA_COVERAGE_SQL = 'WITH ' + FILTERED_TICKETS_CTE + String.raw`,
period_tickets AS (
  SELECT * FROM filtered_tickets WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
)
SELECT
  (SELECT COUNT(*) FROM period_tickets) AS period_tickets,
  (SELECT COUNT(DISTINCT e.ticket_id) FROM ticket_events AS e
    INNER JOIN period_tickets AS t ON t.id = e.ticket_id
    WHERE e.guild_id = $1 AND e.event_type = 'ticket.created'
      AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz) AS created_event_tickets,
  (SELECT COUNT(*) FROM ticket_events AS e
    INNER JOIN period_tickets AS t ON t.id = e.ticket_id
    WHERE e.guild_id = $1 AND e.event_type = 'ticket.message.received'
      AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz) AS message_events,
  (SELECT COUNT(*) FROM ticket_events AS e
    INNER JOIN period_tickets AS t ON t.id = e.ticket_id
    WHERE e.guild_id = $1 AND e.event_type = 'ticket.message.received'
      AND e.payload->>'messageAuthorType' IN ('customer', 'staff')
      AND e.payload->>'messageTimestamp' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz) AS attributed_message_events,
  (SELECT COUNT(*) FROM ticket_events AS e
    INNER JOIN period_tickets AS t ON t.id = e.ticket_id
    WHERE e.guild_id = $1 AND e.event_type = 'ticket.message.received'
      AND COALESCE(e.payload->>'messageAuthorType', 'unknown') NOT IN ('customer', 'staff')
      AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz) AS unknown_author_messages,
  (SELECT COUNT(*) FROM ticket_events AS e
    INNER JOIN period_tickets AS t ON t.id = e.ticket_id
    WHERE e.guild_id = $1 AND e.event_type = 'ticket.message.received'
      AND COALESCE(e.payload->>'messageTimestamp', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz) AS missing_timestamp_messages,
  (SELECT COUNT(*) FROM ticket_events AS e
    INNER JOIN period_tickets AS t ON t.id = e.ticket_id
    WHERE e.guild_id = $1
      AND e.event_type IN ('ticket.status_changed', 'ticket.claimed', 'ticket.unclaimed',
        'ticket.pending', 'ticket.resumed', 'ticket.closed', 'ticket.reopened', 'ticket.archived')
      AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz) AS lifecycle_events`;

export class PostgresAdvancedAnalyticsRepository {
  public constructor(private readonly executor: DatabaseExecutor = getPostgresPool()) {}

  public async getDepartmentBreakdown(guildId: string, startAt: string, endAt: string, filters: AnalyticsFilters = {}): Promise<DepartmentAnalytics[]> {
    const result = await this.executor.query<DepartmentAnalyticsRow>(DEPARTMENT_SQL, parameters(guildId, startAt, endAt, filters) as string[]);
    return result.rows.map((row) => ({
      departmentId: row.department_id,
      ticketsCreated: toCount(row.tickets_created),
      activeTickets: toCount(row.active_tickets),
      openTickets: toCount(row.open_tickets),
      claimedTickets: toCount(row.claimed_tickets),
      pendingTickets: toCount(row.pending_tickets),
      urgentOrCriticalTickets: toCount(row.urgent_or_critical_tickets),
      firstResolvedTickets: toCount(row.first_resolved_tickets),
      reopenedTickets: toCount(row.reopened_tickets),
      firstResponseEligible: toCount(row.first_response_eligible),
      firstResponseSamples: toCount(row.first_response_samples),
      avgFirstResponseMinutes: toMinutes(row.avg_first_response_minutes),
      avgResolutionMinutes: toMinutes(row.avg_resolution_minutes),
      oldestActiveCreatedAt: toIso(row.oldest_active_created_at),
    }));
  }

  public async getStaffBreakdown(guildId: string, startAt: string, endAt: string, filters: AnalyticsFilters = {}): Promise<StaffAnalytics[]> {
    const result = await this.executor.query<StaffAnalyticsRow>(STAFF_SQL, parameters(guildId, startAt, endAt, filters) as string[]);
    return result.rows.map((row) => ({
      staffId: row.staff_id,
      ticketsClaimed: toCount(row.tickets_claimed),
      ticketsClosed: toCount(row.tickets_closed),
      staffReplies: toCount(row.staff_replies),
      firstResponses: toCount(row.first_responses),
      activeWorkload: toCount(row.active_workload),
      avgFirstResponseMinutes: toMinutes(row.avg_first_response_minutes),
    }));
  }

  public async getTagBreakdown(guildId: string, startAt: string, endAt: string, filters: AnalyticsFilters = {}): Promise<TagAnalytics[]> {
    const result = await this.executor.query<TagAnalyticsRow>(TAG_SQL, parameters(guildId, startAt, endAt, filters) as string[]);
    return result.rows.map((row) => ({
      tagId: row.tag_id,
      ticketsCreated: toCount(row.tickets_created),
      activeTickets: toCount(row.active_tickets),
      firstResolvedTickets: toCount(row.first_resolved_tickets),
      urgentOrCriticalTickets: toCount(row.urgent_or_critical_tickets),
    }));
  }

  public async getDataCoverage(
    guildId: string,
    startAt: string,
    endAt: string,
    filters: AnalyticsFilters = {},
  ): Promise<AnalyticsDataCoverage> {
    const result = await this.executor.query<DataCoverageRow>(
      DATA_COVERAGE_SQL,
      parameters(guildId, startAt, endAt, filters) as string[],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Analytics coverage query returned no aggregate row.');
    return {
      periodTickets: toCount(row.period_tickets),
      ticketsWithCreatedEvent: toCount(row.created_event_tickets),
      messageEvents: toCount(row.message_events),
      attributedMessageEvents: toCount(row.attributed_message_events),
      unknownAuthorMessages: toCount(row.unknown_author_messages),
      missingTimestampMessages: toCount(row.missing_timestamp_messages),
      lifecycleEvents: toCount(row.lifecycle_events),
    };
  }

  public async getDailyTrends(guildId: string, startAt: string, endAt: string, filters: AnalyticsFilters = {}): Promise<DailyAnalytics[]> {
    const result = await this.executor.query<DailyAnalyticsRow>(TREND_SQL, parameters(guildId, startAt, endAt, filters) as string[]);
    return result.rows.map((row) => ({
      day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10),
      ticketsCreated: toCount(row.tickets_created),
      firstResolvedTickets: toCount(row.first_resolved_tickets),
    }));
  }
}
