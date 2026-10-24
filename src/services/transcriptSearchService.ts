import type { QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { getPersistedTicketById } from './ticketPersistenceService';

export interface ArchivedMessageMatch {
  messageId: string;
  ticketId: string;
  originalChannelId: string;
  authorId: string;
  authorDisplayName: string;
  contentSnippet: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  isBot: boolean;
}

interface ArchivedSearchRow extends QueryResultRow {
  message_id: string;
  ticket_id: string;
  original_channel_id: string;
  author_id: string;
  author_display_name: string;
  content: string;
  created_at: Date | string;
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  is_bot: boolean;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function buildSnippet(content: string, query: string): string {
  const normalizedContent = content.toLocaleLowerCase('en');
  const normalizedQuery = query.toLocaleLowerCase('en');
  const index = normalizedContent.indexOf(normalizedQuery);
  const start = Math.max(0, index - 120);
  const end = Math.min(content.length, Math.max(index, 0) + query.length + 220);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return (prefix + content.slice(start, end).replace(/\s+/g, ' ').trim() + suffix)
    .replace(/@/g, '@\u200b')
    .slice(0, 380);
}

/**
 * Search only one durable ticket's archived text. Authorization is enforced
 * by the Discord command handler before invoking this service; this layer
 * independently validates tenant and ticket identity to prevent cross-guild reads.
 */
export async function searchArchivedTicketMessages(args: {
  guildId: string;
  ticketId: string;
  query: string;
  limit?: number;
}): Promise<ArchivedMessageMatch[]> {
  const query = args.query.trim();
  if (query.length < 2 || query.length > 120) {
    throw new Error('Archive search text must contain 2–120 characters.');
  }

  const ticket = await getPersistedTicketById(args.ticketId);
  if (!ticket || ticket.guildId !== args.guildId) {
    throw new Error('Ticket was not found in this server.');
  }

  const limit = Math.max(1, Math.min(10, Math.floor(args.limit ?? 5)));
  const result = await getPostgresPool().query<ArchivedSearchRow>(
    'SELECT message_id,ticket_id,original_channel_id,author_id,author_display_name,content,created_at,edited_at,deleted_at,is_bot ' +
      'FROM ticket_message_archive WHERE guild_id=$1 AND ticket_id=$2 ' +
      'AND position(lower($3) in lower(content)) > 0 ' +
      'ORDER BY created_at DESC,message_id DESC LIMIT $4',
    [args.guildId, ticket.id, query, limit],
  );

  return result.rows.map((row) => ({
    messageId: row.message_id,
    ticketId: row.ticket_id,
    originalChannelId: row.original_channel_id,
    authorId: row.author_id,
    authorDisplayName: row.author_display_name || 'Unknown author',
    contentSnippet: buildSnippet(row.content ?? '', query),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    editedAt: toIso(row.edited_at),
    deletedAt: toIso(row.deleted_at),
    isBot: Boolean(row.is_bot),
  }));
}
