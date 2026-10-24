import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { closePostgresDatabase, getPostgresPool } from '../src/core/persistence/postgresDatabase';
import { migratePostgres } from '../src/core/persistence/migrationRunner';
import { getPersistedTicket, registerTicket } from '../src/services/ticketPersistenceService';
import { searchArchivedTicketMessages } from '../src/services/transcriptSearchService';

const hasPostgres =
  process.env.SUPPORTFORGE_POSTGRES_TEST === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DATABASE_URL_UNPOOLED);
const isLocalPostgres = [
  process.env.DATABASE_URL,
  process.env.DATABASE_URL_UNPOOLED,
].every((value) => {
  try {
    const hostname = new URL(value ?? '').hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
});
const enabled = hasPostgres && isLocalPostgres;
if (hasPostgres && !isLocalPostgres) {
  throw new Error('Refusing archived transcript search tests against a non-local database.');
}

test(
  'archived transcript search is ticket-scoped, bounded and rejects cross-guild references',
  { skip: !enabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    const guildId = 'transcript-search-' + randomUUID();
    const otherGuildId = 'transcript-search-' + randomUUID();
    const channelId = 'transcript-channel-' + randomUUID();
    const otherChannelId = 'transcript-channel-' + randomUUID();
    const actor = { id: '223456789012345678', attribution: 'actorKnown' as const, confidence: 'high' as const };
    const now = new Date().toISOString();

    try {
      await registerTicket(channelId, {
        guildId,
        ticketNumber: '9101',
        departmentId: 'billing',
        tagId: 'refund',
        ownerId: '323456789012345678',
        priority: 'normal',
        createdAt: now,
      }, actor);
      await registerTicket(otherChannelId, {
        guildId: otherGuildId,
        ticketNumber: '9201',
        departmentId: 'billing',
        tagId: 'refund',
        ownerId: '423456789012345678',
        priority: 'normal',
        createdAt: now,
      }, actor);

      const ticket = await getPersistedTicket(channelId);
      const otherTicket = await getPersistedTicket(otherChannelId);
      assert.ok(ticket && otherTicket);

      const firstId = randomUUID();
      const secondId = randomUUID();
      await pool.query(
        'INSERT INTO ticket_message_archive ' +
          '(message_id,ticket_id,guild_id,original_channel_id,author_id,author_username,author_display_name,content,created_at,is_bot) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE),($10,$2,$3,$4,$11,$12,$13,$14,$15,FALSE)',
        [
          firstId,ticket.id,guildId,channelId,'523456789012345678','customer','Customer One',
          'The refund page shows an authorization error after submitting my order.',new Date(Date.now()-1000).toISOString(),
          secondId,'623456789012345678','staff','Support Agent',
          'We are checking the authorization flow and payment reference.',new Date().toISOString(),
        ],
      );
      await pool.query(
        'INSERT INTO ticket_message_archive ' +
          '(message_id,ticket_id,guild_id,original_channel_id,author_id,author_username,author_display_name,content,created_at,is_bot) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE)',
        [randomUUID(),otherTicket.id,otherGuildId,otherChannelId,'723456789012345678','other','Other Guild Member','authorization success',now],
      );

      const result = await searchArchivedTicketMessages({
        guildId,
        ticketId: ticket.id,
        query: 'authorization',
        limit: 5,
      });
      assert.equal(result.length, 2);
      assert.ok(result.every((item) => item.ticketId === ticket.id));
      assert.ok(result.some((item) => item.contentSnippet.toLowerCase().includes('authorization')));
      assert.ok(result.every((item) => item.contentSnippet.length <= 380));

      await assert.rejects(
        () => searchArchivedTicketMessages({ guildId, ticketId: otherTicket.id, query: 'authorization' }),
        /Ticket was not found in this server/,
      );
      await assert.rejects(
        () => searchArchivedTicketMessages({ guildId, ticketId: ticket.id, query: 'x' }),
        /2–120 characters/,
      );
      const bounded = await searchArchivedTicketMessages({
        guildId,
        ticketId: ticket.id,
        query: 'authorization',
        limit: 100,
      });
      assert.equal(bounded.length, 2, 'caller limits are clamped, not allowed to return unbounded rows');
    } finally {
      await pool.query('DELETE FROM tickets WHERE guild_id=ANY($1::text[])', [[guildId, otherGuildId]]).catch(() => undefined);
      await closePostgresDatabase();
    }
  },
);
