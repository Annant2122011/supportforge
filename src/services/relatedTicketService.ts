import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';

export interface RelatedTicket {
  ticketId: string;
  ticketNumber: string | null;
  channelId: string;
  status: string;
  priority: string | null;
  departmentId: string | null;
  ownerId: string | null;
  linkedBy: string;
  linkedAt: string;
}

export function canonicalRelatedTicketPair(leftValue: string, rightValue: string): [string, string] {
  const left = leftValue.trim();
  const right = rightValue.trim();
  if (!left || !right) throw new Error('Both ticket IDs are required.');
  if (left === right) throw new Error('A ticket cannot be linked to itself.');
  return left < right ? [left, right] : [right, left];
}

export async function linkRelatedTickets(guildId: string,leftTicketId: string,rightTicketId: string,actorId: string): Promise<void> {
  const [left,right]=canonicalRelatedTicketPair(leftTicketId,rightTicketId);
  const client=await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const tickets=await client.query<QueryResultRow & {id:string;deleted_at:Date|string|null}>(
      'SELECT id,deleted_at FROM tickets WHERE guild_id=$1 AND id=ANY($2::text[]) FOR UPDATE',
      [guildId,[left,right]],
    );
    if(tickets.rows.length!==2) throw new Error('Both tickets must exist in this server.');
    if(tickets.rows.some((row)=>row.deleted_at!==null)) throw new Error('Deleted tickets cannot be linked.');
    await client.query(
      'INSERT INTO related_ticket_links (id,guild_id,left_ticket_id,right_ticket_id,linked_by) VALUES ($1,$2,$3,$4,$5) '+
      'ON CONFLICT (guild_id,left_ticket_id,right_ticket_id) DO NOTHING',
      [randomUUID(),guildId,left,right,actorId],
    );
    await client.query('COMMIT');
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally { client.release(); }
}

export async function unlinkRelatedTickets(guildId: string,leftTicketId: string,rightTicketId: string): Promise<boolean> {
  const [left,right]=canonicalRelatedTicketPair(leftTicketId,rightTicketId);
  const result=await getPostgresPool().query(
    'DELETE FROM related_ticket_links WHERE guild_id=$1 AND left_ticket_id=$2 AND right_ticket_id=$3',
    [guildId,left,right],
  );
  return (result.rowCount??0)>0;
}

export async function listRelatedTickets(guildId: string,ticketId: string): Promise<RelatedTicket[]> {
  const result=await getPostgresPool().query<QueryResultRow & {
    id:string;ticket_number:string|null;channel_id:string;status:string;priority:string|null;
    department_id:string|null;owner_id:string|null;linked_by:string;linked_at:Date|string;
  }>(
    'SELECT t.id,t.ticket_number,t.channel_id,t.status,t.priority,t.department_id,t.owner_id,l.linked_by,l.created_at AS linked_at '+
    'FROM related_ticket_links l JOIN tickets t ON t.guild_id=l.guild_id AND '+
    '(t.id=CASE WHEN l.left_ticket_id=$3 THEN l.right_ticket_id ELSE l.left_ticket_id END) '+
    'WHERE l.guild_id=$1 AND (l.left_ticket_id=$2 OR l.right_ticket_id=$2) AND t.deleted_at IS NULL ORDER BY l.created_at DESC LIMIT 25',
    [guildId,ticketId,ticketId],
  );
  return result.rows.map((row)=>({
    ticketId:row.id,ticketNumber:row.ticket_number,channelId:row.channel_id,status:row.status,
    priority:row.priority,departmentId:row.department_id,ownerId:row.owner_id,linkedBy:row.linked_by,
    linkedAt:row.linked_at instanceof Date?row.linked_at.toISOString():new Date(row.linked_at).toISOString(),
  }));
}
