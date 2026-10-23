import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';

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
const PLACEHOLDERS = new Set(['user','username','ticket_id','ticket_number','department','priority','staff']);
const TOKEN_PATTERN = /\{([a-z][a-z0-9_]*)\}/gi;

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
function validateInput(input: QuickReplyInput): QuickReplyInput {
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
  for (const match of body.matchAll(TOKEN_PATTERN)) {
    if (!PLACEHOLDERS.has(match[1].toLocaleLowerCase('en-US'))) {
      throw new Error('Unsupported placeholder {' + match[1] + '}. Supported placeholders: ' + [...PLACEHOLDERS].map((token)=>'{'+token+'}').join(', ') + '.');
    }
  }
  return {name,body,category,tags,allowedRoleIds:roleIds,enabled:input.enabled??true};
}
function canUse(reply: QuickReply, access: QuickReplyAccess): boolean {
  return access.isAdmin || (reply.enabled && (reply.allowedRoleIds.length===0 || reply.allowedRoleIds.some((role)=>access.roleIds.includes(role))));
}

export async function listQuickReplies(guildId: string, access: QuickReplyAccess, category?: string): Promise<QuickReply[]> {
  const result = await getPostgresPool().query<QuickReplyRow>(
    'SELECT '+COLUMNS+' FROM quick_replies WHERE guild_id=$1 AND ($2::boolean OR enabled=TRUE) AND ($3::text IS NULL OR LOWER(category)=LOWER($3)) ORDER BY category,name LIMIT 100',
    [guildId,access.isAdmin,category?.trim()||null],
  );
  return result.rows.map(fromRow).filter((reply)=>canUse(reply,access));
}

export async function getQuickReply(guildId: string, idOrName: string, access: QuickReplyAccess): Promise<QuickReply|null> {
  const value=idOrName.trim();
  const result=await getPostgresPool().query<QuickReplyRow>(
    'SELECT '+COLUMNS+' FROM quick_replies WHERE guild_id=$1 AND (id=$2 OR normalized_name=$3) LIMIT 1',
    [guildId,value,normalizeName(value)],
  );
  const row=result.rows[0];
  if(!row) return null;
  const reply=fromRow(row);
  return canUse(reply,access)?reply:null;
}

export async function saveQuickReply(guildId: string, actorId: string, input: QuickReplyInput): Promise<QuickReply> {
  const valid=validateInput(input);
  const normalizedName=normalizeName(valid.name!);
  const result=await getPostgresPool().query<QuickReplyRow>(
    'INSERT INTO quick_replies (id,guild_id,name,normalized_name,body,category,tags,allowed_role_ids,enabled,version,created_by,updated_by) '+
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$10) '+
    'ON CONFLICT (guild_id,normalized_name) DO UPDATE SET name=EXCLUDED.name,body=EXCLUDED.body,category=EXCLUDED.category,tags=EXCLUDED.tags,'+
    'allowed_role_ids=EXCLUDED.allowed_role_ids,enabled=EXCLUDED.enabled,version=quick_replies.version+1,updated_by=EXCLUDED.updated_by,updated_at=NOW() '+
    'RETURNING '+COLUMNS,
    [randomUUID(),guildId,valid.name,normalizedName,valid.body,valid.category,valid.tags,valid.allowedRoleIds,valid.enabled,actorId],
  );
  return fromRow(result.rows[0]);
}

export async function deleteQuickReply(guildId: string, idOrName: string): Promise<boolean> {
  const value=idOrName.trim();
  const result=await getPostgresPool().query(
    'DELETE FROM quick_replies WHERE guild_id=$1 AND (id=$2 OR normalized_name=$3)',
    [guildId,value,normalizeName(value)],
  );
  return (result.rowCount??0)>0;
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
