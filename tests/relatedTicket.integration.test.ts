import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { closePostgresDatabase, getPostgresPool } from '../src/core/persistence/postgresDatabase';
import { migratePostgres } from '../src/core/persistence/migrationRunner';
import { getPersistedTicket, registerTicket } from '../src/services/ticketPersistenceService';
import {
  getRelatedTicketLink,
  linkRelatedTickets,
  listRelatedTicketLinks,
  unlinkRelatedTicket,
} from '../src/services/relatedTicketService';

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
  throw new Error('Refusing related-ticket tests against a non-local database.');
}

test(
  'related-ticket links are guild-scoped, idempotent, removable and auditable',
  { skip: !enabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    const guildId = 'related-test-' + randomUUID();
    const otherGuildId = 'related-test-' + randomUUID();
    const channelA = 'related-channel-a-' + randomUUID();
    const channelB = 'related-channel-b-' + randomUUID();
    const channelOtherGuild = 'related-channel-other-' + randomUUID();
    const actor = { id: '223456789012345678', attribution: 'actorKnown' as const, confidence: 'high' as const };
    const now = new Date().toISOString();

    try {
      await registerTicket(channelA, {
        guildId,
        ticketNumber: '7101',
        departmentId: 'billing',
        tagId: 'refunds',
        ownerId: '323456789012345678',
        priority: 'normal',
        createdAt: now,
      }, actor);
      await registerTicket(channelB, {
        guildId,
        ticketNumber: '7102',
        departmentId: 'technical',
        tagId: 'login',
        ownerId: '423456789012345678',
        priority: 'high',
        createdAt: now,
      }, actor);
      await registerTicket(channelOtherGuild, {
        guildId: otherGuildId,
        ticketNumber: '8101',
        departmentId: 'billing',
        tagId: 'refunds',
        ownerId: '523456789012345678',
        priority: 'normal',
        createdAt: now,
      }, actor);

      const ticketA = await getPersistedTicket(channelA);
      const ticketB = await getPersistedTicket(channelB);
      const otherTicket = await getPersistedTicket(channelOtherGuild);
      assert.ok(ticketA && ticketB && otherTicket);

      const first = await linkRelatedTickets({
        guildId,
        ticketAId: ticketA.id,
        ticketBId: ticketB.id,
        actorId: actor.id,
        note: 'Same order, follow up on refund after the sign-in issue is resolved.',
      });
      assert.equal(first.created, true);
      assert.notEqual(first.link.ticketA.id, first.link.ticketB.id);
      assert.equal(first.link.note.includes('Same order'), true);

      const reverseOrder = await linkRelatedTickets({
        guildId,
        ticketAId: ticketB.id,
        ticketBId: ticketA.id,
        actorId: actor.id,
      });
      assert.equal(reverseOrder.created, false);
      assert.equal(reverseOrder.link.id, first.link.id);
      assert.equal((await listRelatedTicketLinks(guildId, ticketA.id)).length, 1);
      assert.equal((await listRelatedTicketLinks(guildId, ticketB.id)).length, 1);
      assert.equal((await listRelatedTicketLinks(otherGuildId, otherTicket.id)).length, 0);

      await assert.rejects(
        () => linkRelatedTickets({ guildId, ticketAId: ticketA.id, ticketBId: ticketA.id, actorId: actor.id }),
        /cannot be linked to itself/,
      );
      await assert.rejects(
        () => linkRelatedTickets({ guildId, ticketAId: ticketA.id, ticketBId: otherTicket.id, actorId: actor.id }),
        /Both tickets must exist in this server/,
      );

      assert.ok(await getRelatedTicketLink(guildId, first.link.id));
      assert.equal(await unlinkRelatedTicket(guildId, first.link.id, actor.id), true);
      assert.equal(await getRelatedTicketLink(guildId, first.link.id), null);
      assert.equal((await listRelatedTicketLinks(guildId, ticketA.id)).length, 0);
      const removed = await pool.query<{ status: string; removed_by: string; removed_at: Date | string }>(
        'SELECT status,removed_by,removed_at FROM related_ticket_links WHERE id=$1 AND guild_id=$2',
        [first.link.id, guildId],
      );
      assert.equal(removed.rows[0]?.status, 'removed');
      assert.equal(removed.rows[0]?.removed_by, actor.id);
      assert.ok(removed.rows[0]?.removed_at);
    } finally {
      await pool.query('DELETE FROM tickets WHERE guild_id=ANY($1::text[])', [[guildId, otherGuildId]]).catch(() => undefined);
      await closePostgresDatabase();
    }
  },
);
