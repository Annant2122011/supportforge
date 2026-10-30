import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type Client,
  type TextBasedChannel,
} from 'discord.js';
import type { QueryResultRow } from 'pg';

import {
  calculateCsatSurveyRetryDelayMs,
  CSAT_SURVEY_COMMENT_WINDOW_MS,
  CSAT_SURVEY_MAX_DELIVERY_ATTEMPTS,
  CSAT_SURVEY_PROCESSING_LEASE_MS,
  isCsatSurveyExpired,
  validateCsatSurveyTiming,
  type CsatSurveyStatus,
} from '../core/domain/csatSurvey';
import { normalizeCsatResponse } from '../core/domain/csatPolicy';
import { getAdvancedSettings } from './advancedSettingsService';
import { translate } from '../i18n/translationService';
import { getPostgresPool } from '../core/persistence/postgresDatabase';

const MAX_ENQUEUE_BATCH = 250;
const MAX_DELIVERY_BATCH = 20;
const RECEIPT_PREFIX = 'QueryFixr CSAT survey receipt: ';

export interface CsatSurveySettings {
  guildId: string;
  enabled: boolean;
  enabledAt: string | null;
  delayMinutes: number;
  expiryDays: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface CsatSurveyRow extends QueryResultRow {
  id: string;
  guild_id: string;
  ticket_id: string;
  owner_id: string;
  ticket_channel_id: string;
  ticket_number: string | null;
  closure_event_id: string;
  closed_at: Date | string;
  due_at: Date | string;
  expires_at: Date | string;
  status: CsatSurveyStatus;
  delivery_attempts: number;
  delivery_next_attempt_at: Date | string;
  processing_until: Date | string | null;
  delivery_last_error: string | null;
  delivery_channel_id: string | null;
  delivery_message_id: string | null;
  sent_at: Date | string | null;
  responded_at: Date | string | null;
  response_id: string | null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function settingsFromRow(row: QueryResultRow & {
  guild_id: string;
  enabled: boolean;
  enabled_at: Date | string | null;
  delay_minutes: number;
  expiry_days: number;
  updated_by: string | null;
  updated_at: Date | string | null;
}): CsatSurveySettings {
  return {
    guildId: row.guild_id,
    enabled: Boolean(row.enabled),
    enabledAt: iso(row.enabled_at),
    delayMinutes: Number(row.delay_minutes),
    expiryDays: Number(row.expiry_days),
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  };
}

function defaultSettings(guildId: string): CsatSurveySettings {
  return {
    guildId,
    enabled: false,
    enabledAt: null,
    delayMinutes: 5,
    expiryDays: 7,
    updatedBy: null,
    updatedAt: null,
  };
}

export async function getCsatSurveySettings(guildId: string): Promise<CsatSurveySettings> {
  const result = await getPostgresPool().query<QueryResultRow & {
    guild_id: string; enabled: boolean; enabled_at: Date | string | null;
    delay_minutes: number; expiry_days: number; updated_by: string | null; updated_at: Date | string | null;
  }>(
    'SELECT guild_id,enabled,enabled_at,delay_minutes,expiry_days,updated_by,updated_at ' +
      'FROM support_csat_survey_settings WHERE guild_id=$1',
    [guildId],
  );
  return result.rows[0] ? settingsFromRow(result.rows[0]) : defaultSettings(guildId);
}

/** Opt-in defaults to off. Re-enabling resets the eligibility watermark to now. */
export async function setCsatSurveysEnabled(
  guildId: string,
  enabled: boolean,
  actorId: string,
): Promise<CsatSurveySettings> {
  const pool = getPostgresPool();
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const result = await connection.query<QueryResultRow & {
      guild_id: string; enabled: boolean; enabled_at: Date | string | null;
      delay_minutes: number; expiry_days: number; updated_by: string | null; updated_at: Date | string | null;
    }>(
      'INSERT INTO support_csat_survey_settings (guild_id,enabled,enabled_at,updated_by,updated_at) ' +
        'VALUES ($1,$2,CASE WHEN $2 THEN NOW() ELSE NULL END,$3,NOW()) ' +
        'ON CONFLICT (guild_id) DO UPDATE SET ' +
        'enabled=EXCLUDED.enabled, ' +
        'enabled_at=CASE WHEN EXCLUDED.enabled=FALSE THEN NULL ' +
        'WHEN support_csat_survey_settings.enabled=FALSE THEN NOW() ' +
        'ELSE support_csat_survey_settings.enabled_at END, ' +
        'updated_by=EXCLUDED.updated_by,updated_at=NOW() ' +
        'RETURNING guild_id,enabled,enabled_at,delay_minutes,expiry_days,updated_by,updated_at',
      [guildId, enabled, actorId],
    );
    if (!enabled) {
      await connection.query(
        "UPDATE support_csat_surveys SET status='cancelled',processing_until=NULL,updated_at=NOW() " +
          "WHERE guild_id=$1 AND status IN ('pending','failed')",
        [guildId],
      );
    }
    await connection.query('COMMIT');
    return settingsFromRow(result.rows[0]!);
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export async function configureCsatSurveyTiming(
  guildId: string,
  actorId: string,
  delayMinutes: number,
  expiryDays: number,
): Promise<CsatSurveySettings> {
  validateCsatSurveyTiming(delayMinutes, expiryDays);
  const result = await getPostgresPool().query<QueryResultRow & {
    guild_id: string; enabled: boolean; enabled_at: Date | string | null;
    delay_minutes: number; expiry_days: number; updated_by: string | null; updated_at: Date | string | null;
  }>(
    'INSERT INTO support_csat_survey_settings (guild_id,enabled,enabled_at,delay_minutes,expiry_days,updated_by,updated_at) ' +
      'VALUES ($1,FALSE,NULL,$2,$3,$4,NOW()) ' +
      'ON CONFLICT (guild_id) DO UPDATE SET delay_minutes=EXCLUDED.delay_minutes,expiry_days=EXCLUDED.expiry_days,' +
      'updated_by=EXCLUDED.updated_by,updated_at=NOW() ' +
      'RETURNING guild_id,enabled,enabled_at,delay_minutes,expiry_days,updated_by,updated_at',
    [guildId, delayMinutes, expiryDays, actorId],
  );
  return settingsFromRow(result.rows[0]!);
}

async function enqueueClosedTickets(): Promise<number> {
  const pool = getPostgresPool();
  const result = await pool.query<QueryResultRow & {
    ticket_id: string; guild_id: string; ticket_channel_id: string; ticket_number: string | null;
    owner_id: string; closure_event_id: string; closed_at: Date | string;
    delay_minutes: number; expiry_days: number; existing_response_id: string | null;
    existing_response_at: Date | string | null;
  }>(
    'SELECT t.id AS ticket_id,t.guild_id,t.channel_id AS ticket_channel_id,t.ticket_number,t.owner_id,' +
      'closure.id AS closure_event_id,closure.created_at AS closed_at,s.delay_minutes,s.expiry_days ' +
      'FROM tickets t ' +
      'JOIN support_csat_survey_settings s ON s.guild_id=t.guild_id AND s.enabled=TRUE AND s.enabled_at IS NOT NULL ' +
      'JOIN LATERAL (' +
        "SELECT e.id,e.created_at FROM ticket_events e WHERE e.ticket_id=t.id AND e.guild_id=t.guild_id " +
          "AND e.event_type='ticket.status_changed' AND e.payload->>'to'='closed' AND e.created_at>=s.enabled_at " +
          'ORDER BY e.created_at DESC LIMIT 1' +
      ') closure ON TRUE ' +
      'LEFT JOIN LATERAL (' +
        'SELECT r.id,r.created_at FROM support_csat_responses r ' +
        'WHERE r.guild_id=t.guild_id AND r.ticket_id=t.id AND r.user_id=t.owner_id ' +
        'ORDER BY r.created_at ASC LIMIT 1' +
      ') existing_response ON TRUE ' +
      "WHERE t.status IN ('closed','archived') AND t.deleted_at IS NULL AND t.owner_id IS NOT NULL " +
      'AND NOT EXISTS (SELECT 1 FROM support_csat_surveys sv WHERE sv.guild_id=t.guild_id AND sv.ticket_id=t.id) ' +
      'ORDER BY closure.created_at ASC LIMIT $1',
    [MAX_ENQUEUE_BATCH],
  );
  let created = 0;
  for (const row of result.rows) {
    const settingsDelay = Number(row.delay_minutes);
    const settingsExpiry = Number(row.expiry_days);
    try {
      validateCsatSurveyTiming(settingsDelay, settingsExpiry);
      const closedAt = new Date(row.closed_at instanceof Date ? row.closed_at.getTime() : Date.parse(row.closed_at));
      if (!Number.isFinite(closedAt.getTime())) continue;
      const dueAt = new Date(closedAt.getTime() + settingsDelay * 60_000);
      const expiresAt = new Date(closedAt.getTime() + settingsExpiry * 24 * 60 * 60_000);
      if (dueAt.getTime() >= expiresAt.getTime()) continue;
      const inserted = await pool.query(
        'INSERT INTO support_csat_surveys ' +
          '(id,guild_id,ticket_id,owner_id,ticket_channel_id,closure_event_id,closed_at,due_at,expires_at,status,delivery_next_attempt_at,response_id,responded_at) ' +
          "VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::timestamptz,CASE WHEN $10::text IS NULL THEN 'pending' ELSE 'responded' END,NOW(),$10,$11::timestamptz) " +
          'ON CONFLICT (guild_id,ticket_id) DO NOTHING RETURNING id',
        [randomUUID(), row.guild_id, row.ticket_id, row.owner_id, row.ticket_channel_id, row.closure_event_id,
          closedAt.toISOString(), dueAt.toISOString(), expiresAt.toISOString(), row.existing_response_id,
          iso(row.existing_response_at)],
      );
      if (inserted.rowCount) created += 1;
    } catch (error) {
      console.warn('QueryFixr CSAT survey could not be enqueued for ticket ' + row.ticket_id + ':',
        error instanceof Error ? error.message : 'unknown enqueue error');
    }
  }
  return created;
}

async function reconcileExistingResponses(): Promise<number> {
  const result = await getPostgresPool().query(
    "UPDATE support_csat_surveys s SET status='responded',response_id=r.id,responded_at=r.created_at," +
      'processing_until=NULL,updated_at=NOW() FROM support_csat_responses r ' +
      "WHERE r.guild_id=s.guild_id AND r.ticket_id=s.ticket_id AND r.user_id=s.owner_id " +
      "AND s.status IN ('pending','sending','sent','failed')",
  );
  return result.rowCount ?? 0;
}

async function expireAndRecoverSurveys(): Promise<{ expired: number; recovered: number }> {
  const pool = getPostgresPool();
  const expired = await pool.query(
    "UPDATE support_csat_surveys SET status='expired',processing_until=NULL,updated_at=NOW() " +
      "WHERE expires_at<=NOW() AND status IN ('pending','sending','sent','failed')",
  );
  const recovered = await pool.query(
    "UPDATE support_csat_surveys SET status='pending',processing_until=NULL,delivery_next_attempt_at=LEAST(delivery_next_attempt_at,NOW()),updated_at=NOW() " +
      "WHERE status='sending' AND processing_until<=NOW() AND expires_at>NOW()",
  );
  return { expired: expired.rowCount ?? 0, recovered: recovered.rowCount ?? 0 };
}

async function claimDueSurveys(): Promise<CsatSurveyRow[]> {
  const pool = getPostgresPool();
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const selected = await connection.query<QueryResultRow & { id: string }>(
      "SELECT id FROM support_csat_surveys WHERE status IN ('pending','failed') " +
        'AND due_at<=NOW() AND delivery_next_attempt_at<=NOW() AND expires_at>NOW() ' +
        'AND delivery_attempts<$1 ORDER BY due_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED',
      [CSAT_SURVEY_MAX_DELIVERY_ATTEMPTS, MAX_DELIVERY_BATCH],
    );
    const ids = selected.rows.map((row) => row.id);
    if (!ids.length) {
      await connection.query('COMMIT');
      return [];
    }
    const updated = await connection.query<CsatSurveyRow>(
      'UPDATE support_csat_surveys SET status=\'sending\',delivery_attempts=delivery_attempts+1,' +
        'processing_until=NOW()+($2 * INTERVAL \'1 millisecond\'),updated_at=NOW() ' +
        'WHERE id=ANY($1::text[]) RETURNING id,guild_id,ticket_id,owner_id,ticket_channel_id,closure_event_id,' +
        'closed_at,due_at,expires_at,status,delivery_attempts,delivery_next_attempt_at,processing_until,' +
        'delivery_last_error,delivery_channel_id,delivery_message_id,sent_at,responded_at,response_id',
      [ids, CSAT_SURVEY_PROCESSING_LEASE_MS],
    );
    await connection.query('COMMIT');
    return updated.rows;
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export function buildCsatSurveyComponents(surveyId: string, locale: unknown = 'en-US', disabled = false): ActionRowBuilder<ButtonBuilder>[] {
  const ratings = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...[1, 2, 3, 4, 5].map((rating) => new ButtonBuilder()
      .setCustomId('qf:csat:rate:' + surveyId + ':' + rating)
      .setLabel(String(rating))
      .setStyle(rating <= 2 ? ButtonStyle.Danger : rating === 3 ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(disabled)),
  );
  const comment = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('qf:csat:comment:' + surveyId)
      .setLabel(translate(locale, 'csat.survey.comment.button'))
      .setEmoji('💬')
      .setStyle(ButtonStyle.Primary),
  );
  return [ratings, comment];
}

function receiptMarker(surveyId: string): string {
  return RECEIPT_PREFIX + surveyId;
}

async function getSurveyDm(userId: string, client: Client): Promise<TextBasedChannel> {
  const user = client.users.cache.get(userId) ?? await client.users.fetch(userId);
  return user.createDM();
}

async function findSurveyReceipt(
  dm: TextBasedChannel,
  client: Client,
  surveyId: string,
) {
  if (!('messages' in dm)) return null;
  const messages = await dm.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return null;
  return messages.find((message) =>
    message.author.id === client.user?.id &&
    message.embeds.some((embed) => embed.footer?.text === receiptMarker(surveyId)),
  ) ?? null;
}

async function markSurveySent(
  survey: CsatSurveyRow,
  dmChannelId: string,
  messageId: string,
): Promise<void> {
  await getPostgresPool().query(
    "UPDATE support_csat_surveys SET status='sent',delivery_channel_id=$2,delivery_message_id=$3," +
      'sent_at=COALESCE(sent_at,NOW()),processing_until=NULL,delivery_last_error=NULL,updated_at=NOW() ' +
      "WHERE id=$1 AND status IN ('sending','sent')",
    [survey.id, dmChannelId, messageId],
  );
}

async function cancelSurvey(surveyId: string, reason: string): Promise<void> {
  await getPostgresPool().query(
    "UPDATE support_csat_surveys SET status='cancelled',processing_until=NULL,delivery_last_error=$2,updated_at=NOW() " +
      "WHERE id=$1 AND status IN ('pending','sending','failed')",
    [surveyId, reason.slice(0, 1000)],
  );
}

async function deliverSurvey(survey: CsatSurveyRow, client: Client): Promise<void> {
  const pool = getPostgresPool();
  const ticket = await pool.query<QueryResultRow & {
    status: string; deleted_at: Date | string | null; owner_id: string | null; ticket_number: string | null;
  }>(
    'SELECT t.status,t.deleted_at,t.owner_id,t.ticket_number, ' +
      '(SELECT e.id FROM ticket_events e WHERE e.ticket_id=t.id AND e.guild_id=t.guild_id ' +
      "AND e.event_type='ticket.status_changed' AND e.payload->>'to'='closed' ORDER BY e.created_at DESC,e.id DESC LIMIT 1) AS latest_closure_event_id " +
      'FROM tickets t WHERE t.id=$1 AND t.guild_id=$2',
    [survey.ticket_id, survey.guild_id],
  );
  const ticketRow = ticket.rows[0];
  if (!ticketRow || ticketRow.deleted_at || !ticketRow.owner_id || ticketRow.owner_id !== survey.owner_id ||
      !['closed', 'archived'].includes(ticketRow.status) || ticketRow.latest_closure_event_id !== survey.closure_event_id) {
    await cancelSurvey(survey.id, 'Ticket is no longer eligible for a customer satisfaction survey or its close cycle changed.');
    return;
  }

  const response = await pool.query(
    'SELECT 1 FROM support_csat_responses WHERE guild_id=$1 AND ticket_id=$2 AND user_id=$3 LIMIT 1',
    [survey.guild_id, survey.ticket_id, survey.owner_id],
  );
  if (response.rowCount) {
    await reconcileExistingResponses();
    return;
  }

  const currentSettings = await getCsatSurveySettings(survey.guild_id);
  if (!currentSettings.enabled) {
    await cancelSurvey(survey.id, 'Automatic surveys are disabled for this server.');
    return;
  }

  try {
    const dm = await getSurveyDm(survey.owner_id, client);
    const existing = await findSurveyReceipt(dm, client, survey.id);
    if (existing) {
      await markSurveySent(survey, dm.id, existing.id);
      return;
    }
    const user = client.users.cache.get(survey.owner_id) ?? await client.users.fetch(survey.owner_id);
    const locale = (await getAdvancedSettings(survey.guild_id)).locale;
    const ticketLabel = ticketRow.ticket_number ? '#' + ticketRow.ticket_number : survey.ticket_id.slice(0, 8);
    const message = await user.send({
      content: '📬 **' + translate(locale, 'csat.survey.dm.heading') + '**',
      embeds: [new EmbedBuilder()
        .setColor(0x4F46E5)
        .setTitle(translate(locale, 'csat.survey.dm.title'))
        .setDescription(translate(locale, 'csat.survey.dm.content', { ticket: ticketLabel }))
        .setFooter({ text: receiptMarker(survey.id) })],
      components: buildCsatSurveyComponents(survey.id, locale),
      allowedMentions: { parse: [] },
    });
    await markSurveySent(survey, dm.id, message.id);
  } catch (error) {
    // Reconcile the ambiguous send case before scheduling another attempt.
    try {
      const dm = await getSurveyDm(survey.owner_id, client);
      const existing = await findSurveyReceipt(dm, client, survey.id);
      if (existing) {
        await markSurveySent(survey, dm.id, existing.id);
        return;
      }
    } catch {
      // The original failure remains authoritative when DM history cannot be read.
    }
    const reason = (error instanceof Error ? error.message : 'Unknown Discord delivery error').slice(0, 1000);
    const delay = calculateCsatSurveyRetryDelayMs(Math.max(1, survey.delivery_attempts));
    await pool.query(
      "UPDATE support_csat_surveys SET status='failed',processing_until=NULL,delivery_last_error=$2," +
        'delivery_next_attempt_at=NOW()+($3 * INTERVAL \'1 millisecond\'),updated_at=NOW() WHERE id=$1 AND status=\'sending\'',
      [survey.id, reason, delay],
    );
    console.warn('QueryFixr CSAT delivery failed for survey ' + survey.id +
      ' (attempt ' + survey.delivery_attempts + '/' + CSAT_SURVEY_MAX_DELIVERY_ATTEMPTS + '): ' + reason);
  }
}

export interface CsatSurveySweepResult {
  enqueued: number;
  claimed: number;
  sent: number;
  failed: number;
  expired: number;
  recovered: number;
  reconciled: number;
}

export async function sweepCsatSurveyQueue(client: Client): Promise<CsatSurveySweepResult> {
  const enqueued = await enqueueClosedTickets();
  const reconciled = await reconcileExistingResponses();
  const lifecycle = await expireAndRecoverSurveys();
  const claimed = await claimDueSurveys();
  let sent = 0;
  let failed = 0;
  for (const survey of claimed) {
    try {
      await deliverSurvey(survey, client);
      const state = await getPostgresPool().query<QueryResultRow & { status: string }>(
        'SELECT status FROM support_csat_surveys WHERE id=$1',
        [survey.id],
      );
      if (state.rows[0]?.status === 'sent') sent += 1;
      if (state.rows[0]?.status === 'failed') failed += 1;
    } catch (error) {
      failed += 1;
      const reason = (error instanceof Error ? error.message : 'Unknown survey worker error').slice(0, 1000);
      await getPostgresPool().query(
        "UPDATE support_csat_surveys SET status='failed',processing_until=NULL,delivery_last_error=$2," +
          'delivery_next_attempt_at=NOW()+INTERVAL \'1 minute\',updated_at=NOW() WHERE id=$1 AND status=\'sending\'',
        [survey.id, reason],
      ).catch((persistError) => console.error('QueryFixr could not persist CSAT worker failure for survey ' + survey.id, persistError));
    }
  }
  return {
    enqueued,
    claimed: claimed.length,
    sent,
    failed,
    expired: lifecycle.expired,
    recovered: lifecycle.recovered,
    reconciled,
  };
}

let csatMonitor: ReturnType<typeof setInterval> | null = null;

export function startCsatSurveyMonitor(client: Client, intervalMs = 60_000): void {
  if (csatMonitor) return;
  const run = async () => {
    try {
      await sweepCsatSurveyQueue(client);
    } catch (error) {
      console.error('QueryFixr CSAT survey monitor failed:', error);
    }
  };
  void run();
  csatMonitor = setInterval(() => { void run(); }, Math.max(15_000, intervalMs));
  csatMonitor.unref?.();
}

export async function getCsatSurveyLocale(surveyId: string): Promise<string> {
  const result = await getPostgresPool().query<QueryResultRow & { guild_id: string }>(
    'SELECT guild_id FROM support_csat_surveys WHERE id=$1',
    [surveyId],
  );
  if (!result.rows[0]) throw new Error('This feedback survey was not found or is no longer available.');
  return (await getAdvancedSettings(result.rows[0].guild_id)).locale;
}

export interface CsatSurveySubmission {
  id: string;
  guildId: string;
  surveyId: string;
  ticketId: string;
  rating: number;
  alreadySubmitted: boolean;
}

export async function submitCsatSurveyRating(
  surveyId: string,
  userId: string,
  rating: number,
): Promise<CsatSurveySubmission> {
  const normalized = normalizeCsatResponse(rating, '');
  const connection = await getPostgresPool().connect();
  try {
    await connection.query('BEGIN');
    const selected = await connection.query<QueryResultRow & {
      id: string; guild_id: string; ticket_id: string; owner_id: string;
      status: CsatSurveyStatus; expires_at: Date | string;
      ticket_status: string; deleted_at: Date | string | null; ticket_owner_id: string | null;
    }>(
      'SELECT s.id,s.guild_id,s.ticket_id,s.owner_id,s.status,s.expires_at,' +
        't.status AS ticket_status,t.deleted_at,t.owner_id AS ticket_owner_id ' +
        'FROM support_csat_surveys s JOIN tickets t ON t.id=s.ticket_id AND t.guild_id=s.guild_id ' +
        'WHERE s.id=$1 FOR UPDATE OF s,t',
      [surveyId],
    );
    const row = selected.rows[0];
    if (!row) throw new Error('This feedback survey was not found or is no longer available.');
    if (row.owner_id !== userId || row.ticket_owner_id !== userId) {
      throw new Error('Only the ticket creator can submit this feedback.');
    }
    if (row.deleted_at || !['closed', 'archived'].includes(row.ticket_status)) {
      await connection.query(
        "UPDATE support_csat_surveys SET status='cancelled',processing_until=NULL,updated_at=NOW() WHERE id=$1 AND status<>'responded'",
        [surveyId],
      );
      await connection.query('COMMIT');
      throw new Error('This ticket is no longer closed. The feedback survey has been cancelled.');
    }
    if (isCsatSurveyExpired(row.expires_at)) {
      await connection.query(
        "UPDATE support_csat_surveys SET status='expired',processing_until=NULL,updated_at=NOW() WHERE id=$1 AND status<>'responded'",
        [surveyId],
      );
      await connection.query('COMMIT');
      throw new Error('This feedback survey has expired.');
    }
    const existing = await connection.query<QueryResultRow & { id: string; rating: number }>(
      'SELECT id,rating FROM support_csat_responses WHERE guild_id=$1 AND ticket_id=$2 AND user_id=$3 LIMIT 1',
      [row.guild_id, row.ticket_id, userId],
    );
    if (existing.rows[0]) {
      await connection.query(
        "UPDATE support_csat_surveys SET status='responded',response_id=$2,responded_at=NOW(),processing_until=NULL,updated_at=NOW() WHERE id=$1",
        [surveyId, existing.rows[0].id],
      );
      await connection.query('COMMIT');
      return {
        id: existing.rows[0].id,
        guildId: row.guild_id,
        surveyId,
        ticketId: row.ticket_id,
        rating: Number(existing.rows[0].rating),
        alreadySubmitted: true,
      };
    }
    if (row.status !== 'sent') {
      throw new Error('This survey is not currently accepting a response.');
    }
    const responseId = randomUUID();
    await connection.query(
      'INSERT INTO support_csat_responses (id,guild_id,ticket_id,user_id,rating,comment) VALUES ($1,$2,$3,$4,$5,\'\')',
      [responseId, row.guild_id, row.ticket_id, userId, normalized.rating],
    );
    await connection.query(
      "UPDATE support_csat_surveys SET status='responded',response_id=$2,responded_at=NOW(),processing_until=NULL,updated_at=NOW() WHERE id=$1",
      [surveyId, responseId],
    );
    await connection.query('COMMIT');
    return { id: responseId, guildId: row.guild_id, surveyId, ticketId: row.ticket_id, rating: normalized.rating, alreadySubmitted: false };
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export async function canAddCsatSurveyComment(surveyId: string, userId: string): Promise<boolean> {
  const result = await getPostgresPool().query<QueryResultRow & { allowed: boolean }>(
    'SELECT EXISTS (' +
      'SELECT 1 FROM support_csat_surveys s JOIN support_csat_responses r ' +
        'ON r.guild_id=s.guild_id AND r.ticket_id=s.ticket_id AND r.user_id=s.owner_id ' +
      "WHERE s.id=$1 AND s.owner_id=$2 AND s.status='responded' AND s.responded_at>=NOW()-($3 * INTERVAL '1 millisecond') " +
        "AND r.comment='' AND r.created_at>=NOW()-($3 * INTERVAL '1 millisecond')) AS allowed",
    [surveyId, userId, CSAT_SURVEY_COMMENT_WINDOW_MS],
  );
  return Boolean(result.rows[0]?.allowed);
}

export async function submitCsatSurveyComment(
  surveyId: string,
  userId: string,
  comment: string,
): Promise<void> {
  const normalized = normalizeCsatResponse(5, comment);
  if (!normalized.comment) throw new Error('Enter a comment or cancel the optional comment form.');
  const result = await getPostgresPool().query<QueryResultRow & { ticket_id: string }>(
    'UPDATE support_csat_responses r SET comment=$3,updated_at=NOW() ' +
      'FROM support_csat_surveys s ' +
      "WHERE s.id=$1 AND s.owner_id=$2 AND s.status='responded' AND s.responded_at>=NOW()-($4 * INTERVAL '1 millisecond') " +
      "AND r.guild_id=s.guild_id AND r.ticket_id=s.ticket_id AND r.user_id=$2 AND r.comment='' " +
      'AND r.created_at>=NOW()-($4 * INTERVAL \'1 millisecond\') RETURNING r.ticket_id',
    [surveyId, userId, normalized.comment, CSAT_SURVEY_COMMENT_WINDOW_MS],
  );
  if (!result.rowCount) {
    throw new Error('The optional comment window has expired or a comment was already saved.');
  }
}
