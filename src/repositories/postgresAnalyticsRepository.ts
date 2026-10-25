import type { QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import type { DatabaseExecutor } from '../core/persistence/database';

export interface AnalyticsRollupRow extends QueryResultRow {
  tickets_created: string | number;
  active_tickets: string | number;
  open_tickets: string | number;
  claimed_tickets: string | number;
  pending_tickets: string | number;
  urgent_or_critical_tickets: string | number;
  oldest_active_created_at: Date | string | null;
  first_resolved_tickets: string | number;
  close_actions: string | number;
  reopened_tickets: string | number;
  reopened_after_first_close: string | number;
  first_response_eligible: string | number;
  first_response_samples: string | number;
  avg_first_response_minutes: string | number | null;
  avg_resolution_minutes: string | number | null;
}

export interface AnalyticsRollup {
  ticketsCreated: number;
  activeTickets: number;
  openTickets: number;
  claimedTickets: number;
  pendingTickets: number;
  urgentOrCriticalTickets: number;
  oldestActiveCreatedAt: string | null;
  firstResolvedTickets: number;
  closeActions: number;
  reopenedTickets: number;
  reopenedAfterFirstClose: number;
  firstResponseEligible: number;
  firstResponseSamples: number;
  avgFirstResponseMinutes: number | null;
  avgResolutionMinutes: number | null;
}

const ANALYTICS_ROLLUP_SQL = \`
WITH period_tickets AS (
  SELECT t.id, t.created_at
  FROM tickets AS t
  WHERE t.guild_id = $1
    AND t.deleted_at IS NULL
    AND t.created_at >= $2::timestamptz
    AND t.created_at < $3::timestamptz
),
first_customer_message AS (
  SELECT e.ticket_id, MIN(e.created_at) AS first_customer_at
  FROM ticket_events AS e
  INNER JOIN period_tickets AS t ON t.id = e.ticket_id
  WHERE e.guild_id = $1
    AND e.event_type = 'ticket.message.received'
    AND e.payload->>'messageAuthorType' = 'customer'
    AND e.created_at >= t.created_at
    AND e.created_at < $3::timestamptz
  GROUP BY e.ticket_id
),
first_staff_response AS (
  SELECT c.ticket_id,
         c.first_customer_at,
         MIN(e.created_at) AS first_staff_at
  FROM first_customer_message AS c
  INNER JOIN ticket_events AS e
    ON e.ticket_id = c.ticket_id
   AND e.guild_id = $1
   AND e.event_type = 'ticket.message.received'
   AND e.payload->>'messageAuthorType' = 'staff'
   AND e.created_at > c.first_customer_at
   AND e.created_at < $3::timestamptz
  GROUP BY c.ticket_id, c.first_customer_at
),
first_closure AS (
  SELECT e.ticket_id, MIN(e.created_at) AS first_closed_at
  FROM ticket_events AS e
  INNER JOIN tickets AS t ON t.id = e.ticket_id
  WHERE e.guild_id = $1
    AND e.event_type = 'ticket.closed'
    AND t.deleted_at IS NULL
  GROUP BY e.ticket_id
),
resolved_in_period AS (
  SELECT f.ticket_id, f.first_closed_at, t.created_at
  FROM first_closure AS f
  INNER JOIN tickets AS t ON t.id = f.ticket_id
  WHERE f.first_closed_at >= $2::timestamptz
    AND f.first_closed_at < $3::timestamptz
    AND t.guild_id = $1
    AND t.deleted_at IS NULL
)
SELECT
  (SELECT COUNT(*) FROM period_tickets) AS tickets_created,
  (SELECT COUNT(*) FROM tickets
    WHERE guild_id = $1 AND deleted_at IS NULL
      AND status IN ('open', 'claimed', 'pending', 'reopened')) AS active_tickets,
  (SELECT COUNT(*) FROM tickets
    WHERE guild_id = $1 AND deleted_at IS NULL AND status IN ('open', 'reopened')) AS open_tickets,
  (SELECT COUNT(*) FROM tickets
    WHERE guild_id = $1 AND deleted_at IS NULL AND status = 'claimed') AS claimed_tickets,
  (SELECT COUNT(*) FROM tickets
    WHERE guild_id = $1 AND deleted_at IS NULL AND status = 'pending') AS pending_tickets,
  (SELECT COUNT(*) FROM tickets
    WHERE guild_id = $1 AND deleted_at IS NULL
      AND status IN ('open', 'claimed', 'pending', 'reopened')
      AND LOWER(COALESCE(priority, 'normal')) IN ('urgent', 'critical')) AS urgent_or_critical_tickets,
  (SELECT MIN(created_at) FROM tickets
    WHERE guild_id = $1 AND deleted_at IS NULL
      AND status IN ('open', 'claimed', 'pending', 'reopened')) AS oldest_active_created_at,
  (SELECT COUNT(*) FROM resolved_in_period) AS first_resolved_tickets,
  (SELECT COUNT(*) FROM ticket_events
    WHERE guild_id = $1 AND event_type = 'ticket.closed'
      AND created_at >= $2::timestamptz AND created_at < $3::timestamptz) AS close_actions,
  (SELECT COUNT(DISTINCT ticket_id) FROM ticket_events
    WHERE guild_id = $1 AND event_type = 'ticket.reopened'
      AND created_at >= $2::timestamptz AND created_at < $3::timestamptz) AS reopened_tickets,
  (SELECT COUNT(DISTINCT r.ticket_id)
    FROM resolved_in_period AS r
    WHERE EXISTS (
      SELECT 1 FROM ticket_events AS e
      WHERE e.guild_id = $1 AND e.ticket_id = r.ticket_id
        AND e.event_type = 'ticket.reopened'
        AND e.created_at > r.first_closed_at
        AND e.created_at < $3::timestamptz
    )) AS reopened_after_first_close,
  (SELECT COUNT(*) FROM first_customer_message) AS first_response_eligible,
  (SELECT COUNT(*) FROM first_staff_response) AS first_response_samples,
  (SELECT AVG(EXTRACT(EPOCH FROM (r.first_staff_at - r.first_customer_at)) / 60.0)
    FROM first_staff_response AS r) AS avg_first_response_minutes,
  (SELECT AVG(EXTRACT(EPOCH FROM (r.first_closed_at - r.created_at)) / 60.0)
    FROM resolved_in_period AS r) AS avg_resolution_minutes
\`;

function toCount(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

function toMinutes(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 10) / 10;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export class PostgresAnalyticsRepository {
  public constructor(
    private readonly executor: DatabaseExecutor = getPostgresPool(),
  ) {}

  public async getGuildRollup(
    guildId: string,
    startAt: string,
    endAt: string,
  ): Promise<AnalyticsRollup> {
    const result = await this.executor.query<AnalyticsRollupRow>(
      ANALYTICS_ROLLUP_SQL,
      [guildId, startAt, endAt],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Analytics query returned no aggregate row.');
    }

    return {
      ticketsCreated: toCount(row.tickets_created),
      activeTickets: toCount(row.active_tickets),
      openTickets: toCount(row.open_tickets),
      claimedTickets: toCount(row.claimed_tickets),
      pendingTickets: toCount(row.pending_tickets),
      urgentOrCriticalTickets: toCount(row.urgent_or_critical_tickets),
      oldestActiveCreatedAt: toIso(row.oldest_active_created_at),
      firstResolvedTickets: toCount(row.first_resolved_tickets),
      closeActions: toCount(row.close_actions),
      reopenedTickets: toCount(row.reopened_tickets),
      reopenedAfterFirstClose: toCount(row.reopened_after_first_close),
      firstResponseEligible: toCount(row.first_response_eligible),
      firstResponseSamples: toCount(row.first_response_samples),
      avgFirstResponseMinutes: toMinutes(row.avg_first_response_minutes),
      avgResolutionMinutes: toMinutes(row.avg_resolution_minutes),
    };
  }
}
