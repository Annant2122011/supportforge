import { randomUUID } from 'node:crypto';
import { ChannelType, type Client } from 'discord.js';
import type { QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { logTicketEvent } from './auditLogService';
import { getGuildConfig } from './configService';
import { runTrackedOperationalTask } from './operationalTaskTelemetry';
import { evaluateSlaTarget, findFirstClaimAt, findFirstResolutionAt, isValidSlaScope, type SlaLifecycleEvent, type SlaTargetResult } from '../core/domain/supportSla';
import { normalizeCsatResponse } from '../core/domain/csatPolicy';
import { getPersistedTicket, getPersistedTicketById } from './ticketPersistenceService';
import { getSupportHoursPolicies, resolveEffectiveSupportHoursPolicy } from './supportHoursService';

export type SlaPriority = 'low' | 'normal' | 'high' | 'urgent' | 'critical' | '*';

export interface SupportSlaPolicy {
  id: string;
  guildId: string;
  departmentId: string;
  priority: SlaPriority;
  firstResponseMinutes: number;
  claimMinutes: number;
  resolutionMinutes: number;
  pauseWhilePending: boolean;
  useBusinessHours: boolean;
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
  claimMinutes?: number;
  resolutionMinutes: number;
  pauseWhilePending?: boolean;
  useBusinessHours?: boolean;
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
  firstResponseCoverage?: 'complete' | 'incomplete';
  claimedAt: string | null;
  resolvedAt: string | null;
  firstResponse: SlaTargetResult | null;
  claim: SlaTargetResult | null;
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
  first_response_minutes: number; claim_minutes: number; resolution_minutes: number;
  pause_while_pending: boolean; use_business_hours: boolean; warning_ratio: string | number; enabled: boolean;
  version: number; updated_at: Date | string; updated_by: string | null;
}): SupportSlaPolicy {
  return {
    id: row.id,
    guildId: row.guild_id,
    departmentId: row.department_id,
    priority: row.priority as SlaPriority,
    firstResponseMinutes: Number(row.first_response_minutes),
    claimMinutes: Number(row.claim_minutes),
    resolutionMinutes: Number(row.resolution_minutes),
    pauseWhilePending: Boolean(row.pause_while_pending),
    useBusinessHours: Boolean(row.use_business_hours),
    warningRatio: Number(row.warning_ratio),
    enabled: Boolean(row.enabled),
    version: Number(row.version),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
    updatedBy: row.updated_by,
  };
}

const SLA_SELECT = 'SELECT id,guild_id,department_id,priority,first_response_minutes,claim_minutes,resolution_minutes,' +
  'pause_while_pending,use_business_hours,warning_ratio,enabled,version,updated_at,updated_by FROM support_sla_policies ';

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
  const claimMinutes = boundedMinutes(input.claimMinutes ?? 60, 'Claim target');
  const resolutionMinutes = boundedMinutes(input.resolutionMinutes, 'Resolution target');
  if (resolutionMinutes < firstResponseMinutes) {
    throw new Error('The resolution target must be greater than or equal to the first-response target.');
  }
  const warningRatio = input.warningRatio ?? 0.8;
  if (!Number.isFinite(warningRatio) || warningRatio < 0.5 || warningRatio > 0.99) {
    throw new Error('Warning threshold must be between 0.50 and 0.99 of the target.');
  }
  const pool = getPostgresPool();
  const connection = await pool.connect();
  let saved: SupportSlaPolicy;
  try {
    await connection.query('BEGIN');
    const result = await connection.query(
      'INSERT INTO support_sla_policies ' +
        '(id,guild_id,department_id,priority,first_response_minutes,claim_minutes,resolution_minutes,pause_while_pending,use_business_hours,warning_ratio,enabled,version,updated_by,created_at,updated_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,NOW(),NOW()) ' +
        'ON CONFLICT (guild_id,department_id,priority) DO UPDATE SET ' +
        'first_response_minutes=EXCLUDED.first_response_minutes,claim_minutes=EXCLUDED.claim_minutes,resolution_minutes=EXCLUDED.resolution_minutes,' +
        'pause_while_pending=EXCLUDED.pause_while_pending,use_business_hours=EXCLUDED.use_business_hours,warning_ratio=EXCLUDED.warning_ratio,enabled=EXCLUDED.enabled,' +
        'version=support_sla_policies.version+1,updated_by=EXCLUDED.updated_by,updated_at=NOW() ' +
        'RETURNING id,guild_id,department_id,priority,first_response_minutes,claim_minutes,resolution_minutes,pause_while_pending,use_business_hours,warning_ratio,enabled,version,updated_at,updated_by',
      [
        randomUUID(), guildId, departmentId, priority, firstResponseMinutes, claimMinutes, resolutionMinutes,
        input.pauseWhilePending ?? true, input.useBusinessHours ?? false, warningRatio, input.enabled ?? true, actorId,
      ],
    );
    saved = fromSlaRow(result.rows[0] as Parameters<typeof fromSlaRow>[0]);
    await connection.query(
      'INSERT INTO support_sla_policy_versions (id,guild_id,policy_id,policy_version,snapshot,actor_id) ' +
        'VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (policy_id,policy_version) DO NOTHING',
      [randomUUID(), guildId, saved.id, saved.version, JSON.stringify(saved), actorId],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
  return saved;
}

export async function deleteSupportSlaPolicy(guildId: string, policyId: string): Promise<boolean> {
  // Retire rather than physically delete. Alert rows and their policy-version references
  // are historical evidence and must not disappear via ON DELETE CASCADE.
  const result = await getPostgresPool().query(
    'UPDATE support_sla_policies SET enabled=FALSE,version=version+1,updated_at=NOW() ' +
      'WHERE guild_id=$1 AND id=$2 AND enabled=TRUE',
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
      claimedAt: null,
      resolvedAt: null,
      firstResponse: null,
      claim: null,
      resolution: null,
      warning: 'No enabled SLA policy matches this ticket. Add a guild-wide or more specific policy.',
    };
  }

  let businessTime: { timezone: string; weeklySchedule: import('./supportHoursService').SupportHoursWeeklySchedule } | undefined;
  if (policy.useBusinessHours) {
    const supportHoursPolicies = await getSupportHoursPolicies(guildId);
    const effectiveHours = resolveEffectiveSupportHoursPolicy(supportHoursPolicies, {
      departmentId: ticket.departmentId ?? undefined,
    });
    if (!effectiveHours || !effectiveHours.enabled) {
      return {
        ticketId: ticket.id,
        channelId: ticket.channelId,
        ticketNumber: ticket.ticketNumber,
        status: ticket.status,
        policy,
        firstResponseAt: null,
        claimedAt: null,
        resolvedAt: null,
        firstResponse: null,
        claim: null,
        resolution: null,
        warning: 'This SLA policy uses business time, but no enabled support-hours policy applies to this ticket. The clock is not inferred.',
      };
    }
    businessTime = { timezone: effectiveHours.timezone, weeklySchedule: effectiveHours.weeklySchedule };
  }

  const pool = getPostgresPool();
  const [eventsResult, firstResponseResult] = await Promise.all([
    pool.query<QueryResultRow & { event_type: string; created_at: Date | string; payload: Record<string, unknown> | null }>(
      'SELECT event_type,created_at,payload FROM ticket_events WHERE ticket_id=$1 AND guild_id=$2 ORDER BY created_at ASC',
      [ticket.id, guildId],
    ),
    pool.query<QueryResultRow & {
      first_response_at: Date | string | null;
      backfill_complete: boolean;
      author_classification_complete: boolean;
    }>(
      'SELECT MIN(m.created_at) FILTER (WHERE m.is_bot=FALSE AND m.author_id<>$3 AND EXISTS (' +
        "SELECT 1 FROM ticket_events e WHERE e.ticket_id=m.ticket_id AND e.guild_id=m.guild_id " +
        "AND e.payload->>'messageId'=m.message_id AND e.payload->>'messageAuthorType'='staff')) AS first_response_at, " +
        'COALESCE((SELECT a.backfill_complete FROM ticket_channel_archive a WHERE a.ticket_id=$1 AND a.guild_id=$2 LIMIT 1),FALSE) AS backfill_complete, ' +
        "NOT EXISTS (SELECT 1 FROM ticket_message_archive m2 WHERE m2.ticket_id=$1 AND m2.guild_id=$2 AND m2.is_bot=FALSE AND m2.author_id<>$3 " +
        "AND NOT EXISTS (SELECT 1 FROM ticket_events e2 WHERE e2.ticket_id=m2.ticket_id AND e2.guild_id=m2.guild_id " +
        "AND e2.payload->>'messageId'=m2.message_id AND e2.payload ? 'messageAuthorType')) AS author_classification_complete " +
        'FROM ticket_message_archive m WHERE m.ticket_id=$1 AND m.guild_id=$2 AND m.created_at >= $4::timestamptz',
      [ticket.id, guildId, ticket.ownerId ?? '', ticket.createdAt],
    ),
  ]);
  const events: SlaLifecycleEvent[] = eventsResult.rows.map((row) => ({
    type: row.event_type,
    occurredAt: toIso(row.created_at) ?? ticket.createdAt,
    payload: row.payload ?? {},
  }));
  const firstResponseRow = firstResponseResult.rows[0];
  const firstResponseAt = toIso(firstResponseRow?.first_response_at);
  const firstResponseCoverage: 'complete' | 'incomplete' =
    firstResponseRow?.backfill_complete && firstResponseRow?.author_classification_complete ? 'complete' : 'incomplete';
  const claimedAt = findFirstClaimAt(events, ticket.createdAt);
  const reopenedEvents = events.filter((event) => event.type === 'ticket.reopened' || event.payload?.to === 'reopened');
  const latestReopen = reopenedEvents[reopenedEvents.length - 1]?.occurredAt;
  const resolutionStartedAt = latestReopen ?? ticket.createdAt;
  const resolvedAt = ['closed', 'archived'].includes(ticket.status)
    ? findFirstResolutionAt(events, resolutionStartedAt)
    : null;

  const firstResponse = firstResponseAt || firstResponseCoverage === 'complete'
    ? evaluateSlaTarget({
        clockKind: 'first-response',
        startedAt: ticket.createdAt,
        observedAt: now,
        completedAt: firstResponseAt,
        currentStatus: ticket.status,
        targetMinutes: policy.firstResponseMinutes,
        warningRatio: policy.warningRatio,
        pauseWhilePending: policy.pauseWhilePending,
        events,
        businessTime,
      })
    : null;
  const claim = evaluateSlaTarget({
    clockKind: 'claim',
    startedAt: ticket.createdAt,
    observedAt: now,
    completedAt: claimedAt,
    currentStatus: ticket.status,
    targetMinutes: policy.claimMinutes,
    warningRatio: policy.warningRatio,
    pauseWhilePending: policy.pauseWhilePending,
    events,
    businessTime,
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
    businessTime,
  });

  const warning = !firstResponse
    ? 'First-response SLA coverage is incomplete because archived human-message attribution is missing; no first-response breach is inferred.'
    : firstResponse.progress === 'breached'
      ? 'First-response SLA is breached.'
      : claim.progress === 'breached'
      ? 'Claim SLA is breached.'
      : resolution.progress === 'breached'
        ? 'Resolution SLA is breached.'
        : firstResponse.progress === 'warning' || claim.progress === 'warning' || resolution.progress === 'warning'
          ? 'An SLA target is approaching its warning threshold.'
          : firstResponse.progress === 'paused' && claim.progress === 'paused' && resolution.progress === 'paused'
            ? 'SLA clocks are paused while the ticket is pending.'
            : null;

  return {
    ticketId: ticket.id,
    channelId: ticket.channelId,
    ticketNumber: ticket.ticketNumber,
    status: ticket.status,
    policy,
    firstResponseAt,
    firstResponseCoverage,
    claimedAt,
    resolvedAt,
    firstResponse,
    claim,
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


export interface SupportQueueItem {
  ticketId: string;
  channelId: string;
  ticketNumber: string | null;
  status: string;
  priority: string;
  departmentId: string | null;
  claimedByIds: string[];
  createdAt: string;
  ageMinutes: number;
  riskScore: number;
}

export interface SupportQueueSnapshot {
  id: string;
  guildId: string;
  createdAt: string;
  items: SupportQueueItem[];
}

export interface SupportSlaNotificationRoute {
  guildId: string;
  channelId: string;
  supervisorRoleId: string | null;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

export async function getSupportSlaNotificationRoute(guildId: string): Promise<SupportSlaNotificationRoute | null> {
  const result = await getPostgresPool().query<QueryResultRow & {
    guild_id: string; channel_id: string; supervisor_role_id: string | null;
    enabled: boolean; updated_by: string; updated_at: Date | string;
  }>(
    'SELECT guild_id,channel_id,supervisor_role_id,enabled,updated_by,updated_at ' +
      'FROM support_sla_notification_routes WHERE guild_id=$1',
    [guildId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    supervisorRoleId: row.supervisor_role_id,
    enabled: Boolean(row.enabled),
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export async function saveSupportSlaNotificationRoute(
  guildId: string,
  channelId: string,
  supervisorRoleId: string | null,
  actorId: string,
): Promise<SupportSlaNotificationRoute> {
  const channel = channelId.trim();
  const role = supervisorRoleId?.trim() || null;
  if (!/^\d{17,20}$/.test(channel)) throw new Error('Choose a valid Discord text-channel ID.');
  if (role !== null && !/^\d{17,20}$/.test(role)) throw new Error('Choose a valid Discord supervisor-role ID or leave it blank.');
  const result = await getPostgresPool().query<QueryResultRow & {
    guild_id: string; channel_id: string; supervisor_role_id: string | null;
    enabled: boolean; updated_by: string; updated_at: Date | string;
  }>(
    'INSERT INTO support_sla_notification_routes (guild_id,channel_id,supervisor_role_id,enabled,updated_by,updated_at) ' +
      'VALUES ($1,$2,$3,TRUE,$4,NOW()) ON CONFLICT (guild_id) DO UPDATE SET ' +
      'channel_id=EXCLUDED.channel_id,supervisor_role_id=EXCLUDED.supervisor_role_id,enabled=TRUE,' +
      'updated_by=EXCLUDED.updated_by,updated_at=NOW() ' +
      'RETURNING guild_id,channel_id,supervisor_role_id,enabled,updated_by,updated_at',
    [guildId, channel, role, actorId],
  );
  const row = result.rows[0]!;
  return {
    guildId: row.guild_id, channelId: row.channel_id, supervisorRoleId: row.supervisor_role_id,
    enabled: Boolean(row.enabled), updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

export async function disableSupportSlaNotificationRoute(guildId: string, actorId: string): Promise<boolean> {
  const result = await getPostgresPool().query(
    'UPDATE support_sla_notification_routes SET enabled=FALSE,updated_by=$2,updated_at=NOW() WHERE guild_id=$1 AND enabled=TRUE',
    [guildId, actorId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function createSupportQueueSnapshot(
  guildId: string,
  actorId: string,
  limit = 20,
): Promise<SupportQueueSnapshot> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const result = await getPostgresPool().query<QueryResultRow & {
    id: string; channel_id: string; ticket_number: string | null; status: string;
    priority: string | null; department_id: string | null; claimed_by_ids: string[] | null;
    created_at: Date | string;
  }>(
    "SELECT id,channel_id,ticket_number,status,priority,department_id,claimed_by_ids,created_at " +
      "FROM tickets WHERE guild_id=$1 AND deleted_at IS NULL " +
      "AND status IN ('open','claimed','pending','reopened') " +
      "ORDER BY CASE priority WHEN 'critical' THEN 5 WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END DESC," +
      "created_at ASC LIMIT $2",
    [guildId, safeLimit],
  );
  const now = Date.now();
  const items: SupportQueueItem[] = result.rows.map((row) => {
    const createdAt = toIso(row.created_at) ?? new Date(0).toISOString();
    const ageMinutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60_000));
    const priority = ['low', 'normal', 'high', 'urgent', 'critical'].includes(String(row.priority))
      ? String(row.priority)
      : 'normal';
    const priorityWeight: Record<string, number> = { low: 1, normal: 2, high: 3, urgent: 4, critical: 5 };
    return {
      ticketId: row.id,
      channelId: row.channel_id,
      ticketNumber: row.ticket_number,
      status: row.status,
      priority,
      departmentId: row.department_id,
      claimedByIds: Array.isArray(row.claimed_by_ids) ? row.claimed_by_ids : [],
      createdAt,
      ageMinutes,
      riskScore: (priorityWeight[priority] ?? 2) * 1_000_000 + Math.min(ageMinutes, 999_999),
    };
  }).sort((a, b) => b.riskScore - a.riskScore);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const snapshot = { id, guildId, createdAt, items };
  await getPostgresPool().query(
    'INSERT INTO support_sla_queue_snapshots (id,guild_id,created_by,filters,items,item_count,created_at) ' +
      'VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::timestamptz)',
    [id, guildId, actorId, JSON.stringify({ limit: safeLimit, sort: 'priority_then_age' }), JSON.stringify(items), items.length, createdAt],
  );
  return snapshot;
}

export interface SupportSlaAlertSummary {
  id: string;
  ticketId: string;
  channelId: string;
  ticketNumber: string | null;
  targetType: string;
  progress: string;
  policyVersion: number;
  deliveryStatus: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  observedAt: string;
  detail: string;
}

export async function listRecentSupportSlaAlerts(guildId: string, limit = 10): Promise<SupportSlaAlertSummary[]> {
  const safeLimit = Math.max(1, Math.min(30, Math.trunc(limit)));
  const result = await getPostgresPool().query<QueryResultRow & {
    id: string; ticket_id: string; channel_id: string; ticket_number: string | null;
    target_type: string; progress: string; policy_version: number; delivery_status: string;
    acknowledged_by: string | null; acknowledged_at: Date | string | null;
    observed_at: Date | string; detail: string;
  }>(
    'SELECT a.id,a.ticket_id,t.channel_id,t.ticket_number,a.target_type,a.progress,a.policy_version,a.delivery_status,' +
      'a.acknowledged_by,a.acknowledged_at,a.observed_at,a.detail ' +
      'FROM support_sla_alerts a JOIN tickets t ON t.id=a.ticket_id ' +
      'WHERE a.guild_id=$1 ORDER BY a.observed_at DESC LIMIT $2',
    [guildId, safeLimit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    channelId: row.channel_id,
    ticketNumber: row.ticket_number,
    targetType: row.target_type,
    progress: row.progress,
    policyVersion: Number(row.policy_version),
    deliveryStatus: row.delivery_status,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: toIso(row.acknowledged_at),
    observedAt: toIso(row.observed_at) ?? new Date(0).toISOString(),
    detail: row.detail,
  }));
}

export async function acknowledgeSupportSlaAlert(
  guildId: string,
  alertId: string,
  actorId: string,
): Promise<boolean> {
  const result = await getPostgresPool().query(
    'UPDATE support_sla_alerts SET acknowledged_by=$3,acknowledged_at=NOW() ' +
      'WHERE guild_id=$1 AND id=$2 AND acknowledged_at IS NULL',
    [guildId, alertId, actorId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface SupportSlaEscalationPreview {
  id: string;
  ticketId: string;
  policyId: string;
  policyVersion: number;
  status: string;
  warning: string | null;
  findings: string[];
  expiresAt: string;
}

export async function createSupportSlaEscalationPreview(
  guildId: string,
  ticketId: string,
  actorId: string,
): Promise<SupportSlaEscalationPreview> {
  const evaluation = await evaluateTicketSla(guildId, ticketId);
  if (!evaluation.policy || !evaluation.firstResponse || !evaluation.claim || !evaluation.resolution) {
    throw new Error(evaluation.warning ?? 'A complete SLA evaluation is required before escalation preview.');
  }
  if (['closed', 'archived'].includes(evaluation.status)) {
    throw new Error('Escalation preview is available only for active tickets.');
  }
  const findings: string[] = [];
  for (const [label, result] of [
    ['First response', evaluation.firstResponse],
    ['Staff claim', evaluation.claim],
    ['Resolution', evaluation.resolution],
  ] as const) {
    if (result.progress === 'breached') findings.push(label + ' target is breached by ' + Math.max(0, result.elapsedMinutes - result.targetMinutes) + ' minutes.');
    else if (result.progress === 'warning') findings.push(label + ' target is approaching its warning threshold.');
    else if (result.progress === 'paused') findings.push(label + ' clock is paused.');
  }
  if (!findings.length) findings.push('No warning/breach is currently supported by the recorded SLA clocks.');
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const preview = {
    ticketId: evaluation.ticketId, channelId: evaluation.channelId, status: evaluation.status,
    policyId: evaluation.policy.id, policyVersion: evaluation.policy.version, findings,
    allowlistedActions: ['notify_configured_sla_route'],
    blockedActions: ['automatic_reassignment', 'automatic_priority_change'],
  };
  await getPostgresPool().query(
    'INSERT INTO support_sla_escalation_previews ' +
      '(id,guild_id,ticket_id,policy_id,policy_version,lifecycle_cycle_started_at,preview,created_by,expires_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb,$8,$9::timestamptz)',
    [id, guildId, evaluation.ticketId, evaluation.policy.id, evaluation.policy.version,
      evaluation.resolution.startedAt, JSON.stringify(preview), actorId, expiresAt],
  );
  return {
    id, ticketId: evaluation.ticketId, policyId: evaluation.policy.id,
    policyVersion: evaluation.policy.version, status: evaluation.status,
    warning: evaluation.warning, findings, expiresAt,
  };
}

export async function executeSupportSlaEscalationPreview(
  client: Client,
  guildId: string,
  previewId: string,
  actorId: string,
): Promise<{ delivered: boolean; message: string }> {
  const pool = getPostgresPool();
  const result = await pool.query<QueryResultRow & {
    id: string; ticket_id: string; policy_id: string; policy_version: number;
    lifecycle_cycle_started_at: Date | string; preview: Record<string, unknown>;
    expires_at: Date | string; execution_status: string;
  }>(
    'SELECT id,ticket_id,policy_id,policy_version,lifecycle_cycle_started_at,preview,expires_at,execution_status ' +
      'FROM support_sla_escalation_previews WHERE guild_id=$1 AND id=$2',
    [guildId, previewId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('No escalation preview with that ID exists in this server.');
  if (Date.parse(toIso(row.expires_at) ?? '') <= Date.now()) throw new Error('This escalation preview expired. Create a fresh preview.');
  if (row.execution_status !== 'preview') throw new Error('This escalation preview has already been used. Create a fresh preview before another attempt.');

  const evaluation = await evaluateTicketSla(guildId, row.ticket_id);
  if (!evaluation.policy || evaluation.policy.id !== row.policy_id || evaluation.policy.version !== Number(row.policy_version)) {
    throw new Error('The SLA policy changed after this preview. Create a fresh preview.');
  }
  if (['closed', 'archived'].includes(evaluation.status)) throw new Error('The ticket is no longer active; escalation was not sent.');
  const expectedCycle = toIso(row.lifecycle_cycle_started_at);
  const currentCycle = evaluation.resolution?.startedAt ?? null;
  if (!expectedCycle || !currentCycle || Date.parse(expectedCycle) !== Date.parse(currentCycle)) {
    throw new Error('The ticket lifecycle changed after this preview. Create a fresh preview.');
  }

  const claimed = await pool.query(
    "UPDATE support_sla_escalation_previews SET execution_status='attempted',executed_at=NOW(),executed_by=$3,execution_error=NULL " +
      "WHERE guild_id=$1 AND id=$2 AND execution_status='preview' AND expires_at>NOW() RETURNING id",
    [guildId, previewId, actorId],
  );
  if (!claimed.rows.length) throw new Error('This preview expired or was already used by another request.');

  try {
    const route = await getSupportSlaNotificationRoute(guildId);
    if (!route || !route.enabled) throw new Error('No enabled SLA notification route is configured. Create a new preview after configuring one.');
    const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(route.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error('The configured SLA alert destination is missing or is not a text channel.');

    const roleMention = route.supervisorRoleId ? '<@&' + route.supervisorRoleId + '> ' : '';
    const findings = Array.isArray(row.preview.findings)
      ? (row.preview.findings as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
    const message = roleMention + 'QueryFixr SLA escalation for <#' + evaluation.channelId + '> (' +
      (evaluation.ticketNumber ? '#' + evaluation.ticketNumber : evaluation.ticketId.slice(0, 8)) + ').\n' +
      'Requested manually by <@' + actorId + '>. Policy ' + evaluation.policy.id + ' v' + evaluation.policy.version + '.\n' +
      (findings.length ? findings.join('\n') : 'Review the ticket SLA clocks.');
    const sent = await channel.send({
      content: message.slice(0, 1900),
      allowedMentions: { parse: [], roles: route.supervisorRoleId ? [route.supervisorRoleId] : [] },
    });
    await pool.query(
      "UPDATE support_sla_escalation_previews SET execution_status='delivered',delivery_message_id=$3,execution_error=NULL " +
        'WHERE guild_id=$1 AND id=$2',
      [guildId, previewId, sent.id],
    );
    return { delivered: true, message: 'Escalation sent to the configured SLA route. Message ID: ' + sent.id };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : 'Unknown delivery error').slice(0, 1000);
    await pool.query(
      "UPDATE support_sla_escalation_previews SET execution_status='failed',execution_error=$3 " +
        'WHERE guild_id=$1 AND id=$2',
      [guildId, previewId, reason],
    ).catch(() => undefined);
    throw error;
  }
}

let slaScheduler: ReturnType<typeof setInterval> | null = null;

type SlaAlertTarget = 'first_response' | 'claim' | 'resolution';

/**
 * Return the durable alert ID whether newly inserted or already present.
 * An existing intent is still eligible for delivery retry after process failure.
 */
async function persistSlaAlert(
  guildId: string,
  ticket: SupportSlaEvaluation,
  targetType: SlaAlertTarget,
  result: SlaTargetResult,
): Promise<{ id: string; created: boolean } | null> {
  if (!ticket.policy || (result.progress !== 'warning' && result.progress !== 'breached')) return null;
  const policy = ticket.policy;
  const cycleStartedAt = result.startedAt;
  const targetLabel = targetType === 'first_response' ? 'First-response' : targetType === 'claim' ? 'Claim' : 'Resolution';
  const detail =
    targetLabel + ' SLA ' + result.progress +
    ' for ticket ' + (ticket.ticketNumber ?? ticket.ticketId) + '; elapsed=' + result.elapsedMinutes +
    'm; target=' + result.targetMinutes + 'm; paused=' + result.pausedMinutes + 'm; policy=' + policy.id +
    '; policyVersion=' + policy.version + '.';
  const pool = getPostgresPool();
  const inserted = await pool.query<QueryResultRow & { id: string }>(
    'INSERT INTO support_sla_alerts ' +
      '(id,guild_id,ticket_id,policy_id,target_type,progress,policy_version,cycle_started_at,observed_at,detail,delivery_status,delivery_next_attempt_at) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,NOW(),$9,'pending',NOW()) " +
      'ON CONFLICT (guild_id,ticket_id,policy_id,target_type,progress,policy_version,cycle_started_at) DO NOTHING ' +
      'RETURNING id',
    [randomUUID(), guildId, ticket.ticketId, policy.id, targetType, result.progress, policy.version, cycleStartedAt, detail],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const existing = await pool.query<QueryResultRow & { id: string }>(
    'SELECT id FROM support_sla_alerts WHERE guild_id=$1 AND ticket_id=$2 AND policy_id=$3 AND target_type=$4 ' +
      'AND progress=$5 AND policy_version=$6 AND cycle_started_at=$7::timestamptz LIMIT 1',
    [guildId, ticket.ticketId, policy.id, targetType, result.progress, policy.version, cycleStartedAt],
  );
  return existing.rows[0] ? { id: existing.rows[0].id, created: false } : null;
}

async function deliverPendingSlaAlerts(guildId: string, client: Client): Promise<number> {
  const route = await getSupportSlaNotificationRoute(guildId);
  // Keep pending intents queued when a server has not configured a destination.
  if (!route || !route.enabled) return 0;

  const pool = getPostgresPool();
  const due = await pool.query<QueryResultRow & {
    id: string; ticket_id: string; target_type: string; progress: string;
    policy_version: number; detail: string; delivery_attempts: number;
    channel_id: string; ticket_number: string | null;
  }>(
    "SELECT a.id,a.ticket_id,a.target_type,a.progress,a.policy_version,a.detail,a.delivery_attempts," +
      "t.channel_id,t.ticket_number " +
      "FROM support_sla_alerts a JOIN tickets t ON t.id=a.ticket_id " +
      "WHERE a.guild_id=$1 AND a.delivery_status IN ('pending','failed') AND a.delivery_next_attempt_at<=NOW() " +
      "ORDER BY a.observed_at ASC LIMIT 20",
    [guildId],
  );
  if (!due.rows.length) return 0;

  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
  let failures = 0;
  for (const alert of due.rows) {
    try {
      const channel = await guild.channels.fetch(route.channelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new Error('Configured SLA notification destination is missing or is not a text channel.');
      }
      const roleMention = route.supervisorRoleId ? '<@&' + route.supervisorRoleId + '> ' : '';
      const message = roleMention + '⏱️ **QueryFixr SLA ' + alert.progress.toUpperCase() + '**\n' +
        alert.detail + '\nTicket: <#' + alert.channel_id + '> (' +
        (alert.ticket_number ? '#' + alert.ticket_number : alert.ticket_id.slice(0, 8)) + ').';
      const sent = await channel.send({
        content: message.slice(0, 1900),
        allowedMentions: { parse: [], roles: route.supervisorRoleId ? [route.supervisorRoleId] : [] },
      });
      await pool.query(
        "UPDATE support_sla_alerts SET delivery_status='sent',delivery_attempts=delivery_attempts+1," +
          'delivery_message_id=$2,delivered_at=NOW(),delivery_last_error=NULL ' +
          'WHERE id=$1 AND guild_id=$3',
        [alert.id, sent.id, guildId],
      );
    } catch (error) {
      failures += 1;
      const reason = (error instanceof Error ? error.message : 'Unknown Discord delivery error').slice(0, 1000);
      await pool.query(
        "UPDATE support_sla_alerts SET delivery_status='failed',delivery_attempts=delivery_attempts+1," +
          "delivery_last_error=$2,delivery_next_attempt_at=NOW() + (LEAST(delivery_attempts + 1,60) * INTERVAL '1 minute') " +
          'WHERE id=$1 AND guild_id=$3',
        [alert.id, reason, guildId],
      ).catch((persistError) => {
        console.error('QueryFixr could not persist an SLA delivery failure for alert ' + alert.id + ':', persistError);
      });
      console.warn('QueryFixr SLA delivery failed for alert ' + alert.id + '; retry is scheduled:', reason);
    }
  }
  return failures;
}

async function acquireSlaMonitorLease(guildId: string, owner: string): Promise<string | null | undefined> {
  const result = await getPostgresPool().query<QueryResultRow & { cursor_ticket_id: string | null }>(
    'INSERT INTO support_sla_monitor_state (guild_id,cursor_ticket_id,lease_owner,lease_until,updated_at) ' +
      "VALUES ($1,NULL,$2,NOW()+INTERVAL '4 minutes',NOW()) " +
      'ON CONFLICT (guild_id) DO UPDATE SET lease_owner=EXCLUDED.lease_owner,' +
      'lease_until=EXCLUDED.lease_until,updated_at=NOW() ' +
      'WHERE support_sla_monitor_state.lease_until IS NULL OR support_sla_monitor_state.lease_until<NOW() ' +
      'RETURNING cursor_ticket_id',
    [guildId, owner],
  );
  return result.rows.length ? result.rows[0].cursor_ticket_id : undefined;
}

async function updateSlaMonitorCursor(guildId: string, owner: string, cursor: string | null): Promise<void> {
  const result = await getPostgresPool().query(
    "UPDATE support_sla_monitor_state SET cursor_ticket_id=$3,lease_until=NOW()+INTERVAL '4 minutes',updated_at=NOW() " +
      'WHERE guild_id=$1 AND lease_owner=$2',
    [guildId, owner, cursor],
  );
  if ((result.rowCount ?? 0) !== 1) throw new Error('SLA monitor lease expired or was acquired by another worker.');
}

/** Evaluate a bounded, persisted queue page and retry due delivery intents. */
export async function sweepSupportSlaAlerts(client: Client): Promise<number> {
  let alerts = 0;
  const leaseOwner = randomUUID();
  for (const guild of client.guilds.cache.values()) {
    let leased = false;
    try {
      await runTrackedOperationalTask('ticket-sla-monitor', guild.id, async () => {
        const pool = getPostgresPool();
        let cursor = await acquireSlaMonitorLease(guild.id, leaseOwner);
        if (cursor === undefined) return; // Another live worker owns this guild's monitor lease.
        leased = true;
        let active = await pool.query<QueryResultRow & { id: string }>(
          "SELECT id FROM tickets WHERE guild_id=$1 AND deleted_at IS NULL " +
            "AND status IN ('open','claimed','pending','reopened') AND ($2::text IS NULL OR id > $2) ORDER BY id ASC LIMIT 250",
          [guild.id, cursor],
        );
        if (!active.rows.length && cursor !== null) {
          cursor = null;
          await updateSlaMonitorCursor(guild.id, leaseOwner, null);
          active = await pool.query<QueryResultRow & { id: string }>(
            "SELECT id FROM tickets WHERE guild_id=$1 AND deleted_at IS NULL " +
              "AND status IN ('open','claimed','pending','reopened') ORDER BY id ASC LIMIT 250",
            [guild.id],
          );
        }

        const config = await getGuildConfig(guild.id);
        let failedTicketChecks = 0;
        for (const row of active.rows) {
          try {
            const evaluation = await evaluateTicketSla(guild.id, row.id);
            if (evaluation.policy && evaluation.firstResponse && evaluation.claim && evaluation.resolution) {
              const candidates: Array<{ type: SlaAlertTarget; result: SlaTargetResult }> = [
                { type: 'first_response', result: evaluation.firstResponse },
                { type: 'claim', result: evaluation.claim },
                { type: 'resolution', result: evaluation.resolution },
              ];
              for (const candidate of candidates) {
                const persisted = await persistSlaAlert(guild.id, evaluation, candidate.type, candidate.result);
                if (!persisted) continue;
                if (persisted.created) alerts += 1;
                if (persisted.created && config.supportCategoryId) {
                  // The SLA table is the authoritative event record. Audit-stream delivery
                  // is best-effort here; notification delivery has its own durable receipt.
                  await logTicketEvent(guild, config.supportCategoryId, {
                    ticketNumber: evaluation.ticketNumber ?? evaluation.ticketId.slice(0, 8),
                    ticketChannelId: evaluation.channelId,
                    event: 'SUPPORT_SLA_' + candidate.type.toUpperCase() + '_' + candidate.result.progress.toUpperCase(),
                    actorId: 'supportforge-system',
                    actor: 'QueryFixr SLA monitor',
                    actorName: 'QueryFixr SLA monitor',
                    detail: candidate.type + ' SLA ' + candidate.result.progress + '; elapsed ' +
                      candidate.result.elapsedMinutes + ' of ' + candidate.result.targetMinutes + ' minutes; policy ' +
                      evaluation.policy.id + ' v' + evaluation.policy.version + '.',
                    category: 'ticket',
                  }).catch((error) => console.warn(
                    'QueryFixr SLA record is durable but audit-channel publication failed for ' + persisted.id + ':',
                    error instanceof Error ? error.message : 'unknown error',
                  ));
                }
              }
            }
            cursor = row.id;
            await updateSlaMonitorCursor(guild.id, leaseOwner, cursor);
          } catch (error) {
            failedTicketChecks += 1;
            console.warn(
              'QueryFixr SLA monitor could not evaluate ticket ' + row.id + '; cursor will remain before this ticket:',
              error instanceof Error ? error.message : 'unknown error',
            );
            break;
          }
        }
        if (failedTicketChecks > 0) {
          throw new Error(
            'The SLA sweep could not evaluate ' + failedTicketChecks + ' ticket(s). The durable cursor remains before the failed item so the next pass retries it.',
          );
        }
        if (active.rows.length < 250) await updateSlaMonitorCursor(guild.id, leaseOwner, null);
        const deliveryFailures = await deliverPendingSlaAlerts(guild.id, client);
        if (deliveryFailures > 0) {
          throw new Error(deliveryFailures + ' SLA alert delivery attempt(s) failed. Delivery receipts are retained and retries are scheduled.');
        }
      });
    } catch (error) {
      console.warn(
        'QueryFixr SLA monitor did not complete for guild ' + guild.id + ':',
        error instanceof Error ? error.message : 'unknown error',
      );
    } finally {
      if (leased) {
        await getPostgresPool().query(
          'UPDATE support_sla_monitor_state SET lease_owner=NULL,lease_until=NULL,updated_at=NOW() ' +
            'WHERE guild_id=$1 AND lease_owner=$2',
          [guild.id, leaseOwner],
        ).catch((error) => console.warn('QueryFixr could not release SLA monitor lease for guild ' + guild.id + ':', error));
      }
    }
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
      console.warn('QueryFixr SLA monitor will retry:', error instanceof Error ? error.message : 'unknown error');
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
