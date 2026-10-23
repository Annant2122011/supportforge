import { randomUUID } from 'node:crypto';
import type { Client } from 'discord.js';
import type { QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { logTicketEvent } from './auditLogService';
import { getGuildConfig } from './configService';
import { runTrackedOperationalTask } from './operationalTaskTelemetry';
import { evaluateSlaTarget, isValidSlaScope, type SlaLifecycleEvent, type SlaTargetResult } from '../core/domain/supportSla';
import { normalizeCsatResponse } from '../core/domain/csatPolicy';
import { getPersistedTicket, getPersistedTicketById } from './ticketPersistenceService';

export type SlaPriority = 'low' | 'normal' | 'high' | 'urgent' | 'critical' | '*';

export interface SupportSlaPolicy {
  id: string;
  guildId: string;
  departmentId: string;
  priority: SlaPriority;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  pauseWhilePending: boolean;
  warningRatio: number;
  enabled: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SupportSlaPolicyInput {
  departmentId?: string | null;
  priority?: SlaPriority;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  pauseWhilePending?: boolean;
  warningRatio?: number;
  enabled?: boolean;
}

export interface SupportSlaEvaluation {
  ticketId: string;
  channelId: string;
  ticketNumber: string | null;
  status: string;
  policy: SupportSlaPolicy | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  firstResponse: SlaTargetResult | null;
  resolution: SlaTargetResult | null;
  warning: string | null;
}

export interface SupportMetrics {
  from: string;
  to: string;
  createdTickets: number;
  activeBacklog: number;
  closedTickets: number;
  reopenedBacklog: number;
  agedBacklog: number;
  measuredFirstResponses: number;
  averageFirstResponseMinutes: number | null;
  medianFirstResponseMinutes: number | null;
  averageResolutionMinutes: number | null;
  medianResolutionMinutes: number | null;
  failedOutboxEvents: number;
  metricDefinitions: string[];
}

export interface CsatSummary {
  responses: number;
  averageRating: number | null;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function boundedMinutes(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 43200) {
    throw new Error(field + ' must be a whole number between 1 and 43,200 minutes.');
  }
  return value;
}

function fromSlaRow(row: QueryResultRow & {
  id: string; guild_id: string; department_id: string; priority: string;
  first_response_minutes: number; resolution_minutes: number;
  pause_while_pending: boolean; warning_ratio: string | number; enabled: boolean;
  version: number; updated_at: Date | string; updated_by: string | null;
}): SupportSlaPolicy {
  return {
    id: row.id,
    guildId: row.guild_id,
    departmentId: row.department_id,
    priority: row.priority as SlaPriority,
    firstResponseMinutes: Number(row.first_response_minutes),
    resolutionMinutes: Number(row.resolution_minutes),
    pauseWhilePending: Boolean(row.pause_while_pending),
    warningRatio: Number(row.warning_ratio),
    enabled: Boolean(row.enabled),
    version: Number(row.version),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
    updatedBy: row.updated_by,
  };
}

const SLA_SELECT = 'SELECT id,guild_id,department_id,priority,first_response_minutes,resolution_minutes,' +
  'pause_while_pending,warning_ratio,enabled,version,updated_at,updated_by FROM support_sla_policies ';

export async function listSupportSlaPolicies(guildId: string): Promise<SupportSlaPolicy[]> {
  const result = await getPostgresPool().query(SLA_SELECT + 'WHERE guild_id=$1 ORDER BY department_id,priority', [guildId]);
  return result.rows.map((row) => fromSlaRow(row as Parameters<typeof fromSlaRow>[0]));
}

export async function saveSupportSlaPolicy(
  guildId: string,
  input: SupportSlaPolicyInput,
  actorId: string,
): Promise<SupportSlaPolicy> {
  const departmentId = input.departmentId?.trim() || '*';
  const priority = input.priority ?? '*';
  if (!isValidSlaScope(departmentId, priority)) {
    throw new Error('Choose a valid department ID and priority. Use * for all departments or priorities.');
  }
  const firstResponseMinutes = boundedMinutes(input.firstResponseMinutes, 'First-response target');
  const resolutionMinutes = boundedMinutes(input.resolutionMinutes, 'Resolution target');
  if (resolutionMinutes < firstResponseMinutes) {
    throw new Error('The resolution target must be greater than or equal to the first-response target.');
  }
  const warningRatio = input.warningRatio ?? 0.8;
  if (!Number.isFinite(warningRatio) || warningRatio < 0.5 || warningRatio > 0.99) {
    throw new Error('Warning threshold must be between 0.50 and 0.99 of the target.');
  }
  const pool = getPostgresPool();
  const result = await pool.query(
    'INSERT INTO support_sla_policies ' +
      '(id,guild_id,department_id,priority,first_response_minutes,resolution_minutes,pause_while_pending,warning_ratio,enabled,version,updated_by,created_at,updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,NOW(),NOW()) ' +
      'ON CONFLICT (guild_id,department_id,priority) DO UPDATE SET ' +
      'first_response_minutes=EXCLUDED.first_response_minutes,resolution_minutes=EXCLUDED.resolution_minutes,' +
      'pause_while_pending=EXCLUDED.pause_while_pending,warning_ratio=EXCLUDED.warning_ratio,enabled=EXCLUDED.enabled,' +
      'version=support_sla_policies.version+1,updated_by=EXCLUDED.updated_by,updated_at=NOW() ' +
      'RETURNING id,guild_id,department_id,priority,first_response_minutes,resolution_minutes,pause_while_pending,warning_ratio,enabled,version,updated_at,updated_by',
    [
      randomUUID(), guildId, departmentId, priority, firstResponseMinutes, resolutionMinutes,
      input.pauseWhilePending ?? true, warningRatio, input.enabled ?? true, actorId,
    ],
  );
  return fromSlaRow(result.rows[0] as Parameters<typeof fromSlaRow>[0]);
}

export async function deleteSupportSlaPolicy(guildId: string, policyId: string): Promise<boolean> {
  const result = await getPostgresPool().query(
    'DELETE FROM support_sla_policies WHERE guild_id=$1 AND id=$2',
    [guildId, policyId],
  );
  return (result.rowCount ?? 0) > 0;
}

async function getMatchingSlaPolicy(
  guildId: string,
  departmentId: string | null,
  priority: string | null,
): Promise<SupportSlaPolicy | null> {
  const result = await getPostgresPool().query(
    SLA_SELECT + 'WHERE guild_id=$1 AND enabled=TRUE AND department_id IN ($2,$3) AND priority IN ($4,$5) ' +
      'ORDER BY ((department_id=$2)::int + (priority=$4)::int) DESC,(department_id=$2) DESC,(priority=$4) DESC,updated_at DESC LIMIT 1',
    [guildId, departmentId ?? '*', '*', priority ?? '*', '*'],
  );
  return result.rows[0] ? fromSlaRow(result.rows[0] as Parameters<typeof fromSlaRow>[0]) : null;
}

export async function evaluateTicketSla(
  guildId: string,
  ticketId: string,
  now = new Date().toISOString(),
): Promise<SupportSlaEvaluation> {
  let ticket = await getPersistedTicketById(ticketId);
  if (!ticket) ticket = await getPersistedTicket(ticketId);
  if (!ticket || ticket.guildId !== guildId || ticket.deletedAt) {
    throw new Error('An active durable ticket in this server is required for SLA evaluation.');
  }
  const policy = await getMatchingSlaPolicy(guildId, ticket.departmentId, ticket.priority);
  if (!policy) {
    return {
      ticketId: ticket.id,
      channelId: ticket.channelId,
      ticketNumber: ticket.ticketNumber,
      status: ticket.status,
      policy: null,
      firstResponseAt: null,
      resolvedAt: null,
      firstResponse: null,
      resolution: null,
      warning: 'No enabled SLA policy matches this ticket. Add a guild-wide or more specific policy.',
    };
  }

  const pool = getPostgresPool();
  const [eventsResult, firstResponseResult] = await Promise.all([
    pool.query<QueryResultRow & { event_type: string; created_at: Date | string; payload: Record<string, unknown> | null }>(
      'SELECT event_type,created_at,payload FROM ticket_events WHERE ticket_id=$1 AND guild_id=$2 ORDER BY created_at ASC',
      [ticket.id, guildId],
    ),
    pool.query<QueryResultRow & { first_response_at: Date | string | null }>(
      'SELECT MIN(created_at) AS first_response_at FROM ticket_message_archive ' +
        'WHERE ticket_id=$1 AND guild_id=$2 AND is_bot=FALSE AND author_id<>$3 AND created_at >= $4::timestamptz',
      [ticket.id, guildId, ticket.ownerId ?? '', ticket.createdAt],
    ),
  ]);
  const events: SlaLifecycleEvent[] = eventsResult.rows.map((row) => ({
    type: row.event_type,
    occurredAt: toIso(row.created_at) ?? ticket.createdAt,
    payload: row.payload ?? {},
  }));
  const firstResponseAt = toIso(firstResponseResult.rows[0]?.first_response_at);
  const reopenedEvents = events.filter((event) => event.type === 'ticket.reopened' || event.payload?.to === 'reopened');
  const latestReopen = reopenedEvents[reopenedEvents.length - 1]?.occurredAt;
  const resolutionStartedAt = latestReopen ?? ticket.createdAt;
  const resolvedEvent = [...events].reverse().find((event) =>
    (event.type === 'ticket.closed' || event.type === 'ticket.archived') &&
    Date.parse(event.occurredAt) >= Date.parse(resolutionStartedAt),
  );
  const resolvedAt = ['closed', 'archived'].includes(ticket.status) ? resolvedEvent?.occurredAt ?? null : null;

  const firstResponse = evaluateSlaTarget({
    clockKind: 'first-response',
    startedAt: ticket.createdAt,
    observedAt: now,
    completedAt: firstResponseAt,
    currentStatus: ticket.status,
    targetMinutes: policy.firstResponseMinutes,
    warningRatio: policy.warningRatio,
    pauseWhilePending: policy.pauseWhilePending,
    events,
  });
  const resolution = evaluateSlaTarget({
    clockKind: 'resolution',
    startedAt: ticket.createdAt,
    observedAt: now,
    completedAt: resolvedAt,
    currentStatus: ticket.status,
    targetMinutes: policy.resolutionMinutes,
    warningRatio: policy.warningRatio,
    pauseWhilePending: policy.pauseWhilePending,
    events,
  });

  const warning = firstResponse.progress === 'breached'
    ? 'First-response SLA is breached.'
    : resolution.progress === 'breached'
      ? 'Resolution SLA is breached.'
      : firstResponse.progress === 'warning' || resolution.progress === 'warning'
        ? 'An SLA target is approaching its warning threshold.'
        : firstResponse.progress === 'paused' && resolution.progress === 'paused'
          ? 'SLA clocks are paused while the ticket is pending.'
          : null;

  return {
    ticketId: ticket.id,
    channelId: ticket.channelId,
    ticketNumber: ticket.ticketNumber,
    status: ticket.status,
    policy,
    firstResponseAt,
    resolvedAt,
    firstResponse,
    resolution,
    warning,
  };
}

export async function recordCsatResponse(
  guildId: string,
  ticketId: string,
  userId: string,
  rating: number,
  comment = '',
): Promise<{ id: string; ticketId: string; rating: number; createdAt: string }> {
  const normalized = normalizeCsatResponse(rating, comment);
  const normalizedRating = normalized.rating;
  const safeComment = normalized.comment;
  let ticket = await getPersistedTicketById(ticketId);
  if (!ticket) ticket = await getPersistedTicket(ticketId);
  if (!ticket || ticket.guildId !== guildId || ticket.deletedAt) {
    throw new Error('Ticket was not found in this server.');
  }
  if (ticket.ownerId !== userId) throw new Error('Only the ticket creator can submit feedback for this ticket.');
  if (ticket.status !== 'closed' && ticket.status !== 'archived') {
    throw new Error('Feedback is available only after a ticket is closed or archived.');
  }

  try {
    const result = await getPostgresPool().query<QueryResultRow & {
      id: string; ticket_id: string; rating: number; created_at: Date | string;
    }>(
      'INSERT INTO support_csat_responses (id,guild_id,ticket_id,user_id,rating,comment) VALUES ($1,$2,$3,$4,$5,$6) ' +
        'RETURNING id,ticket_id,rating,created_at',
      [randomUUID(), guildId, ticket.id, userId, normalizedRating, safeComment],
    );
    const row = result.rows[0];
    return { id: row.id, ticketId: row.ticket_id, rating: Number(row.rating), createdAt: toIso(row.created_at) ?? new Date().toISOString() };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505') {
      throw new Error('Feedback has already been submitted for this ticket. Repeat voting is disabled.');
    }
    throw error;
  }
}

export async function getCsatSummary(guildId: string, from: string, to: string): Promise<CsatSummary> {
  const result = await getPostgresPool().query<QueryResultRow & {
    responses: number | string;
    average_rating: number | string | null;
    positive_count: number | string;
    neutral_count: number | string;
    negative_count: number | string;
  }>(
    'SELECT COUNT(*)::int AS responses,AVG(rating) AS average_rating,' +
      'COUNT(*) FILTER (WHERE rating>=4)::int AS positive_count,' +
      'COUNT(*) FILTER (WHERE rating=3)::int AS neutral_count,' +
      'COUNT(*) FILTER (WHERE rating<=2)::int AS negative_count ' +
      'FROM support_csat_responses WHERE guild_id=$1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz',
    [guildId, from, to],
  );
  const row = result.rows[0];
  return {
    responses: Number(row?.responses ?? 0),
    averageRating: row?.average_rating === null || row?.average_rating === undefined ? null : Number(row.average_rating),
    positiveCount: Number(row?.positive_count ?? 0),
    neutralCount: Number(row?.neutral_count ?? 0),
    negativeCount: Number(row?.negative_count ?? 0),
  };
}


let slaScheduler: ReturnType<typeof setInterval> | null = null;

/**
 * Persist one alert per policy version, lifecycle cycle, target and severity.
 * This prevents alert spam after process restarts or when multiple workers race.
 */
async function persistSlaAlert(
  guildId: string,
  ticket: SupportSlaEvaluation,
  targetType: 'first_response' | 'resolution',
  result: SlaTargetResult,
): Promise<boolean> {
  if (!ticket.policy || (result.progress !== 'warning' && result.progress !== 'breached')) return false;
  const policy = ticket.policy;
  const cycleStartedAt = result.startedAt;
  const detail =
    (targetType === 'first_response' ? 'First-response' : 'Resolution') + ' SLA ' + result.progress +
    ' for ticket ' + (ticket.ticketNumber ?? ticket.ticketId) + '; elapsed=' + result.elapsedMinutes +
    'm; target=' + result.targetMinutes + 'm; paused=' + result.pausedMinutes + 'm; policy=' + policy.id +
    '; policyVersion=' + policy.version + '.';
  const inserted = await getPostgresPool().query<QueryResultRow & { id: string }>(
    'INSERT INTO support_sla_alerts ' +
      '(id,guild_id,ticket_id,policy_id,target_type,progress,policy_version,cycle_started_at,observed_at,detail) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,NOW(),$9) ' +
      'ON CONFLICT (guild_id,ticket_id,policy_id,target_type,progress,policy_version,cycle_started_at) DO NOTHING ' +
      'RETURNING id',
    [randomUUID(), guildId, ticket.ticketId, policy.id, targetType, result.progress, policy.version, cycleStartedAt, detail],
  );
  return inserted.rows.length > 0;
}

/** Evaluate a bounded set of active tickets and publish newly crossed SLA thresholds to the audit stream. */
export async function sweepSupportSlaAlerts(client: Client): Promise<number> {
  let alerts = 0;
  for (const guild of client.guilds.cache.values()) {
    await runTrackedOperationalTask('ticket-sla-monitor', guild.id, async () => {
      const active = await getPostgresPool().query<QueryResultRow & { id: string }>(
        "SELECT id FROM tickets WHERE guild_id=$1 AND deleted_at IS NULL " +
          "AND status IN ('open','claimed','pending','reopened') ORDER BY created_at ASC LIMIT 250",
        [guild.id],
      );
      const config = await getGuildConfig(guild.id);
      for (const row of active.rows) {
        try {
          const evaluation = await evaluateTicketSla(guild.id, row.id);
          if (!evaluation.policy || !evaluation.firstResponse || !evaluation.resolution) continue;
          const candidates: Array<{ type: 'first_response' | 'resolution'; result: SlaTargetResult }> = [
            { type: 'first_response', result: evaluation.firstResponse },
            { type: 'resolution', result: evaluation.resolution },
          ];
          for (const candidate of candidates) {
            const inserted = await persistSlaAlert(guild.id, evaluation, candidate.type, candidate.result);
            if (!inserted) continue;
            alerts += 1;
            if (config.supportCategoryId) {
              await logTicketEvent(guild, config.supportCategoryId, {
                ticketNumber: evaluation.ticketNumber ?? evaluation.ticketId.slice(0, 8),
                ticketChannelId: evaluation.channelId,
                event: 'SUPPORT_SLA_' + candidate.type.toUpperCase() + '_' + candidate.result.progress.toUpperCase(),
                actorId: 'supportforge-system',
                actor: 'ResolvX SLA monitor',
                actorName: 'ResolvX SLA monitor',
                detail: candidate.type + ' SLA ' + candidate.result.progress + '; elapsed ' +
                  candidate.result.elapsedMinutes + ' of ' + candidate.result.targetMinutes + ' minutes; policy ' +
                  evaluation.policy.id + ' v' + evaluation.policy.version + '.',
                category: 'ticket',
              });
            }
          }
        } catch (error) {
          console.warn(
            'ResolvX SLA monitor skipped ticket ' + row.id + ' after a check failure:',
            error instanceof Error ? error.message : 'unknown error',
          );
        }
      }
    });
  }
  return alerts;
}

export function startSupportSlaMonitor(client: Client): void {
  if (slaScheduler) return;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await sweepSupportSlaAlerts(client);
    } catch (error) {
      console.warn('ResolvX SLA monitor will retry:', error instanceof Error ? error.message : 'unknown error');
    } finally {
      running = false;
    }
  };
  void tick();
  slaScheduler = setInterval(() => { void tick(); }, 5 * 60 * 1000);
  slaScheduler.unref();
}

export async function getSupportMetrics(
  guildId: string,
  from: string,
  to: string,
): Promise<SupportMetrics> {
  const fromDate = Date.parse(from);
  const toDate = Date.parse(to);
  if (!Number.isFinite(fromDate) || !Number.isFinite(toDate) || toDate <= fromDate) {
    throw new Error('Metric window must contain a valid start and an end later than the start.');
  }
  if (toDate - fromDate > 366 * 24 * 60 * 60 * 1000) {
    throw new Error('Metric reports are limited to 366 days per query.');
  }

  const pool = getPostgresPool();
  const result = await pool.query<QueryResultRow & {
    created_tickets: number | string;
    active_backlog: number | string;
    closed_tickets: number | string;
    reopened_backlog: number | string;
    aged_backlog: number | string;
    measured_first_responses: number | string;
    avg_first_response_minutes: number | string | null;
    median_first_response_minutes: number | string | null;
    avg_resolution_minutes: number | string | null;
    median_resolution_minutes: number | string | null;
    failed_outbox_events: number | string;
  }>(
    `WITH period_tickets AS (
      SELECT t.id,t.guild_id,t.owner_id,t.created_at
      FROM tickets t
      WHERE t.guild_id=$1 AND t.deleted_at IS NULL
        AND t.created_at >= $2::timestamptz AND t.created_at < $3::timestamptz
    ), first_responses AS (
      SELECT t.id, EXTRACT(EPOCH FROM (MIN(m.created_at)-t.created_at))/60.0 AS response_minutes
      FROM period_tickets t
      JOIN ticket_message_archive m ON m.ticket_id=t.id AND m.guild_id=t.guild_id
      WHERE m.is_bot=FALSE AND m.author_id<>COALESCE(t.owner_id,'') AND m.created_at>=t.created_at
      GROUP BY t.id,t.created_at
    ), closed_in_period AS (
      SELECT DISTINCT ON (e.ticket_id) e.ticket_id,e.created_at AS closed_at
      FROM ticket_events e
      WHERE e.guild_id=$1 AND e.event_type IN ('ticket.closed','ticket.archived')
        AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz
      ORDER BY e.ticket_id,e.created_at DESC
    ), resolutions AS (
      SELECT t.id, EXTRACT(EPOCH FROM (c.closed_at-t.created_at))/60.0 AS resolution_minutes
      FROM closed_in_period c JOIN tickets t ON t.id=c.ticket_id
      WHERE t.guild_id=$1 AND c.closed_at>=t.created_at
    )
    SELECT
      (SELECT COUNT(*)::int FROM period_tickets) AS created_tickets,
      (SELECT COUNT(*)::int FROM tickets WHERE guild_id=$1 AND deleted_at IS NULL AND status IN ('open','claimed','pending','reopened')) AS active_backlog,
      (SELECT COUNT(*)::int FROM closed_in_period) AS closed_tickets,
      (SELECT COUNT(*)::int FROM tickets WHERE guild_id=$1 AND deleted_at IS NULL AND status='reopened') AS reopened_backlog,
      (SELECT COUNT(*)::int FROM tickets WHERE guild_id=$1 AND deleted_at IS NULL AND status IN ('open','claimed','pending','reopened') AND created_at < NOW()-INTERVAL '24 hours') AS aged_backlog,
      (SELECT COUNT(*)::int FROM first_responses) AS measured_first_responses,
      (SELECT AVG(response_minutes) FROM first_responses) AS avg_first_response_minutes,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY response_minutes) FROM first_responses) AS median_first_response_minutes,
      (SELECT AVG(resolution_minutes) FROM resolutions) AS avg_resolution_minutes,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY resolution_minutes) FROM resolutions) AS median_resolution_minutes,
      (SELECT COUNT(*)::int FROM outbox_events WHERE guild_id=$1 AND status='failed') AS failed_outbox_events`,
    [guildId, new Date(fromDate).toISOString(), new Date(toDate).toISOString()],
  );
  const row = result.rows[0];
  const optionalNumber = (value: string | number | null): number | null =>
    value === null || value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null;

  return {
    from: new Date(fromDate).toISOString(),
    to: new Date(toDate).toISOString(),
    createdTickets: Number(row.created_tickets),
    activeBacklog: Number(row.active_backlog),
    closedTickets: Number(row.closed_tickets),
    reopenedBacklog: Number(row.reopened_backlog),
    agedBacklog: Number(row.aged_backlog),
    measuredFirstResponses: Number(row.measured_first_responses),
    averageFirstResponseMinutes: optionalNumber(row.avg_first_response_minutes),
    medianFirstResponseMinutes: optionalNumber(row.median_first_response_minutes),
    averageResolutionMinutes: optionalNumber(row.avg_resolution_minutes),
    medianResolutionMinutes: optionalNumber(row.median_resolution_minutes),
    failedOutboxEvents: Number(row.failed_outbox_events),
    metricDefinitions: [
      'Ticket volume counts non-deleted tickets created within the selected window.',
      'Backlog counts currently active open, claimed, pending, or reopened tickets.',
      'First response is the first archived non-bot message authored by someone other than the ticket creator; it may be undercounted where historic messages were not archived.',
      'Resolution duration uses closure/archive event time minus ticket creation time; it does not subtract pending intervals or reset on reopen. Use per-ticket SLA evaluation for pause-aware targets.',
      'Aged backlog means currently active tickets older than 24 hours.',
      'Failed outbox count is a current point-in-time queue count, not a historical failure rate.',
    ],
  };
}
