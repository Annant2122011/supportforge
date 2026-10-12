import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closePostgresDatabase,
  getPostgresPool,
} from '../src/core/persistence/postgresDatabase';
import { migratePostgres } from '../src/core/persistence/migrationRunner';
import { PostgresEventRepository } from '../src/repositories/postgresEventRepository';
import { PostgresTicketRepository } from '../src/repositories/postgresTicketRepository';
import type { TicketRepositoryRecord } from '../src/repositories/ticketRepository';

const hasPostgres =
  process.env.SUPPORTFORGE_POSTGRES_TEST === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DATABASE_URL_UNPOOLED);

const isLocalPostgres =
  /@(localhost|127\.0\.0\.1)(:\d+)?\//i.test(
    process.env.DATABASE_URL ?? '',
  );

const postgresIntegrationEnabled = hasPostgres && isLocalPostgres;

if (hasPostgres && !isLocalPostgres) {
  throw new Error(
    'Refusing destructive PostgreSQL integration tests against a non-local database. ' +
      'Use a local PostgreSQL instance for SUPPORTFORGE_POSTGRES_TEST=1.',
  );
}

test(
  'PostgreSQL persistence lifecycle is transactional and durable',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();

    const pool = getPostgresPool();
    await pool.query('TRUNCATE TABLE tickets CASCADE');

    const tickets = new PostgresTicketRepository(pool);
    const record: TicketRepositoryRecord = {
      id: 'postgres-test-ticket',
      guildId: 'postgres-test-guild',
      channelId: 'postgres-test-channel',
      ticketNumber: '42',
      status: 'open',
      departmentId: 'billing',
      tagId: 'refund',
      ownerId: 'postgres-test-user',
      priority: 'normal',
      claimedByIds: [],
      participantIds: ['postgres-test-user'],
      metadata: {},
      createdAt: '2026-10-07T12:00:00.000Z',
      updatedAt: '2026-10-07T12:00:00.000Z',
      deletedAt: null,
      deletionReason: null,
    };

    await tickets.create(record, {
      id: 'postgres-test-user',
      attribution: 'actorKnown',
      confidence: 'high',
    });

    const events = new PostgresEventRepository(pool);
    let ticketEvents = await events.listTicketEvents(record.id);
    assert.equal(ticketEvents.length, 1);
    assert.equal(ticketEvents[0]?.type, 'ticket.created');

    let pending = await events.listPendingOutbox();
    assert.equal(pending.length, 1);

    await tickets.transitionStatus(
      record.channelId,
      'claimed',
      '2026-10-07T12:01:00.000Z',
      {
        id: 'postgres-test-moderator',
        attribution: 'actorKnown',
        confidence: 'high',
      },
    );

    await tickets.updateMetadata(
      record.channelId,
      { priority: 'critical' },
      '2026-10-07T12:02:00.000Z',
      {
        id: 'postgres-test-moderator',
        attribution: 'actorKnown',
        confidence: 'high',
      },
    );

    assert.equal(
      (await tickets.getByChannelId(record.channelId))?.priority,
      'critical',
    );

    ticketEvents = await events.listTicketEvents(record.id);
    assert.equal(ticketEvents.length, 3);
    assert.deepEqual(ticketEvents.map((event) => event.type), [
      'ticket.created',
      'ticket.status_changed',
      'ticket.metadata_changed',
    ]);

    pending = await events.listPendingOutbox();
    assert.equal(pending.length, 3);

    const claimed = await events.claimPendingOutbox();
    assert.equal(claimed.length, 3);

    const claimedAgain = await events.claimPendingOutbox();
    assert.equal(claimedAgain.length, 0);

    await tickets.remove(record.channelId);

    assert.equal(await tickets.getByChannelId(record.channelId), undefined);
    assert.equal((await events.listTicketEvents(record.id)).length, 0);
    assert.equal((await events.listOutbox()).length, 0);
  },
);

test.after(async () => {
  if (!postgresIntegrationEnabled) return;

  try {
    await getPostgresPool().query('TRUNCATE TABLE tickets CASCADE');
  } finally {
    await closePostgresDatabase();
  }
});
