import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { getPersistedTicket, getPersistedTicketById, type PersistedTicket } from './ticketPersistenceService';

export interface RelatedTicketSummary {
  id: string;
  channelId: string;
  ticketNumber: string | null;
  status: string;
  departmentId: string | null;
  ownerId: string | null;
  deleted: boolean;
}

export interface RelatedTicketLink {
  id: string;
  guildId: string;
  ticketA: RelatedTicketSummary;
  ticketB: RelatedTicketSummary;
  note: string;
  createdBy: string;
  createdAt: string;
}

interface RelatedTicketRow extends QueryResultRow {
  id: string;
  guild_id: string;
  ticket_a_id: string;
  ticket_b_id: string;
  note: string;
  created_by: string;
  created_at: Date | string;
  a_channel_id: string;
  a_ticket_number: string | null;
  a_status: string;
  a_department_id: string | null;
  a_owner_id: string | null;
  a_deleted_at: Date | string | null;
  b_channel_id: string;
  b_ticket_number: string | null;
  b_status: string;
  b_department_id: string | null;
  b_owner_id: string | null;
  b_deleted_at: Date | string | null;
}

const RELATED_LINK_SELECT =
  'SELECT l.id,l.guild_id,l.ticket_a_id,l.ticket_b_id,l.note,l.created_by,l.created_at,' +
  'a.channel_id AS a_channel_id,a.ticket_number AS a_ticket_number,a.status AS a_status,' +
  'a.department_id AS a_department_id,a.owner_id AS a_owner_id,a.deleted_at AS a_deleted_at,' +
  'b.channel_id AS b_channel_id,b.ticket_number AS b_ticket_number,b.status AS b_status,' +
  'b.department_id AS b_department_id,b.owner_id AS b_owner_id,b.deleted_at AS b_deleted_at ' +
  'FROM related_ticket_links l ' +
  'JOIN tickets a ON a.id=l.ticket_a_id AND a.guild_id=l.guild_id ' +
  'JOIN tickets b ON b.id=l.ticket_b_id AND b.guild_id=l.guild_id ';

function toIso(value: Date | string): string {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

function toSummary(row: RelatedTicketRow, side: 'a' | 'b'): RelatedTicketSummary {
  return side === 'a'
    ? {
        id: row.ticket_a_id,
        channelId: row.a_channel_id,
        ticketNumber: row.a_ticket_number,
        status: row.a_status,
        departmentId: row.a_department_id,
        ownerId: row.a_owner_id,
        deleted: row.a_deleted_at !== null,
      }
    : {
        id: row.ticket_b_id,
        channelId: row.b_channel_id,
        ticketNumber: row.b_ticket_number,
        status: row.b_status,
        departmentId: row.b_department_id,
        ownerId: row.b_owner_id,
        deleted: row.b_deleted_at !== null,
      };
}

function toLink(row: RelatedTicketRow): RelatedTicketLink {
  return {
    id: row.id,
    guildId: row.guild_id,
    ticketA: toSummary(row, 'a'),
    ticketB: toSummary(row, 'b'),
    note: row.note,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
  };
}

export async function resolveRelatedTicketReference(
  guildId: string,
  reference: string,
): Promise<PersistedTicket> {
  const normalized = reference.trim();
  if (!normalized || normalized.length > 100) {
    throw new Error('Provide a valid ticket ID or channel ID.');
  }
  let ticket = await getPersistedTicketById(normalized);
  if (!ticket) ticket = await getPersistedTicket(normalized);
  if (!ticket || ticket.guildId !== guildId) {
    throw new Error('Ticket was not found in this server.');
  }
  return ticket;
}

async function readLinkById(guildId: string, linkId: string): Promise<RelatedTicketLink | null> {
  const result = await getPostgresPool().query<RelatedTicketRow>(
    RELATED_LINK_SELECT + 'WHERE l.guild_id=$1 AND l.id=$2 AND l.status=\'active\' LIMIT 1',
    [guildId, linkId],
  );
  return result.rows[0] ? toLink(result.rows[0]) : null;
}

export async function linkRelatedTickets(args: {
  guildId: string;
  ticketAId: string;
  ticketBId: string;
  actorId: string;
  note?: string;
}): Promise<{ link: RelatedTicketLink; created: boolean }> {
  const [ticketA, ticketB] = await Promise.all([
    getPersistedTicketById(args.ticketAId),
    getPersistedTicketById(args.ticketBId),
  ]);
  if (!ticketA || !ticketB || ticketA.guildId !== args.guildId || ticketB.guildId !== args.guildId) {
    throw new Error('Both tickets must exist in this server.');
  }
  if (ticketA.id === ticketB.id) throw new Error('A ticket cannot be linked to itself.');
  if (ticketA.deletedAt || ticketB.deletedAt) throw new Error('Deleted tickets cannot be added to a new related-ticket link.');

  const note = args.note?.trim() ?? '';
  if (note.length > 300) throw new Error('The related-ticket note must be 300 characters or fewer.');
  const [ticket_a_id, ticket_b_id] = ticketA.id < ticketB.id
    ? [ticketA.id, ticketB.id]
    : [ticketB.id, ticketA.id];

  const inserted = await getPostgresPool().query<QueryResultRow & { id: string }>(
    'INSERT INTO related_ticket_links (id,guild_id,ticket_a_id,ticket_b_id,note,status,created_by,created_at) ' +
      'VALUES ($1,$2,$3,$4,$5,\'active\',$6,NOW()) ON CONFLICT DO NOTHING RETURNING id',
    [randomUUID(), args.guildId, ticket_a_id, ticket_b_id, note, args.actorId],
  );
  let linkId = inserted.rows[0]?.id;
  const created = Boolean(linkId);
  if (!linkId) {
    const existing = await getPostgresPool().query<QueryResultRow & { id: string }>(
      'SELECT id FROM related_ticket_links WHERE guild_id=$1 AND ticket_a_id=$2 AND ticket_b_id=$3 AND status=\'active\' LIMIT 1',
      [args.guildId, ticket_a_id, ticket_b_id],
    );
    linkId = existing.rows[0]?.id;
  }
  if (!linkId) throw new Error('Could not safely create or locate the related-ticket link. No duplicate link was added.');
  const link = await readLinkById(args.guildId, linkId);
  if (!link) throw new Error('The related-ticket link was not readable after saving.');
  return { link, created };
}

export async function listRelatedTicketLinks(
  guildId: string,
  ticketId: string,
): Promise<RelatedTicketLink[]> {
  const ticket = await getPersistedTicketById(ticketId);
  if (!ticket || ticket.guildId !== guildId) throw new Error('Ticket was not found in this server.');
  const result = await getPostgresPool().query<RelatedTicketRow>(
    RELATED_LINK_SELECT +
      'WHERE l.guild_id=$1 AND l.status=\'active\' AND (l.ticket_a_id=$2 OR l.ticket_b_id=$2) ' +
      'ORDER BY l.created_at DESC,l.id DESC LIMIT 50',
    [guildId, ticketId],
  );
  return result.rows.map(toLink);
}

export async function getRelatedTicketLink(
  guildId: string,
  linkId: string,
): Promise<RelatedTicketLink | null> {
  return readLinkById(guildId, linkId.trim());
}

export async function unlinkRelatedTicket(
  guildId: string,
  linkId: string,
  actorId: string,
): Promise<boolean> {
  const result = await getPostgresPool().query(
    'UPDATE related_ticket_links SET status=\'removed\',removed_by=$3,removed_at=NOW() ' +
      'WHERE guild_id=$1 AND id=$2 AND status=\'active\' RETURNING id',
    [guildId, linkId.trim(), actorId],
  );
  return (result.rowCount ?? 0) > 0;
}
