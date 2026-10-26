import {
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  OverwriteType,
  type APIEmbed,
  type Guild,
  type Message,
  type MessageCreateOptions,
  type PermissionResolvable,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { extractRecoverySegmentMarkers, recoverySegmentMarker } from '../core/domain/recoveryReplayMarkers';
import { withPostgresAdvisoryLock } from '../core/persistence/operationLock';
import { getGuildConfig } from './configService';
import { getThemeColor } from './uiThemeService';
import {
  getPersistedTicket,
  getPersistedTicketById,
  markPersistedTicketDeleted,
} from './ticketPersistenceService';
import { getField, isTicketTopic, removeField, setField } from './ticketStateService';
import { refreshTicketPanel } from './ticketPanelService';
import { runTrackedOperationalTask } from './operationalTaskTelemetry';
import { buildRecoveryPreviewSummary, type RecoveryPreviewSummary, type RecoverySource } from '../core/domain/recoveryPreview';

const ARCHIVE_PAGE_SIZE = 100;
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const RECOVERY_FOOTER_PREFIX = 'QueryFixr Recovery Archive';

interface ChannelArchiveRow extends QueryResultRow {
  ticket_id: string;
  guild_id: string;
  original_channel_id: string;
  channel_name: string;
  topic: string;
  parent_id: string | null;
  parent_name: string | null;
  permission_overwrites: unknown;
  position: number;
  nsfw: boolean;
  rate_limit_per_user: number;
  backfill_cursor: string | null;
  backfill_complete: boolean;
}

interface MessageArchiveRow extends QueryResultRow {
  message_id: string;
  ticket_id: string;
  guild_id: string;
  original_channel_id: string;
  author_id: string;
  author_username: string;
  author_display_name: string;
  author_avatar_url: string | null;
  content: string;
  created_at: Date | string;
  edited_at: Date | string | null;
  is_bot: boolean;
  embeds: unknown;
  components: unknown;
  attachments: unknown;
  metadata: unknown;
}

interface AttachmentArchiveRow extends QueryResultRow {
  attachment_id: string;
  original_filename: string;
  content_type: string | null;
  size_bytes: string | number;
  source_url: string;
  archived_bytes: Buffer | null;
  archive_status: string;
  archive_error: string | null;
}

export interface TicketRecoveryCandidate {
  ticketId: string;
  guildId: string;
  originalChannelId: string;
  ticketNumber: string;
  ownerId: string;
  source: 'discord_native' | 'ticket_button';
  status: string;
  intent: string;
  accidentalAnswer: 'yes' | 'no' | null;
  messageCount: number;
  createdAt: string;
  answeredBy: string | null;
}

function maxAttachmentBytes(): number {
  const parsed = Number(process.env.TICKET_ARCHIVE_MAX_ATTACHMENT_BYTES);
  if (!Number.isFinite(parsed) || parsed < 1024) return DEFAULT_MAX_ATTACHMENT_BYTES;
  return Math.min(Math.floor(parsed), 100 * 1024 * 1024);
}

function isRecoveryReplay(message: Message): boolean {
  // The original-author header uses a footer marker; replayed body and
  // attachment posts use the same bracketed attribution prefix. Never ingest
  // replayed copies as if they were fresh original messages.
  return message.content.startsWith('[Recovered original message by ') ||
    message.embeds.some((embed) =>
      Boolean(embed.footer?.text?.startsWith(RECOVERY_FOOTER_PREFIX)),
    );
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function safeFilename(value: string): string {
  const cleaned = value.replace(/[\\/\r\n\0]/g, '_').replace(/[^\w .()-]/g, '_').trim();
  return (cleaned || 'recovered-attachment').slice(0, 120);
}

function chunkText(value: string, maxLength: number): string[] {
  if (!value) return [];
  const chunks: string[] = [];
  let current = '';
  for (const character of value) {
    if (current.length + character.length > maxLength && current) {
      chunks.push(current);
      current = '';
    }
    current += character;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Attachment exceeded the configured archival size limit.');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

/** Save a durable snapshot of channel settings before the channel is lost. */
export async function archiveTicketChannelSnapshot(channel: TextChannel | ThreadChannel): Promise<void> {
  const ticket = await getPersistedTicket(channel.id);
  if (!ticket || !ticket.guildId) return;
  const isPrivateThread = channel.type === ChannelType.PrivateThread && ticket.metadata.workspaceKind === 'private-thread';
  const savedThreadTopic = typeof ticket.metadata.ticketTopic === 'string' ? ticket.metadata.ticketTopic : '';
  const topic = channel.type === ChannelType.GuildText ? channel.topic ?? '' : isPrivateThread ? savedThreadTopic : '';
  if (!isTicketTopic(topic)) return;

  const originalChannelId =
    typeof ticket.metadata.originalChannelId === 'string'
      ? ticket.metadata.originalChannelId
      : channel.id;
  const permissionOverwrites = channel.type === ChannelType.GuildText
    ? Array.from(channel.permissionOverwrites.cache.values()).map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
      }))
    : [];

  await getPostgresPool().query(
    'INSERT INTO ticket_channel_archive ' +
      '(ticket_id, guild_id, original_channel_id, channel_name, topic, parent_id, parent_name, permission_overwrites, channel_type, position, nsfw, rate_limit_per_user, updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,NOW()) ' +
      'ON CONFLICT (ticket_id) DO UPDATE SET guild_id=EXCLUDED.guild_id, channel_name=EXCLUDED.channel_name, topic=EXCLUDED.topic, ' +
      'parent_id=EXCLUDED.parent_id, parent_name=EXCLUDED.parent_name, permission_overwrites=EXCLUDED.permission_overwrites, ' +
      'channel_type=EXCLUDED.channel_type, position=EXCLUDED.position, nsfw=EXCLUDED.nsfw, ' +
      'rate_limit_per_user=EXCLUDED.rate_limit_per_user, updated_at=NOW()',
    [
      ticket.id,
      ticket.guildId,
      originalChannelId,
      channel.name,
      topic,
      channel.parentId,
      channel.parent?.name ?? null,
      JSON.stringify(permissionOverwrites),
      channel.type,
      channel.type === ChannelType.GuildText ? channel.position : 0,
      channel.type === ChannelType.GuildText ? channel.nsfw : false,
      channel.type === ChannelType.GuildText ? channel.rateLimitPerUser : 0,
    ],
  );
}

async function archiveAttachment(
  messageId: string,
  guildId: string,
  attachment: {
    id: string;
    name: string;
    url: string;
    contentType: string | null;
    size: number;
  },
): Promise<void> {
  const pool = getPostgresPool();
  const existing = await pool.query<AttachmentArchiveRow>(
    'SELECT archive_status, archived_bytes FROM ticket_message_archive_attachments WHERE attachment_id=$1 LIMIT 1',
    [attachment.id],
  );
  if (existing.rows[0]?.archive_status === 'archived' && existing.rows[0].archived_bytes) return;
  if (existing.rows[0]?.archive_status === 'too_large' || existing.rows[0]?.archive_status === 'metadata_only') return;

  const maxBytes = maxAttachmentBytes();
  if (attachment.size > maxBytes) {
    await pool.query(
      'INSERT INTO ticket_message_archive_attachments (attachment_id,message_id,guild_id,original_filename,content_type,size_bytes,source_url,archive_status,archive_error,updated_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT (attachment_id) DO UPDATE SET ' +
        'message_id=EXCLUDED.message_id, source_url=EXCLUDED.source_url, archive_status=EXCLUDED.archive_status, archive_error=EXCLUDED.archive_error, updated_at=NOW()',
      [attachment.id, messageId, guildId, attachment.name, attachment.contentType, attachment.size, attachment.url, 'too_large', 'Attachment exceeds TICKET_ARCHIVE_MAX_ATTACHMENT_BYTES (' + maxBytes + ' bytes).'],
    );
    return;
  }

  let source: URL;
  try {
    source = new URL(attachment.url);
  } catch {
    throw new Error('Attachment URL is invalid.');
  }
  if (source.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(source.hostname)) {
    throw new Error('Attachment URL is not from a trusted Discord CDN host.');
  }

  await pool.query(
    'INSERT INTO ticket_message_archive_attachments (attachment_id,message_id,guild_id,original_filename,content_type,size_bytes,source_url,archive_status,updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT (attachment_id) DO UPDATE SET ' +
      'message_id=EXCLUDED.message_id, guild_id=EXCLUDED.guild_id, original_filename=EXCLUDED.original_filename, ' +
      'content_type=EXCLUDED.content_type, size_bytes=EXCLUDED.size_bytes, source_url=EXCLUDED.source_url, updated_at=NOW()',
    [attachment.id, messageId, guildId, attachment.name, attachment.contentType, attachment.size, attachment.url, 'pending'],
  );

  try {
    const response = await fetch(attachment.url, {
      headers: { 'User-Agent': 'QueryFixr-Ticket-Archive/1.0' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Discord CDN returned HTTP ' + response.status + '.');
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (!['cdn.discordapp.com', 'media.discordapp.net'].includes(finalUrl.hostname)) {
        throw new Error('Attachment was redirected away from the trusted Discord CDN.');
      }
    }
    const declaredSize = Number(response.headers.get('content-length') ?? 0);
    if (declaredSize > maxBytes) throw new Error('Attachment response exceeded the configured archival size limit.');
    const bytes = await readBodyWithLimit(response, maxBytes);
    await pool.query(
      'UPDATE ticket_message_archive_attachments SET archived_bytes=$2, archive_status=$3, archive_error=NULL, updated_at=NOW() WHERE attachment_id=$1',
      [attachment.id, bytes, 'archived'],
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 400) : 'Unknown attachment archive error.';
    await pool.query(
      'UPDATE ticket_message_archive_attachments SET archive_status=$2, archive_error=$3, updated_at=NOW() WHERE attachment_id=$1',
      [attachment.id, 'failed', detail],
    );
    console.warn('QueryFixr could not archive attachment ' + attachment.id + ': ' + detail);
  }
}

/** Archive message payload before it can disappear with its Discord channel. */
export async function archiveTicketMessage(message: Message): Promise<void> {
  if (!message.guild || isRecoveryReplay(message)) return;
  const channel = message.channel;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PrivateThread) return;
  const ticket = await getPersistedTicket(channel.id);
  if (!ticket || !ticket.guildId || ticket.deletedAt || ticket.guildId !== message.guild.id) return;
  const isPrivateThread = channel.type === ChannelType.PrivateThread && ticket.metadata.workspaceKind === 'private-thread';
  const topic = channel.type === ChannelType.GuildText
    ? channel.topic ?? ''
    : isPrivateThread && typeof ticket.metadata.ticketTopic === 'string'
      ? ticket.metadata.ticketTopic
      : '';
  if (!isTicketTopic(topic)) return;
  const pool = getPostgresPool();
  const snapshot = await pool.query('SELECT ticket_id FROM ticket_channel_archive WHERE ticket_id=$1 LIMIT 1', [ticket.id]);
  if (!snapshot.rows.length) await archiveTicketChannelSnapshot(channel);

  const attachments = Array.from(message.attachments.values()).map((attachment) => ({
    id: attachment.id,
    filename: attachment.name ?? 'attachment',
    url: attachment.url,
    contentType: attachment.contentType,
    size: attachment.size,
    description: attachment.description ?? null,
    height: attachment.height ?? null,
    width: attachment.width ?? null,
    spoiler: attachment.spoiler,
  }));
  const embeds = message.embeds.map((embed) => embed.toJSON());
  const components = message.components.map((component) => component.toJSON());
  const displayName = message.member?.displayName ?? message.author.globalName ?? message.author.username;
  const metadata = {
    pinned: message.pinned,
    webhookId: message.webhookId,
    mentionEveryone: message.mentions.everyone,
    userMentions: Array.from(message.mentions.users.keys()),
    roleMentions: Array.from(message.mentions.roles.keys()),
    channelMentions: Array.from(message.mentions.channels.keys()),
  };

  await pool.query(
    'INSERT INTO ticket_message_archive ' +
      '(message_id,ticket_id,guild_id,original_channel_id,author_id,author_username,author_display_name,author_avatar_url,content,created_at,edited_at,is_bot,message_type,embeds,components,attachments,edit_history,metadata,updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,\'[]\'::jsonb,$17::jsonb,NOW()) ' +
      'ON CONFLICT (message_id) DO UPDATE SET content=EXCLUDED.content, edited_at=COALESCE(EXCLUDED.edited_at,ticket_message_archive.edited_at), ' +
      'embeds=EXCLUDED.embeds, components=EXCLUDED.components, attachments=EXCLUDED.attachments, metadata=EXCLUDED.metadata, updated_at=NOW(), ' +
      'edit_history=CASE WHEN ticket_message_archive.content IS DISTINCT FROM EXCLUDED.content OR ticket_message_archive.embeds IS DISTINCT FROM EXCLUDED.embeds ' +
      'THEN ticket_message_archive.edit_history || jsonb_build_array(jsonb_build_object(\'recordedAt\',NOW(),\'previousContent\',ticket_message_archive.content,\'newContent\',EXCLUDED.content,\'previousEmbeds\',ticket_message_archive.embeds,\'newEmbeds\',EXCLUDED.embeds)) ' +
      'ELSE ticket_message_archive.edit_history END',
    [
      message.id,
      ticket.id,
      ticket.guildId,
      channel.id,
      message.author.id,
      message.author.username,
      displayName,
      message.author.displayAvatarURL({ extension: 'png', size: 128 }),
      message.content ?? '',
      message.createdAt,
      message.editedAt,
      message.author.bot,
      message.type,
      JSON.stringify(embeds),
      JSON.stringify(components),
      JSON.stringify(attachments),
      JSON.stringify(metadata),
    ],
  );

  for (const attachment of message.attachments.values()) {
    await archiveAttachment(message.id, ticket.guildId, {
      id: attachment.id,
      name: attachment.name ?? 'attachment',
      url: attachment.url,
      contentType: attachment.contentType,
      size: attachment.size,
    });
  }
}

export async function markArchivedTicketMessageDeleted(
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await getPostgresPool().query(
    'UPDATE ticket_message_archive SET deleted_at=COALESCE(deleted_at,NOW()), updated_at=NOW() ' +
      'WHERE message_id=$1 AND guild_id=$2 AND original_channel_id=$3',
    [messageId, guildId, channelId],
  );
}

/** Capture one page of old history per call; the worker advances durably. */
export async function backfillTicketArchiveBatch(client: { guilds: { cache: Map<string, Guild> } }): Promise<boolean> {
  const pool = getPostgresPool();
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildText || !isTicketTopic(channel.topic ?? '')) continue;
      const ticket = await getPersistedTicket(channel.id).catch(() => undefined);
      if (!ticket || ticket.deletedAt) continue;
      await archiveTicketChannelSnapshot(channel);
      const state = await pool.query<ChannelArchiveRow>(
        'SELECT * FROM ticket_channel_archive WHERE ticket_id=$1 LIMIT 1',
        [ticket.id],
      );
      const archive = state.rows[0];
      if (archive?.backfill_complete) continue;

      const queryOptions: { limit: number; before?: string } = { limit: ARCHIVE_PAGE_SIZE };
      if (archive?.backfill_cursor) queryOptions.before = archive.backfill_cursor;
      const page = await channel.messages.fetch(queryOptions);
      if (!page.size) {
        await pool.query('UPDATE ticket_channel_archive SET backfill_complete=TRUE, updated_at=NOW() WHERE ticket_id=$1', [ticket.id]);
        continue;
      }

      const ordered = Array.from(page.values()).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
      for (const message of ordered) await archiveTicketMessage(message);
      const oldestId = ordered[0]?.id;
      await pool.query(
        'UPDATE ticket_channel_archive SET backfill_cursor=$2, backfill_complete=$3, updated_at=NOW() WHERE ticket_id=$1',
        [ticket.id, oldestId ?? archive?.backfill_cursor ?? null, page.size < ARCHIVE_PAGE_SIZE],
      );
      return true;
    }
  }
  return false;
}

export async function startTicketArchiveBackfill(client: { guilds: { cache: Map<string, Guild> } }): Promise<void> {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runTrackedOperationalTask('ticket-archive-backfill', null, () => backfillTicketArchiveBatch(client));
    } catch (error) {
      console.warn('QueryFixr ticket archive backfill will retry:', error instanceof Error ? error.message : 'unknown error');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 15_000);
  timer.unref();
}

/** Fully archive all remaining messages before a ticket-button deletion is allowed. */
export async function archiveTicketChannelForRecovery(channel: TextChannel): Promise<void> {
  if (!isTicketTopic(channel.topic ?? '')) throw new Error('This channel is not a managed ticket.');
  await archiveTicketChannelSnapshot(channel);
  const pool = getPostgresPool();
  const ticket = await getPersistedTicket(channel.id);
  if (!ticket || !ticket.guildId || ticket.deletedAt) {
    throw new Error('The durable ticket record is missing or already marked deleted; the channel was not deleted.');
  }

  while (true) {
    const state = await pool.query<ChannelArchiveRow>(
      'SELECT * FROM ticket_channel_archive WHERE ticket_id=$1 LIMIT 1',
      [ticket.id],
    );
    const archive = state.rows[0];
    if (archive?.backfill_complete) {
      // The historic scan is complete, but recent messages may have been
      // missed while Discord/Neon was temporarily unavailable. Reconcile the
      // newest page once more before the destructive action is allowed.
      const recent = await channel.messages.fetch({ limit: ARCHIVE_PAGE_SIZE });
      const orderedRecent = Array.from(recent.values()).sort((a, b) =>
        BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
      );
      for (const message of orderedRecent) await archiveTicketMessage(message);
      return;
    }
    const queryOptions: { limit: number; before?: string } = { limit: ARCHIVE_PAGE_SIZE };
    if (archive?.backfill_cursor) queryOptions.before = archive.backfill_cursor;
    const page = await channel.messages.fetch(queryOptions);
    if (!page.size) {
      await pool.query('UPDATE ticket_channel_archive SET backfill_complete=TRUE, updated_at=NOW() WHERE ticket_id=$1', [ticket.id]);
      continue;
    }
    const ordered = Array.from(page.values()).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
    for (const message of ordered) await archiveTicketMessage(message);
    const oldestId = ordered[0]?.id;
    const done = page.size < ARCHIVE_PAGE_SIZE;
    await pool.query(
      'UPDATE ticket_channel_archive SET backfill_cursor=$2, backfill_complete=$3, updated_at=NOW() WHERE ticket_id=$1',
      [ticket.id, oldestId ?? archive?.backfill_cursor ?? null, done],
    );
  }
}

export async function beginTicketButtonDeletion(
  channel: TextChannel | ThreadChannel,
  actorId: string,
  actorName: string,
): Promise<void> {
  const ticket = await getPersistedTicket(channel.id);
  if (!ticket || !ticket.guildId) throw new Error('Cannot delete a ticket without its durable record.');

  const pool = getPostgresPool();

  // A crashed process can leave a pending intent behind. Expire only an intent
  // for this exact channel after the same ten-minute window used by the
  // channelDelete classifier. The unique index below still arbitrates races.
  await pool.query(
    "UPDATE ticket_recovery_events SET status='cancelled', updated_at=NOW(), " +
      "resolved_at=COALESCE(resolved_at,NOW()), metadata=metadata || jsonb_build_object('cancelReason','expired_pending_intent') " +
      "WHERE guild_id=$1 AND source='ticket_button' AND status='pending' " +
      "AND metadata->>'channelIdAtDeletion'=$2 AND created_at < NOW() - INTERVAL '10 minutes'",
    [ticket.guildId, channel.id],
  );

  try {
    await pool.query(
      'INSERT INTO ticket_recovery_events (id,ticket_id,guild_id,original_channel_id,source,status,intent,actor_id,actor_name,actor_attribution,confirmation_stage,created_at,updated_at,metadata) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW(),$12::jsonb)',
      [
        randomUUID(), ticket.id, ticket.guildId,
        typeof ticket.metadata.originalChannelId === 'string' ? ticket.metadata.originalChannelId : channel.id,
        'ticket_button', 'pending', 'intentional', actorId, actorName, 'actorKnown', 2,
        JSON.stringify({ channelIdAtDeletion: channel.id, ticketNumber: ticket.ticketNumber }),
      ],
    );
  } catch (error) {
    const postgresError = error as { code?: unknown; constraint?: unknown };
    if (
      postgresError.code === '23505' &&
      postgresError.constraint === 'idx_ticket_recovery_pending_button_channel'
    ) {
      throw new Error(
        'A deletion confirmation for this ticket is already being processed. Wait for it to finish, then refresh the ticket controls.',
      );
    }
    throw error;
  }
}

export async function cancelTicketButtonDeletion(channelId: string): Promise<void> {
  const ticket = await getPersistedTicket(channelId).catch(() => undefined);
  if (!ticket) return;
  await getPostgresPool().query(
    'UPDATE ticket_recovery_events SET status=$2, updated_at=NOW(), resolved_at=NOW() ' +
      'WHERE id=(SELECT id FROM ticket_recovery_events WHERE ticket_id=$1 AND source=$3 AND status=$4 ORDER BY created_at DESC LIMIT 1)',
    [ticket.id, 'cancelled', 'ticket_button', 'pending'],
  );
}

/** Called only for the actual Discord channelDelete event. */
export async function recordTicketChannelDeleted(channel: TextChannel | ThreadChannel): Promise<void> {
  const ticket = await getPersistedTicket(channel.id);
  if (!ticket || !ticket.guildId) return;
  if (channel.type === ChannelType.PrivateThread && ticket.metadata.workspaceKind !== 'private-thread') return;

  await archiveTicketChannelSnapshot(channel).catch((error) => {
    console.warn('Could not refresh ticket channel snapshot after deletion event:', error instanceof Error ? error.message : 'unknown error');
  });

  const pool = getPostgresPool();
  // Only match a recent intent for this exact channel. A leftover pending
  // record from a crashed process must not cause a later native Discord delete
  // to be misfiled as a ticket-button deletion.
  const pending = await pool.query<QueryResultRow & { id: string }>(
    "SELECT id FROM ticket_recovery_events WHERE ticket_id=$1 AND source=$2 AND status=$3 " +
      "AND metadata->>'channelIdAtDeletion'=$4 AND created_at >= NOW() - INTERVAL '10 minutes' " +
      'ORDER BY created_at DESC LIMIT 1',
    [ticket.id, 'ticket_button', 'pending', channel.id],
  );
  if (pending.rows[0]) {
    await pool.query(
      'UPDATE ticket_recovery_events SET status=$2, updated_at=NOW(), resolved_at=NOW() WHERE id=$1',
      [pending.rows[0].id, 'deleted'],
    );
  } else {
    await pool.query(
      "UPDATE ticket_recovery_events SET status='cancelled', updated_at=NOW(), resolved_at=NOW() " +
        "WHERE ticket_id=$1 AND source='ticket_button' AND status='pending'",
      [ticket.id],
    );
    await pool.query(
      'INSERT INTO ticket_recovery_events (id,ticket_id,guild_id,original_channel_id,source,status,intent,actor_id,actor_name,actor_attribution,confirmation_stage,created_at,updated_at,metadata) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW(),$12::jsonb)',
      [
        randomUUID(), ticket.id, ticket.guildId,
        typeof ticket.metadata.originalChannelId === 'string' ? ticket.metadata.originalChannelId : channel.id,
        'discord_native', 'deleted', 'unknown', 'unknown', 'Unknown actor', 'actorUnknown', 0,
        JSON.stringify({ channelName: channel.name, channelIdAtDeletion: channel.id }),
      ],
    );
  }

  await markPersistedTicketDeleted(
    channel.id,
    'Ticket channel deleted via ' + (pending.rows[0] ? 'the ticket Delete button' : 'Discord channel controls'),
    pending.rows[0]
      ? { id: 'ticket-button', attribution: 'actorInferred', confidence: 'low' }
      : { id: 'unknown', attribution: 'actorUnknown', confidence: 'none' },
  );
}

/** Return a read-only, privacy-safe preview of what a recovery can reconstruct. */
export async function getTicketRecoveryPreview(
  guildId: string,
  ticketIdOrChannelId: string,
  source: RecoverySource,
): Promise<RecoveryPreviewSummary> {
  let ticket = await getPersistedTicketById(ticketIdOrChannelId);
  if (!ticket) ticket = await getPersistedTicket(ticketIdOrChannelId);
  const pool = getPostgresPool();
  if (!ticket) {
    const archivedChannel = await pool.query<QueryResultRow & { ticket_id: string }>(
      'SELECT ticket_id FROM ticket_channel_archive WHERE guild_id=$1 AND original_channel_id=$2 LIMIT 1',
      [guildId, ticketIdOrChannelId],
    );
    if (archivedChannel.rows[0]) {
      ticket = await getPersistedTicketById(archivedChannel.rows[0].ticket_id);
    }
  }
  if (!ticket || ticket.guildId !== guildId) {
    throw new Error('Ticket recovery record was not found in this server.');
  }
  const ticketId = ticket.id;
  const eventResult = await pool.query<QueryResultRow & {
    status: string;
    accidental_answer: 'yes' | 'no' | null;
    id: string;
  }>(
    'SELECT id,status,accidental_answer FROM ticket_recovery_events ' +
      'WHERE ticket_id=$1 AND guild_id=$2 AND source=$3 ORDER BY created_at DESC LIMIT 1',
    [ticketId, guildId, source],
  );
  const recoveryEvent = eventResult.rows[0];
  if (!recoveryEvent) {
    throw new Error('No recovery record exists for this ticket and deletion path.');
  }

  const [snapshotResult, messageResult, attachmentResult, replayResult] = await Promise.all([
    pool.query<QueryResultRow & { backfill_complete: boolean }>(
      'SELECT backfill_complete FROM ticket_channel_archive WHERE ticket_id=$1 AND guild_id=$2 LIMIT 1',
      [ticketId, guildId],
    ),
    pool.query<QueryResultRow & {
      message_count: number | string;
      deleted_message_count: number | string;
      attachment_count: number | string;
      latest_archived_at: Date | string | null;
    }>(
      'SELECT COUNT(*)::int AS message_count, ' +
        'COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted_message_count, ' +
        "COALESCE(SUM(CASE WHEN jsonb_typeof(attachments)='array' THEN jsonb_array_length(attachments) ELSE 0 END),0)::int AS attachment_count, " +
        'MAX(created_at) AS latest_archived_at ' +
        'FROM ticket_message_archive WHERE ticket_id=$1 AND guild_id=$2',
      [ticketId, guildId],
    ),
    pool.query<QueryResultRow & {
      tracked_attachment_count: number | string;
      restorable_attachment_count: number | string;
      too_large_attachment_count: number | string;
      metadata_only_attachment_count: number | string;
      pending_attachment_count: number | string;
      failed_attachment_count: number | string;
    }>(
      'SELECT COUNT(*)::int AS tracked_attachment_count, ' +
        "COUNT(*) FILTER (WHERE archive_status='archived' AND archived_bytes IS NOT NULL)::int AS restorable_attachment_count, " +
        "COUNT(*) FILTER (WHERE archive_status='too_large')::int AS too_large_attachment_count, " +
        "COUNT(*) FILTER (WHERE archive_status='metadata_only')::int AS metadata_only_attachment_count, " +
        "COUNT(*) FILTER (WHERE archive_status='pending')::int AS pending_attachment_count, " +
        "COUNT(*) FILTER (WHERE archive_status='failed' OR (archive_error IS NOT NULL AND archive_status NOT IN ('too_large','metadata_only')))::int AS failed_attachment_count " +
        'FROM ticket_message_archive_attachments WHERE guild_id=$1 AND message_id IN ' +
        '(SELECT message_id FROM ticket_message_archive WHERE ticket_id=$2 AND guild_id=$1)',
      [guildId, ticketId],
    ),
    pool.query<QueryResultRow & { already_replayed_message_count: number | string }>(
      "SELECT COUNT(DISTINCT replay.original_message_id)::int AS already_replayed_message_count " +
        'FROM ticket_recovery_replay_items replay ' +
        'JOIN ticket_message_archive archived ON archived.message_id=replay.original_message_id ' +
        "WHERE replay.recovery_event_id=$1 AND replay.status='completed' AND archived.ticket_id=$2 AND archived.guild_id=$3",
      [recoveryEvent.id, ticketId, guildId],
    ),
  ]);

  const snapshot = snapshotResult.rows[0];
  const messages = messageResult.rows[0];
  const attachments = attachmentResult.rows[0];
  const replay = replayResult.rows[0];
  const isoDate = (value: Date | string | null | undefined): string | null => {
    if (value == null) return null;
    const timestamp = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    return Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
  };

  return buildRecoveryPreviewSummary({
    source,
    status: recoveryEvent.status,
    accidentalAnswer: recoveryEvent.accidental_answer,
    channelSnapshotAvailable: Boolean(snapshot),
    historicalBackfillComplete: snapshot?.backfill_complete === true,
    archivedMessageCount: Number(messages?.message_count ?? 0),
    deletedMessageCount: Number(messages?.deleted_message_count ?? 0),
    latestArchivedAt: isoDate(messages?.latest_archived_at),
    totalAttachmentCount: Number(messages?.attachment_count ?? 0),
    trackedAttachmentCount: Number(attachments?.tracked_attachment_count ?? 0),
    restorableAttachmentCount: Number(attachments?.restorable_attachment_count ?? 0),
    tooLargeAttachmentCount: Number(attachments?.too_large_attachment_count ?? 0),
    metadataOnlyAttachmentCount: Number(attachments?.metadata_only_attachment_count ?? 0),
    pendingAttachmentCount: Number(attachments?.pending_attachment_count ?? 0),
    failedAttachmentCount: Number(attachments?.failed_attachment_count ?? 0),
    alreadyReplayedMessageCount: Number(replay?.already_replayed_message_count ?? 0),
  });
}

export async function listTicketRecoveryCandidates(
  guildId: string,
  source: 'discord_native' | 'ticket_button',
): Promise<TicketRecoveryCandidate[]> {
  const statusPredicate = source === 'discord_native'
    ? "r.status IN ('deleted','failed','restoring')"
    : "((r.status='deleted' AND r.accidental_answer IS NULL) OR (r.status IN ('reviewed','failed','restoring') AND r.accidental_answer='yes'))";
  const result = await getPostgresPool().query<QueryResultRow & {
    ticket_id: string;
    guild_id: string;
    original_channel_id: string;
    ticket_number: string | null;
    owner_id: string | null;
    source: 'discord_native' | 'ticket_button';
    status: string;
    intent: string;
    accidental_answer: 'yes' | 'no' | null;
    message_count: string | number;
    created_at: Date | string;
    answered_by: string | null;
  }>(
    'WITH latest AS (SELECT DISTINCT ON (ticket_id) * FROM ticket_recovery_events WHERE guild_id=$1 AND source=$2 ORDER BY ticket_id,created_at DESC) ' +
      'SELECT r.ticket_id,r.guild_id,r.original_channel_id,t.ticket_number,t.owner_id,r.source,r.status,r.intent,r.accidental_answer,r.created_at,r.answered_by, ' +
      'COUNT(m.message_id)::int AS message_count FROM latest r JOIN tickets t ON t.id=r.ticket_id ' +
      'LEFT JOIN ticket_message_archive m ON m.ticket_id=r.ticket_id WHERE ' + statusPredicate +
      ' GROUP BY r.ticket_id,r.guild_id,r.original_channel_id,t.ticket_number,t.owner_id,r.source,r.status,r.intent,r.accidental_answer,r.created_at,r.answered_by ' +
      'ORDER BY r.created_at DESC LIMIT 200',
    [guildId, source],
  );

  return result.rows.map((row) => ({
    ticketId: row.ticket_id,
    guildId: row.guild_id,
    originalChannelId: row.original_channel_id,
    ticketNumber: row.ticket_number ?? row.ticket_id.slice(0, 8),
    ownerId: row.owner_id ?? 'unknown',
    source: row.source,
    status: row.status,
    intent: row.intent,
    accidentalAnswer: row.accidental_answer,
    messageCount: Number(row.message_count),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    answeredBy: row.answered_by,
  }));
}

export async function answerTicketDeletionReview(
  ticketId: string,
  answer: 'yes' | 'no',
  actorId: string,
  actorName: string,
): Promise<{ ticketId: string; guildId: string; originalChannelId: string; ticketNumber: string }> {
  const pool = getPostgresPool();
  const ticket = await getPersistedTicketById(ticketId);
  if (!ticket || !ticket.guildId) throw new Error('Ticket not found in durable storage.');
  const updated = await pool.query<QueryResultRow & { id: string; original_channel_id: string }>(
    'UPDATE ticket_recovery_events SET accidental_answer=$2, intent=$3, status=$4, answered_by=$5, answered_by_name=$6, answer_timestamp=NOW(), updated_at=NOW() ' +
      'WHERE id=(SELECT id FROM ticket_recovery_events WHERE ticket_id=$1 AND source=$7 AND status=$8 AND accidental_answer IS NULL ORDER BY created_at DESC LIMIT 1) ' +
      'RETURNING id,original_channel_id',
    [ticketId, answer, answer === 'yes' ? 'accidental' : 'intentional', 'reviewed', actorId, actorName, 'ticket_button', 'deleted'],
  );
  if (!updated.rows[0]) throw new Error('This ticket deletion has already been reviewed or is no longer awaiting an answer.');
  return {
    ticketId,
    guildId: ticket.guildId,
    originalChannelId: updated.rows[0].original_channel_id,
    ticketNumber: ticket.ticketNumber ?? ticketId.slice(0, 8),
  };
}

async function permissionOverwritePayload(
  guild: Guild,
  ticket: NonNullable<Awaited<ReturnType<typeof getPersistedTicketById>>>,
  raw: unknown,
): Promise<Array<{ id: string; type: OverwriteType; allow: PermissionResolvable[]; deny: PermissionResolvable[] }>> {
  const values = parseJsonArray(raw) as Array<Record<string, unknown>>;
  const map = new Map<string, { id: string; type: OverwriteType; allow: PermissionResolvable[]; deny: PermissionResolvable[] }>();

  for (const item of values) {
    const id = typeof item.id === 'string' ? item.id : '';
    const type = item.type === 1 ? OverwriteType.Member : OverwriteType.Role;
    if (!/^\d{17,20}$/.test(id)) continue;
    if (type === OverwriteType.Role && id !== guild.id && !guild.roles.cache.has(id)) continue;
    if (type === OverwriteType.Member) {
      const member = guild.members.cache.get(id) ?? await guild.members.fetch(id).catch(() => null);
      if (!member) continue;
    }
    let allow: PermissionResolvable[] = [];
    let deny: PermissionResolvable[] = [];
    try { allow = new PermissionsBitField(BigInt(String(item.allow ?? '0'))).toArray(); } catch { /* malformed legacy snapshot */ }
    try { deny = new PermissionsBitField(BigInt(String(item.deny ?? '0'))).toArray(); } catch { /* malformed legacy snapshot */ }
    map.set(id, { id, type, allow, deny });
  }

  const everyone = map.get(guild.id) ?? { id: guild.id, type: OverwriteType.Role, allow: [], deny: [] };
  everyone.allow = everyone.allow.filter((permission) => permission !== PermissionFlagsBits.ViewChannel);
  if (!everyone.deny.includes(PermissionFlagsBits.ViewChannel)) everyone.deny.push(PermissionFlagsBits.ViewChannel);
  map.set(guild.id, everyone);

  const bot = guild.members.me ?? await guild.members.fetchMe();
  const botOverwrite = map.get(bot.id) ?? { id: bot.id, type: OverwriteType.Member, allow: [], deny: [] };
  botOverwrite.deny = botOverwrite.deny.filter((permission) =>
    ![PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageChannels].includes(permission as bigint),
  );
  for (const permission of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageChannels]) {
    if (!botOverwrite.allow.includes(permission)) botOverwrite.allow.push(permission);
  }
  map.set(bot.id, botOverwrite);

  const ownerId = ticket.ownerId;
  const participantIds = [...new Set([...(ticket.participantIds ?? []), ...(ownerId ? [ownerId] : [])])].slice(0, 50);
  for (const userId of participantIds) {
    const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    const existing = map.get(userId) ?? { id: userId, type: OverwriteType.Member, allow: [], deny: [] };
    existing.deny = existing.deny.filter((permission) =>
      ![PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks].includes(permission as bigint),
    );
    for (const permission of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks]) {
      if (!existing.allow.includes(permission)) existing.allow.push(permission);
    }
    map.set(userId, existing);
  }
  return Array.from(map.values());
}

function recoveryMarkersInMessage(message: Message): string[] {
  return extractRecoverySegmentMarkers([
    message.content,
    ...message.embeds.map((embed) => embed.footer?.text ?? ''),
  ]);
}

function recoveryMarkerMessageMap(messages: Iterable<Message>): Map<string, string> {
  const markers = new Map<string, string>();
  for (const message of messages) {
    for (const marker of recoveryMarkersInMessage(message)) markers.set(marker, message.id);
  }
  return markers;
}

async function findRecoveryMarkerInHistory(
  channel: TextChannel,
  marker: string,
  notBefore: Date,
): Promise<string | null> {
  const minimumTimestamp = notBefore.getTime();
  let before: string | undefined;
  while (true) {
    const options: { limit: number; before?: string } = { limit: 100 };
    if (before) options.before = before;
    const page = await channel.messages.fetch(options);
    if (page.size === 0) return null;

    for (const message of page.values()) {
      if (message.createdTimestamp < minimumTimestamp) continue;
      if (recoveryMarkersInMessage(message).includes(marker)) return message.id;
    }

    const oldest = Array.from(page.values()).reduce((current, candidate) =>
      BigInt(candidate.id) < BigInt(current.id) ? candidate : current,
    );
    if (oldest.createdTimestamp < minimumTimestamp || page.size < 100) return null;
    before = oldest.id;
  }
}

class RecoverySegmentPersistenceError extends Error {
  public constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'RecoverySegmentPersistenceError';
  }
}

async function persistRecoverySegment<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new RecoverySegmentPersistenceError('Could not persist ticket recovery segment state.', error);
  }
}

/**
 * Persist intent before sending and completion after Discord accepts the send.
 * If the completion write fails, a retry searches channel history from the
 * previous attempt timestamp for the invisible deterministic marker.
 */
async function sendRecoverySegment(
  channel: TextChannel,
  payload: MessageCreateOptions,
  recoveryEventId: string,
  originalMessageId: string,
  segmentKey: string,
  seenMarkers: Map<string, string>,
): Promise<void> {
  const pool = getPostgresPool();
  const marker = recoverySegmentMarker(recoveryEventId, originalMessageId, segmentKey);
  await persistRecoverySegment(() => pool.query(
    'INSERT INTO ticket_recovery_replay_segments ' +
      '(recovery_event_id,original_message_id,segment_key,status,attempts,attempt_started_at,created_at,updated_at) ' +
      "VALUES ($1,$2,$3,'pending',0,NOW(),NOW(),NOW()) ON CONFLICT (recovery_event_id,original_message_id,segment_key) DO NOTHING",
    [recoveryEventId, originalMessageId, segmentKey],
  ));
  const state = await persistRecoverySegment(() => pool.query<QueryResultRow & {
    status: 'pending' | 'completed';
    discord_message_id: string | null;
    attempt_started_at: Date | string;
  }>(
    'SELECT status,discord_message_id,attempt_started_at FROM ticket_recovery_replay_segments ' +
      'WHERE recovery_event_id=$1 AND original_message_id=$2 AND segment_key=$3 LIMIT 1',
    [recoveryEventId, originalMessageId, segmentKey],
  ));
  const saved = state.rows[0];
  if (!saved) throw new RecoverySegmentPersistenceError('Recovery segment intent was not returned by PostgreSQL.', new Error('Missing row'));
  if (saved.status === 'completed') {
    if (saved.discord_message_id) seenMarkers.set(marker, saved.discord_message_id);
    return;
  }

  const knownMessageId = seenMarkers.get(marker) ??
    await findRecoveryMarkerInHistory(
      channel,
      marker,
      saved.attempt_started_at instanceof Date ? saved.attempt_started_at : new Date(saved.attempt_started_at),
    );
  if (knownMessageId) {
    await persistRecoverySegment(() => pool.query(
      "UPDATE ticket_recovery_replay_segments SET status='completed',discord_message_id=$4,last_error=NULL,updated_at=NOW() " +
        'WHERE recovery_event_id=$1 AND original_message_id=$2 AND segment_key=$3',
      [recoveryEventId, originalMessageId, segmentKey, knownMessageId],
    ));
    seenMarkers.set(marker, knownMessageId);
    return;
  }

  // Persist the search lower bound before the send. A retry can then search
  // every message created since this attempt, not just the newest 100.
  await persistRecoverySegment(() => pool.query(
    'UPDATE ticket_recovery_replay_segments SET attempts=attempts+1,attempt_started_at=NOW(),last_error=NULL,updated_at=NOW() ' +
      "WHERE recovery_event_id=$1 AND original_message_id=$2 AND segment_key=$3 AND status='pending'",
    [recoveryEventId, originalMessageId, segmentKey],
  ));

  try {
    const sent = await channel.send(payload);
    seenMarkers.set(marker, sent.id);
    await persistRecoverySegment(() => pool.query(
      "UPDATE ticket_recovery_replay_segments SET status='completed',discord_message_id=$4,last_error=NULL,updated_at=NOW() " +
        'WHERE recovery_event_id=$1 AND original_message_id=$2 AND segment_key=$3',
      [recoveryEventId, originalMessageId, segmentKey, sent.id],
    ));
  } catch (error) {
    if (!(error instanceof RecoverySegmentPersistenceError)) {
      const safeError = error instanceof Error ? error.name.slice(0, 80) : 'UnknownError';
      await pool.query(
        'UPDATE ticket_recovery_replay_segments SET last_error=$4,updated_at=NOW() ' +
          'WHERE recovery_event_id=$1 AND original_message_id=$2 AND segment_key=$3',
        [recoveryEventId, originalMessageId, segmentKey, safeError],
      ).catch(() => undefined);
    }
    throw error;
  }
}

async function replayArchivedMessages(channel: TextChannel, ticketId: string, recoveryEventId: string): Promise<{ restored: number; failed: number }> {
  const pool = getPostgresPool();
  let restored = 0;
  let failed = 0;
  const botId = channel.client.user?.id;
  // Recover markers from recent history before sending anything. Stop after a failed item so these remain searchable.
  const recentMessages = await channel.messages.fetch({ limit: 100 });
  const seenMarkers = recoveryMarkerMessageMap(recentMessages.values());
  let cursorCreatedAt: string | null = null;
  let cursorMessageId: string | null = null;

  // Keyset pagination replays the complete archive without loading every row
  // into memory or silently truncating recovery at a fixed message count.
  while (true) {
    const pageResult: QueryResult<MessageArchiveRow> = cursorCreatedAt === null || cursorMessageId === null
      ? await pool.query<MessageArchiveRow>(
          'SELECT * FROM ticket_message_archive WHERE ticket_id=$1 ORDER BY created_at ASC,message_id ASC LIMIT $2',
          [ticketId, ARCHIVE_PAGE_SIZE],
        )
      : await pool.query<MessageArchiveRow>(
          'SELECT * FROM ticket_message_archive WHERE ticket_id=$1 AND (created_at,message_id)>($2::timestamptz,$3::text) ORDER BY created_at ASC,message_id ASC LIMIT $4',
          [ticketId, cursorCreatedAt, cursorMessageId, ARCHIVE_PAGE_SIZE],
        );
    const pageRows: MessageArchiveRow[] = pageResult.rows;
    if (pageRows.length === 0) break;

    for (const archived of pageRows) {
    const replayed = await pool.query(
      'SELECT 1 FROM ticket_recovery_replay_items WHERE recovery_event_id=$1 AND original_message_id=$2 LIMIT 1',
      [recoveryEventId, archived.message_id],
    );
    if (replayed.rows.length) {
      restored += 1;
      continue;
    }

    const archivedEmbeds = parseJsonArray(archived.embeds);
    const archivedComponents = parseJsonArray(archived.components) as Array<Record<string, unknown>>;
    const isPanel = archived.is_bot && archivedComponents.some((row) => {
      const components = Array.isArray(row.components) ? row.components as Array<Record<string, unknown>> : [];
      return components.some((component) => {
        const customId = String(component.custom_id ?? component.customId ?? '');
        return customId.startsWith('ticket:');
      });
    }) && archivedEmbeds.some((entry) => /(?:QueryFixr|SupportForge) Ticket #/.test(String((entry as Record<string, unknown>).title ?? '')));
    if (isPanel || (botId && archived.author_id === botId && archivedComponents.length > 0 && archivedEmbeds.length > 0 &&
      archivedEmbeds.some((entry) => /(?:QueryFixr|SupportForge) Ticket #/.test(String((entry as Record<string, unknown>).title ?? ''))))) {
      continue;
    }

    try {
      const author = archived.author_display_name || archived.author_username || 'Unknown author';
      const originalCreatedAt = archived.created_at instanceof Date
        ? archived.created_at.toISOString()
        : new Date(archived.created_at).toISOString();
      const attribution = '[Recovered original message by ' + author +
        ' • Original user ID: ' + archived.author_id +
        ' • Original channel ID: ' + archived.original_channel_id +
        ' • Original message ID: ' + archived.message_id +
        ' • Original timestamp (UTC): ' + originalCreatedAt + ']';
      const config = await getGuildConfig(channel.guild.id).catch(() => null);
      const color = getThemeColor(config?.theme ?? 'midnight');

      const header = new EmbedBuilder()
        .setColor(color)
        .setTitle(('Recovered message • ' + author).slice(0, 256))
        .setDescription(
          'This content was reposted by QueryFixr from its durable archive. It is not an original Discord message authored by the user.\n\n' +
          '**Original author:** ' + author + ' (user ID: ' + archived.author_id + ')\n' +
          '**Original channel ID:** ' + archived.original_channel_id + '\n' +
          '**Original message ID:** ' + archived.message_id + '\n' +
          '**Original timestamp (UTC):** ' + originalCreatedAt,
        )
        .setFooter({ text: RECOVERY_FOOTER_PREFIX + ' • Original message ID ' + archived.message_id + recoverySegmentMarker(recoveryEventId, archived.message_id, 'header') });
      try {
        if (archived.author_avatar_url) header.setAuthor({ name: author.slice(0, 256), iconURL: archived.author_avatar_url });
      } catch { /* An expired avatar URL does not block message replay. */ }
      if (archived.edited_at) {
        const edited = archived.edited_at instanceof Date ? archived.edited_at.toISOString() : new Date(archived.edited_at).toISOString();
        header.addFields({ name: 'Last archived edit (UTC)', value: edited, inline: true });
      }
      const archivedComponents = parseJsonArray(archived.components) as Array<Record<string, unknown>>;
      const componentCount = archivedComponents.reduce((total, row) =>
        total + (Array.isArray(row.components) ? (row.components as unknown[]).length : 0), 0);
      if (componentCount > 0) {
        header.addFields({
          name: 'Original interactive controls',
          value: componentCount + ' control(s) were present. Historical controls are not reactivated during replay; the live ticket panel has been rebuilt with current safe actions.',
        });
      }
      await sendRecoverySegment(channel, { embeds: [header], allowedMentions: { parse: [] } }, recoveryEventId, archived.message_id, 'header', seenMarkers);

      const content = archived.content ?? '';
      if (content) {
        const chunks = chunkText(content, Math.max(500, 1800 - attribution.length - 40));
        for (let part = 0; part < chunks.length; part += 1) {
          const partLabel = chunks.length > 1 ? ' • part ' + (part + 1) + '/' + chunks.length : '';
          const prefix = attribution + partLabel + '\n';
          const marker = recoverySegmentMarker(recoveryEventId, archived.message_id, 'content:' + part);
          await sendRecoverySegment(channel, {
            content: prefix + chunks[part] + marker,
            allowedMentions: { parse: [] },
          }, recoveryEventId, archived.message_id, 'content:' + part, seenMarkers);
        }
      } else if (archivedEmbeds.length === 0 && archivedComponents.length === 0) {
        const marker = recoverySegmentMarker(recoveryEventId, archived.message_id, 'empty-content');
        await sendRecoverySegment(channel, {
          content: attribution + '\n[The original message contained no text content.]' + marker,
          allowedMentions: { parse: [] },
        }, recoveryEventId, archived.message_id, 'empty-content', seenMarkers);
      }

      // Embeds are replayed separately so recovery attribution cannot push an
      // originally valid embed over Discord's combined 6,000-character limit.
      const originalEmbeds = archivedEmbeds.flatMap((entry) => {
        try { return [EmbedBuilder.from(entry as APIEmbed)]; } catch { return []; }
      });
      for (let index = 0; index < originalEmbeds.length; index += 5) {
        const marker = recoverySegmentMarker(recoveryEventId, archived.message_id, 'embeds:' + index);
        await sendRecoverySegment(channel, {
          content: attribution + (originalEmbeds.length > 5 ? ' • archived embed ' + (index + 1) + '-' + Math.min(index + 5, originalEmbeds.length) + '/' + originalEmbeds.length : ' • original embed') + marker,
          embeds: originalEmbeds.slice(index, index + 5),
          allowedMentions: { parse: [] },
        }, recoveryEventId, archived.message_id, 'embeds:' + index, seenMarkers);
      }

      const attachmentRows = await pool.query<AttachmentArchiveRow>(
        'SELECT * FROM ticket_message_archive_attachments WHERE message_id=$1 ORDER BY attachment_id',
        [archived.message_id],
      );
      const unavailable: string[] = [];
      for (const attachment of attachmentRows.rows) {
        if (attachment.archived_bytes && attachment.archive_status === 'archived') {
          try {
            const marker = recoverySegmentMarker(recoveryEventId, archived.message_id, 'attachment:' + attachment.attachment_id);
            await sendRecoverySegment(channel, {
              content: attribution + '\n📎 Recovered attachment: ' + attachment.original_filename + marker,
              files: [new AttachmentBuilder(attachment.archived_bytes, { name: safeFilename(attachment.original_filename) })],
              allowedMentions: { parse: [] },
            }, recoveryEventId, archived.message_id, 'attachment:' + attachment.attachment_id, seenMarkers);
          } catch (error) {
            if (error instanceof RecoverySegmentPersistenceError) throw error;
            unavailable.push(attachment.original_filename + ' (upload failed: ' + (error instanceof Error ? error.name : 'unknown error') + ')');
          }
        } else {
          unavailable.push(attachment.original_filename + (attachment.archive_error ? ' (' + attachment.archive_error + ')' : ' (file bytes were not archived)'));
        }
      }
      if (unavailable.length) {
        const unavailableParts = chunkText(unavailable.join('\n'), 1500);
        for (let partIndex = 0; partIndex < unavailableParts.length; partIndex += 1) {
          const part = unavailableParts[partIndex]!;
          const segmentKey = 'unavailable-attachments:' + partIndex;
          const marker = recoverySegmentMarker(recoveryEventId, archived.message_id, segmentKey);
          await sendRecoverySegment(channel, {
            content: attribution + '\nAttachments that could not be restored:\n' + part + marker,
            allowedMentions: { parse: [] },
          }, recoveryEventId, archived.message_id, segmentKey, seenMarkers);
        }
      }
      await pool.query(
        'INSERT INTO ticket_recovery_replay_items (recovery_event_id, original_message_id, status, replayed_at) ' +
          'VALUES ($1,$2,$3,NOW()) ON CONFLICT (recovery_event_id, original_message_id) DO NOTHING',
        [recoveryEventId, archived.message_id, 'completed'],
      );
      restored += 1;
    } catch (error) {
      failed += 1;
      console.warn('QueryFixr could not replay archived message ' + archived.message_id + ':', error instanceof Error ? error.message : 'unknown error');
      // Fail fast: don't push an uncertain partial replay out of the recent-history retry window.
      return { restored, failed };
    }
    }

    const lastArchived = pageRows[pageRows.length - 1] as MessageArchiveRow;
    cursorCreatedAt = lastArchived.created_at instanceof Date
      ? lastArchived.created_at.toISOString()
      : new Date(lastArchived.created_at).toISOString();
    cursorMessageId = lastArchived.message_id;
  }
  return { restored, failed };
}

/** Recreate a deleted ticket in a new channel and replay its archived conversation. */
async function restoreArchivedTicketUnlocked(
  guild: Guild,
  ticketId: string,
  source: 'discord_native' | 'ticket_button',
): Promise<{ channelId: string; restoredMessages: number; failedMessages: number; ticketNumber: string }> {
  const pool = getPostgresPool();
  const ticket = await getPersistedTicketById(ticketId);
  if (!ticket || ticket.guildId !== guild.id) throw new Error('Ticket was not found in this server.');
  const events = await pool.query<QueryResultRow & { id: string; original_channel_id: string; replacement_channel_id: string | null; status: string; accidental_answer: string | null }>(
    'SELECT id,original_channel_id,replacement_channel_id,status,accidental_answer FROM ticket_recovery_events WHERE ticket_id=$1 AND guild_id=$2 AND source=$3 ORDER BY created_at DESC LIMIT 1',
    [ticketId, guild.id, source],
  );
  const recoveryEvent = events.rows[0];
  if (!recoveryEvent) throw new Error('No recovery record exists for this ticket and deletion path.');
  if (source === 'ticket_button' && !(
    (recoveryEvent.status === 'reviewed' || recoveryEvent.status === 'restoring' || recoveryEvent.status === 'failed') &&
    recoveryEvent.accidental_answer === 'yes'
  )) {
    throw new Error('Ticket-button deletions can only be restored after the Settings review marks the deletion as accidental.');
  }
  if (source === 'discord_native' && !['deleted', 'failed', 'restoring'].includes(recoveryEvent.status)) {
    throw new Error('This native channel deletion has already been restored or is not eligible for recovery.');
  }

  const snapshots = await pool.query<ChannelArchiveRow>(
    'SELECT * FROM ticket_channel_archive WHERE ticket_id=$1 LIMIT 1',
    [ticketId],
  );
  const snapshot = snapshots.rows[0];
  const config = await getGuildConfig(guild.id);
  let parentId: string | null = null;
  if (snapshot?.parent_id) {
    const candidate = guild.channels.cache.get(snapshot.parent_id);
    if (candidate?.type === ChannelType.GuildCategory) parentId = candidate.id;
  }
  if (!parentId && config.supportCategoryId) {
    const candidate = guild.channels.cache.get(config.supportCategoryId);
    if (candidate?.type === ChannelType.GuildCategory) parentId = candidate.id;
  }

  const permissions = await permissionOverwritePayload(guild, ticket, snapshot?.permission_overwrites ?? []);
  const channelName = (snapshot?.channel_name || ('ticket-' + (ticket.ticketNumber ?? ticketId.slice(0, 8))))
    .toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 90) || 'recovered-ticket';
  let topic = snapshot?.topic ?? '';
  if (!topic || !isTicketTopic(topic)) {
    topic = 'supportforge:ticket';
    topic = setField(topic, 'number', ticket.ticketNumber ?? ticketId.slice(0, 8));
    topic = setField(topic, 'owner', ticket.ownerId ?? '');
    topic = setField(topic, 'department', ticket.departmentId ?? '');
    topic = setField(topic, 'tags', ticket.tagId ?? '');
    topic = setField(topic, 'priority', ticket.priority ?? 'normal');
    topic = setField(topic, 'status', ticket.status);
    topic = setField(topic, 'opened_at', ticket.createdAt);
  }
  topic = removeField(topic, 'message');
  topic = setField(topic, 'original_channel_id', recoveryEvent.original_channel_id);
  topic = setField(topic, 'restored_from', recoveryEvent.original_channel_id);
  topic = setField(topic, 'recovery_event', recoveryEvent.id);
  topic = setField(topic, 'status', ticket.status);
  if (topic.length > 1024) {
    // Keep the durable identifiers and routing metadata rather than truncating
    // the recovery marker from a legacy topic that already used the full limit.
    topic = 'supportforge:ticket';
    topic = setField(topic, 'number', ticket.ticketNumber ?? ticketId.slice(0, 8));
    topic = setField(topic, 'owner', ticket.ownerId ?? '');
    topic = setField(topic, 'department', ticket.departmentId ?? '');
    topic = setField(topic, 'tags', ticket.tagId ?? '');
    topic = setField(topic, 'priority', ticket.priority ?? 'normal');
    topic = setField(topic, 'status', ticket.status);
    topic = setField(topic, 'opened_at', ticket.createdAt);
    topic = setField(topic, 'original_channel_id', recoveryEvent.original_channel_id);
    topic = setField(topic, 'restored_from', recoveryEvent.original_channel_id);
    topic = setField(topic, 'recovery_event', recoveryEvent.id);
  }

  let channel: TextChannel;
  const replacementBySavedId = recoveryEvent.replacement_channel_id
    ? await guild.channels.fetch(recoveryEvent.replacement_channel_id).catch(() => null)
    : null;
  // If the process crashed after Discord created the replacement channel but
  // before Neon saved its ID, find the channel by the durable recovery-event
  // marker written into its topic during channel creation.
  const replacementByTopic = replacementBySavedId ?? Array.from(guild.channels.cache.values()).find((candidate) =>
    candidate.type === ChannelType.GuildText &&
    getField(candidate.topic ?? '', 'recovery_event') === recoveryEvent.id
  ) ?? null;
  const existingReplacement = replacementByTopic;
  if (existingReplacement) {
    if (existingReplacement.type !== ChannelType.GuildText) {
      throw new Error('The saved recovery channel ID exists but is not a text channel; refusing to create a duplicate.');
    }
    channel = existingReplacement;
  } else {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      ...(parentId ? { parent: parentId } : {}),
      topic: topic.slice(0, 1024),
      permissionOverwrites: permissions,
      position: snapshot?.position,
      nsfw: snapshot?.nsfw ?? false,
      rateLimitPerUser: snapshot?.rate_limit_per_user ?? 0,
      reason: 'QueryFixr ticket recovery; original channel ID ' + recoveryEvent.original_channel_id,
    });
    await pool.query(
      "UPDATE ticket_recovery_events SET status='restoring', replacement_channel_id=$2, updated_at=NOW(), resolved_at=NULL WHERE id=$1",
      [recoveryEvent.id, channel.id],
    );
  }

  const restoredAt = new Date().toISOString();
  await pool.query(
    'UPDATE tickets SET channel_id=$1, deleted_at=NULL, deletion_reason=NULL, updated_at=NOW(), ' +
      'metadata=metadata || $2::jsonb WHERE id=$3 AND guild_id=$4',
    [
      channel.id,
      JSON.stringify({
        originalChannelId: recoveryEvent.original_channel_id,
        restoredChannelId: channel.id,
        restoredAt,
        recoveredFromDeletionSource: source,
        ticketChannelType: 'text',
        workspaceKind: null,
        ticketTopic: topic,
        threadParentChannelId: null,
      }),
      ticketId,
      guild.id,
    ],
  );
  await pool.query(
    "UPDATE ticket_recovery_events SET status='restoring', replacement_channel_id=$2, updated_at=NOW(), resolved_at=NULL WHERE id=$1",
    [recoveryEvent.id, channel.id],
  );

  await refreshTicketPanel(channel, topic);
  const replay = await replayArchivedMessages(channel, ticketId, recoveryEvent.id);
  await pool.query(
    'UPDATE ticket_recovery_events SET status=$2, replacement_channel_id=$3, updated_at=NOW(), resolved_at=NOW(), ' +
      "metadata=metadata || $4::jsonb WHERE id=$1",
    [
      recoveryEvent.id,
      replay.failed === 0 ? 'restored' : 'failed',
      channel.id,
      JSON.stringify({ replayRestoredMessages: replay.restored, replayFailedMessages: replay.failed, replayAttemptedAt: new Date().toISOString() }),
    ],
  );
  await archiveTicketChannelSnapshot(channel).catch((error) => {
    console.warn('Could not refresh the restored ticket channel snapshot:', error instanceof Error ? error.message : 'unknown error');
  });

  return {
    channelId: channel.id,
    restoredMessages: replay.restored,
    failedMessages: replay.failed,
    ticketNumber: ticket.ticketNumber ?? ticketId.slice(0, 8),
  };
}


/** Serialize restore attempts for this ticket/deletion path across bot processes. */
export async function restoreArchivedTicket(
  guild: Guild,
  ticketId: string,
  source: 'discord_native' | 'ticket_button',
): Promise<{ channelId: string; restoredMessages: number; failedMessages: number; ticketNumber: string }> {
  return withPostgresAdvisoryLock(
    'resolvx:ticket-restore:' + guild.id + ':' + ticketId + ':' + source,
    'A restoration for this ticket is already running in another process. Check the recovery record before retrying.',
    () => restoreArchivedTicketUnlocked(guild, ticketId, source),
  );
}
