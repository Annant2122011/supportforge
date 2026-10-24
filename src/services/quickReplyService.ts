import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import type { Guild, TextChannel, ThreadChannel } from 'discord.js';
import { getGuildConfig } from './configService';
import { getPersistedTicket } from './ticketPersistenceService';
import { logTicketEvent } from './auditLogService';

export interface QuickReply {
  id: string;
  guildId: string;
  name: string;
  body: string;
  category: string;
  tags: string[];
  allowedRoleIds: string[];
  enabled: boolean;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuickReplyAccess {
  isAdmin: boolean;
  roleIds: string[];
}

export interface QuickReplyInput {
  name: string;
  body: string;
  category?: string;
  tags?: string[];
  allowedRoleIds?: string[];
  enabled?: boolean;
}

export interface QuickReplyContext {
  user: string;
  username: string;
  ticketId?: string;
  ticketNumber?: string;
  department?: string;
  priority?: string;
  staff?: string;
}

interface QuickReplyRow extends QueryResultRow {
  id: string;
  guild_id: string;
  name: string;
  body: string;
  category: string;
  tags: string[] | null;
  allowed_role_ids: string[] | null;
  enabled: boolean;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS = 'id,guild_id,name,body,category,tags,allowed_role_ids,enabled,version,created_by,updated_by,created_at,updated_at';

export interface QuickReplyRevision {
  version: number;
  name: string;
  operation: 'created' | 'updated' | 'deleted' | 'baseline' | 'restored';
  enabled: boolean;
  changedBy: string;
  createdAt: string;
}

async function insertQuickReplyRevision(
  client: PoolClient,
  reply: QuickReply,
  actorId: string,
  operation: QuickReplyRevision['operation'],
): Promise<void> {
  await client.query(
    'INSERT INTO quick_reply_revisions ' +
      '(id,guild_id,quick_reply_id,version,name,body,category,tags,allowed_role_ids,enabled,operation,changed_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [randomUUID(), reply.guildId, reply.id, reply.version, reply.name, reply.body,
      reply.category, reply.tags, reply.allowedRoleIds, reply.enabled, operation, actorId],
  );
}
const PLACEHOLDERS = new Set(['user','username','ticket_id','ticket_number','department','priority','staff']);
const TOKEN_PATTERN = /\{([a-z][a-z0-9_]*)\}/gi;
const BRACED_TEXT_PATTERN = /\{([^{}]*)\}/g;

function iso(value: Date | string): string {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date(0).toISOString();
}
function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US');
}
function fromRow(row: QuickReplyRow): QuickReply {
  return {
    id:row.id,guildId:row.guild_id,name:row.name,body:row.body,category:row.category,
    tags:Array.isArray(row.tags)?row.tags:[],allowedRoleIds:Array.isArray(row.allowed_role_ids)?row.allowed_role_ids:[],
    enabled:Boolean(row.enabled),version:Number(row.version),createdBy:row.created_by,updatedBy:row.updated_by,
    createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),
  };
}
export function validateQuickReplyInput(input: QuickReplyInput): QuickReplyInput {
  const name = input.name.trim().replace(/\s+/g,' ');
  const body = input.body.trim();
  const category = (input.category ?? 'General').trim().replace(/\s+/g,' ') || 'General';
  if (name.length < 2 || name.length > 80) throw new Error('Quick-reply names must be 2–80 characters.');
  if (!body || body.length > 1800) throw new Error('Quick-reply text must contain 1–1,800 characters.');
  if (category.length > 80) throw new Error('Quick-reply categories must be 80 characters or fewer.');
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim().replace(/\s+/g,' ').slice(0,32)).filter(Boolean))];
  if (tags.length > 12) throw new Error('A quick reply can have at most 12 tags.');
  const roleIds = [...new Set(input.allowedRoleIds ?? [])];
  if (roleIds.some((id) => !/^\d{17,20}$/.test(id)) || roleIds.length > 20) throw new Error('Allowed role IDs must be valid Discord role IDs; at most 20 roles are supported.');
  for (const match of body.matchAll(BRACED_TEXT_PATTERN)) {
    const token = match[1].trim().toLocaleLowerCase('en-US');
    if (!PLACEHOLDERS.has(token)) {
      throw new Error('Unsupported placeholder {' + match[1] + '}. Supported placeholders: ' + [...PLACEHOLDERS].map((item) => '{' + item + '}').join(', ') + '.');
    }
  }
  const textWithoutPlaceholders = body.replace(BRACED_TEXT_PATTERN, '');
  if (/[{}]/.test(textWithoutPlaceholders)) {
    throw new Error('Quick-reply placeholder braces must be complete and non-nested. Use only the supported placeholders.');
  }
  return {name,body,category,tags,allowedRoleIds:roleIds,...(input.enabled === undefined ? {} : {enabled:input.enabled})};
}
function canUse(reply: QuickReply, access: QuickReplyAccess): boolean {
  return access.isAdmin || (reply.enabled && (reply.allowedRoleIds.length===0 || reply.allowedRoleIds.some((role)=>access.roleIds.includes(role))));
}

export async function listQuickReplies(guildId: string, access: QuickReplyAccess, category?: string): Promise<QuickReply[]> {
  const result = await getPostgresPool().query<QuickReplyRow>(
    'SELECT '+COLUMNS+' FROM quick_replies WHERE guild_id=$1 AND deleted_at IS NULL AND ($2::boolean OR enabled=TRUE) AND ($3::text IS NULL OR LOWER(category)=LOWER($3)) ORDER BY category,name LIMIT 100',
    [guildId,access.isAdmin,category?.trim()||null],
  );
  return result.rows.map(fromRow).filter((reply)=>canUse(reply,access));
}

export async function getQuickReply(guildId: string, idOrName: string, access: QuickReplyAccess): Promise<QuickReply|null> {
  const value=idOrName.trim();
  const result=await getPostgresPool().query<QuickReplyRow>(
    'SELECT '+COLUMNS+' FROM quick_replies WHERE guild_id=$1 AND deleted_at IS NULL AND (id=$2 OR normalized_name=$3) LIMIT 1',
    [guildId,value,normalizeName(value)],
  );
  const row=result.rows[0];
  if(!row) return null;
  const reply=fromRow(row);
  return canUse(reply,access)?reply:null;
}

export async function saveQuickReply(
  guildId: string,
  actorId: string,
  input: QuickReplyInput,
  expectedVersion?: number,
): Promise<QuickReply> {
  const valid = validateQuickReplyInput(input);
  if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    throw new Error('Expected version must be a positive integer when updating a quick reply.');
  }
  const normalizedName = normalizeName(valid.name!);
  const pool = getPostgresPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const currentResult = await client.query<QuickReplyRow>(
      'SELECT ' + COLUMNS + ' FROM quick_replies WHERE guild_id=$1 AND normalized_name=$2 AND deleted_at IS NULL FOR UPDATE',
      [guildId, normalizedName],
    );
    const current = currentResult.rows[0];

    if (current) {
      if (expectedVersion === undefined) {
        throw new Error(
          'A quick reply with this name already exists at version ' + current.version +
          '. Pass the current expected-version from /supportforge quick-reply list to update it.',
        );
      }
      if (Number(current.version) !== expectedVersion) {
        throw new Error('This quick reply changed since you opened it. Refresh the list and retry with the current version.');
      }

      const updated = await client.query<QuickReplyRow>(
        'UPDATE quick_replies SET name=$4,body=$5,category=$6,tags=$7,allowed_role_ids=$8,' +
          'enabled=CASE WHEN $9::boolean IS NULL THEN enabled ELSE $9 END,' +
          'version=version+1,updated_by=$10,updated_at=NOW() ' +
          'WHERE guild_id=$1 AND id=$2 AND version=$3 RETURNING ' + COLUMNS,
        [
          guildId, current.id, expectedVersion, valid.name, valid.body, valid.category,
          valid.tags, valid.allowedRoleIds, valid.enabled ?? null, actorId,
        ],
      );
      if (!updated.rows[0]) {
        throw new Error('This quick reply changed during the save. Refresh the list and retry.');
      }
      const saved = fromRow(updated.rows[0]);
      await insertQuickReplyRevision(client, saved, actorId, 'updated');
      await client.query('COMMIT');
      return saved;
    }

    if (expectedVersion !== undefined) {
      throw new Error('No quick reply with this name exists at that version. Omit expected-version to create a new reply.');
    }

    const inserted = await client.query<QuickReplyRow>(
      'INSERT INTO quick_replies (id,guild_id,name,normalized_name,body,category,tags,allowed_role_ids,enabled,version,created_by,updated_by) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$10) RETURNING ' + COLUMNS,
      [
        randomUUID(), guildId, valid.name, normalizedName, valid.body, valid.category,
        valid.tags, valid.allowedRoleIds, valid.enabled ?? true, actorId,
      ],
    );
    const saved = fromRow(inserted.rows[0]);
    await insertQuickReplyRevision(client, saved, actorId, 'created');
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505') {
      throw new Error('Another administrator created a quick reply with this name concurrently. Refresh the list before retrying.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteQuickReply(
  guildId: string,
  idOrName: string,
  expectedVersion: number,
  actorId: string,
): Promise<boolean> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('Expected version must be a positive integer to delete a quick reply.');
  }
  const value = idOrName.trim();
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<QuickReplyRow>(
      'SELECT ' + COLUMNS + ' FROM quick_replies WHERE guild_id=$1 AND deleted_at IS NULL ' +
        'AND (id=$2 OR normalized_name=$3) FOR UPDATE',
      [guildId, value, normalizeName(value)],
    );
    const row = found.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return false;
    }
    if (Number(row.version) !== expectedVersion) {
      throw new Error('This quick reply changed since it was opened. Refresh the list and confirm deletion using its current version.');
    }
    const updated = await client.query<QuickReplyRow>(
      'UPDATE quick_replies SET enabled=FALSE,deleted_at=NOW(),version=version+1,updated_by=$4,updated_at=NOW() ' +
        'WHERE guild_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL RETURNING ' + COLUMNS,
      [guildId, row.id, expectedVersion, actorId],
    );
    if (!updated.rows[0]) throw new Error('This quick reply changed during deletion. Refresh and retry.');
    await insertQuickReplyRevision(client, fromRow(updated.rows[0]), actorId, 'deleted');
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listQuickReplyRevisions(
  guildId: string,
  idOrName: string,
): Promise<QuickReplyRevision[]> {
  const value = idOrName.trim();
  const found = await getPostgresPool().query<QueryResultRow & { id: string }>(
    'SELECT id FROM quick_replies WHERE guild_id=$1 AND (id=$2 OR normalized_name=$3) ' +
      'ORDER BY (id=$2) DESC,(deleted_at IS NULL) DESC,updated_at DESC LIMIT 1',
    [guildId, value, normalizeName(value)],
  );
  const replyId = found.rows[0]?.id;
  if (!replyId) throw new Error('Quick reply was not found in this server.');
  const result = await getPostgresPool().query<QueryResultRow & {
    version: number; name: string; operation: QuickReplyRevision['operation'];
    enabled: boolean; changed_by: string; created_at: Date | string;
  }>(
    'SELECT version,name,operation,enabled,changed_by,created_at FROM quick_reply_revisions ' +
      'WHERE guild_id=$1 AND quick_reply_id=$2 ORDER BY version DESC LIMIT 50',
    [guildId, replyId],
  );
  return result.rows.map((row) => ({
    version: Number(row.version),
    name: row.name,
    operation: row.operation,
    enabled: Boolean(row.enabled),
    changedBy: row.changed_by,
    createdAt: iso(row.created_at),
  }));
}

/** Restore the contents of a retained revision as a new current version. History is never rewritten. */
export async function restoreQuickReplyRevision(
  guildId: string,
  actorId: string,
  idOrName: string,
  revisionNumber: number,
  expectedVersion: number,
): Promise<QuickReply> {
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1 ||
      !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('Revision and expected current version must be positive integers.');
  }
  const value = idOrName.trim();
  if (!value) throw new Error('A quick reply name or ID is required.');
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query<QuickReplyRow & {
      normalized_name: string;
      deleted_at: Date | string | null;
    }>(
      'SELECT ' + COLUMNS + ',normalized_name,deleted_at FROM quick_replies ' +
        'WHERE guild_id=$1 AND (id=$2 OR normalized_name=$3) ' +
        'ORDER BY (id=$2) DESC,(deleted_at IS NULL) DESC,updated_at DESC LIMIT 1 FOR UPDATE',
      [guildId, value, normalizeName(value)],
    );
    const current = currentResult.rows[0];
    if (!current) throw new Error('Quick reply was not found in this server.');
    if (Number(current.version) !== expectedVersion) {
      throw new Error('This quick reply changed since it was opened. Refresh its current version before restoring history.');
    }

    const revisionResult = await client.query<QueryResultRow & {
      name: string;
      body: string;
      category: string;
      tags: string[];
      allowed_role_ids: string[];
      enabled: boolean;
    }>(
      'SELECT name,body,category,tags,allowed_role_ids,enabled FROM quick_reply_revisions ' +
        'WHERE guild_id=$1 AND quick_reply_id=$2 AND version=$3 LIMIT 1',
      [guildId, current.id, revisionNumber],
    );
    const revision = revisionResult.rows[0];
    if (!revision) throw new Error('That quick reply revision does not exist in this server.');

    const restored = validateQuickReplyInput({
      name: revision.name,
      body: revision.body,
      category: revision.category,
      tags: revision.tags ?? [],
      allowedRoleIds: revision.allowed_role_ids ?? [],
      enabled: Boolean(revision.enabled),
    });
    const updated = await client.query<QuickReplyRow>(
      'UPDATE quick_replies SET name=$4,normalized_name=$5,body=$6,category=$7,tags=$8,allowed_role_ids=$9,' +
        'enabled=$10,deleted_at=NULL,version=version+1,updated_by=$11,updated_at=NOW() ' +
        'WHERE guild_id=$1 AND id=$2 AND version=$3 RETURNING ' + COLUMNS,
      [
        guildId, current.id, expectedVersion, restored.name, normalizeName(restored.name), restored.body,
        restored.category, restored.tags, restored.allowedRoleIds, restored.enabled ?? false, actorId,
      ],
    );
    if (!updated.rows[0]) throw new Error('This quick reply changed during history restoration. Refresh and retry.');
    const saved = fromRow(updated.rows[0]);
    await insertQuickReplyRevision(client, saved, actorId, 'restored');
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505') {
      throw new Error('A different active quick reply already uses that name. Resolve the name conflict before restoring.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export function renderQuickReply(reply: QuickReply, context: QuickReplyContext): string {
  const values: Record<string,string> = {
    user:context.user,
    username:context.username,
    ticket_id:context.ticketId??'',
    ticket_number:context.ticketNumber??'',
    department:context.department??'',
    priority:context.priority??'',
    staff:context.staff??'',
  };
  return reply.body.replace(TOKEN_PATTERN,(_match,token:string)=>values[token.toLocaleLowerCase('en-US')]??'').slice(0,1800);
} 

export async function sendQuickReplyInTicket(args: {
  guild: Guild;
  channel: TextChannel | ThreadChannel;
  quickReplyId: string;
  actorId: string;
  actorName: string;
  actorUsername: string;
  isAdmin: boolean;
  roleIds: string[];
}): Promise<QuickReply> {
  if (!args.guild || args.channel.guild.id !== args.guild.id) {
    throw new Error('Quick replies can only be sent inside a ticket in the same server.');
  }
  const ticket = await getPersistedTicket(args.channel.id);
  if (!ticket || ticket.guildId !== args.guild.id || ticket.channelId !== args.channel.id ||
      ticket.deletedAt || !['open', 'claimed', 'pending', 'reopened'].includes(ticket.status)) {
    throw new Error('Quick replies are available only in an active managed ticket.');
  }

  const config = await getGuildConfig(args.guild.id);
  const department = ticket.departmentId ? config.departments[ticket.departmentId] : undefined;
  const isTicketStaff = Boolean(department?.staffRoleId && args.roleIds.includes(department.staffRoleId));
  if (!args.isAdmin && !isTicketStaff) {
    throw new Error('Only the staff role configured for this ticket department or a server administrator can send quick replies.');
  }

  const access: QuickReplyAccess = { isAdmin: args.isAdmin, roleIds: args.roleIds };
  const reply = await getQuickReply(args.guild.id, args.quickReplyId, access);
  if (!reply || !reply.enabled) {
    throw new Error('That quick reply is no longer enabled or available to your role. Refresh the list and retry.');
  }

  const owner = ticket.ownerId
    ? await args.guild.members.fetch(ticket.ownerId).catch(() => null)
    : null;
  const staff = await args.guild.members.fetch(args.actorId).catch(() => null);
  const rendered = renderQuickReply(reply, {
    user: owner?.displayName ?? 'customer',
    username: owner?.user.username ?? 'customer',
    ticketId: ticket.id,
    ticketNumber: ticket.ticketNumber ?? ticket.id.slice(0, 8),
    department: department?.name ?? ticket.departmentId ?? 'Support',
    priority: ticket.priority ?? 'normal',
    staff: staff?.displayName ?? args.actorUsername,
  });

  await args.channel.send({ content: rendered, allowedMentions: { parse: [] } });
  if (config.supportCategoryId) {
    try {
      await logTicketEvent(args.guild, config.supportCategoryId, {
        ticketNumber: ticket.ticketNumber ?? ticket.id,
        ticketChannelId: ticket.channelId,
        event: 'QUICK_REPLY_SENT',
        actorId: args.actorId,
        actor: args.actorName,
        actorName: args.actorName,
        detail: 'Sent quick reply ' + reply.id + ' version ' + reply.version + '.',
      });
    } catch {
      console.warn('Quick reply was sent, but its ticket audit notification failed.');
    }
  }
  return reply;
}
