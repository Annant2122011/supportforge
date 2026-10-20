import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  closePostgresDatabase,
  getPostgresPool,
} from '../src/core/persistence/postgresDatabase';
import { migratePostgres } from '../src/core/persistence/migrationRunner';
import { PostgresEventRepository } from '../src/repositories/postgresEventRepository';
import { PostgresJsonDocumentRepository, importLegacyJsonDocuments } from '../src/repositories/jsonDocumentRepository';
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
      'ticket.claimed',
      'ticket.priority.changed',
    ]);

    pending = await events.listPendingOutbox();
    assert.equal(pending.length, 3);

    const claimed = await events.claimPendingOutbox();
    assert.equal(claimed.length, 3);

    const claimedAgain = await events.claimPendingOutbox();
    assert.equal(claimedAgain.length, 0);

    await tickets.remove(record.channelId);

    const deleted = await tickets.getByChannelId(record.channelId);
    assert.ok(deleted?.deletedAt);
    assert.deepEqual(
      (await events.listTicketEvents(record.id)).map((event) => event.type),
      ['ticket.created', 'ticket.claimed', 'ticket.priority.changed', 'ticket.deleted'],
    );
    assert.equal((await events.listOutbox()).length, 4);
  },
);


test(
  'PostgreSQL ticket lifecycle and metadata commit atomically with their events and outbox',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    await pool.query('TRUNCATE TABLE tickets CASCADE');

    const tickets = new PostgresTicketRepository(pool);
    const record: TicketRepositoryRecord = {
      id: 'postgres-atomic-ticket',
      guildId: 'postgres-atomic-guild',
      channelId: 'postgres-atomic-channel',
      ticketNumber: '43',
      status: 'open',
      departmentId: 'billing',
      tagId: 'refund',
      ownerId: 'postgres-atomic-user',
      priority: 'normal',
      claimedByIds: [],
      participantIds: ['postgres-atomic-user'],
      metadata: {},
      createdAt: '2026-10-12T12:00:00.000Z',
      updatedAt: '2026-10-12T12:00:00.000Z',
      deletedAt: null,
      deletionReason: null,
    };

    await tickets.create(record);
    await tickets.transitionStatusAndMetadata(
      record.channelId,
      'claimed',
      { priority: 'critical', claimedByIds: ['postgres-atomic-moderator'] },
      '2026-10-12T12:01:00.000Z',
      {
        id: 'postgres-atomic-moderator',
        attribution: 'actorKnown',
        confidence: 'high',
      },
    );

    const saved = await tickets.getByChannelId(record.channelId);
    assert.equal(saved?.status, 'claimed');
    assert.equal(saved?.priority, 'critical');
    assert.deepEqual(saved?.claimedByIds, ['postgres-atomic-moderator']);

    const events = await new PostgresEventRepository(pool).listTicketEvents(record.id);
    assert.equal(events.filter((event) => event.type === 'ticket.claimed').length, 1);
    assert.equal(events.filter((event) => event.type === 'ticket.metadata_changed').length, 1);
    assert.equal((await new PostgresEventRepository(pool).listOutbox()).length, 3);
  },
);

test(
  'PostgreSQL inactivity close rejects stale activity and commits closure with its event/outbox',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    await pool.query('TRUNCATE TABLE tickets CASCADE');

    const tickets = new PostgresTicketRepository(pool);
    const events = new PostgresEventRepository(pool);
    const activityAt = '2026-10-19T12:00:00.000Z';
    const closedAt = '2026-10-20T12:00:00.000Z';
    const record: TicketRepositoryRecord = {
      id: 'postgres-inactivity-ticket',
      guildId: 'postgres-inactivity-guild',
      channelId: 'postgres-inactivity-channel',
      ticketNumber: '45',
      status: 'open',
      departmentId: 'billing',
      tagId: 'refund',
      ownerId: 'postgres-inactivity-user',
      priority: 'normal',
      claimedByIds: [],
      participantIds: ['postgres-inactivity-user'],
      metadata: { lastActivityAt: activityAt },
      createdAt: '2026-10-16T12:00:00.000Z',
      updatedAt: activityAt,
      deletedAt: null,
      deletionReason: null,
    };

    await tickets.create(record);
    const staleClose = await tickets.closeIfActivityUnchanged(
      record.channelId,
      '2026-10-18T12:00:00.000Z',
      { metadata: { closedAt, inactivityAutoClosedAt: closedAt } },
      closedAt,
    );
    assert.equal(staleClose, false);
    assert.equal((await tickets.getByChannelId(record.channelId))?.status, 'open');
    assert.deepEqual((await events.listTicketEvents(record.id)).map((event) => event.type), ['ticket.created']);
    assert.equal((await events.listOutbox()).length, 1);

    const closed = await tickets.closeIfActivityUnchanged(
      record.channelId,
      activityAt,
      {
        metadata: {
          closedAt,
          lastActivityAt: closedAt,
          transcriptId: 'postgres-inactivity-transcript',
          inactivityAutoClosedAt: closedAt,
          inactivityAutoCloseAnchorAt: activityAt,
        },
      },
      closedAt,
      { id: 'supportforge-system', attribution: 'actorKnown', confidence: 'high' },
    );
    assert.equal(closed, true);

    const saved = await tickets.getByChannelId(record.channelId);
    assert.equal(saved?.status, 'closed');
    assert.equal(saved?.metadata.transcriptId, 'postgres-inactivity-transcript');
    assert.equal(saved?.metadata.inactivityAutoCloseAnchorAt, activityAt);
    assert.equal(saved?.metadata.lastActivityAt, closedAt);

    const eventTypes = (await events.listTicketEvents(record.id)).map((event) => event.type);
    assert.deepEqual(eventTypes, ['ticket.created', 'ticket.closed']);
    assert.equal((await events.listOutbox()).length, 2);

    const duplicateClose = await tickets.closeIfActivityUnchanged(
      record.channelId,
      activityAt,
      { metadata: { inactivityAutoClosedAt: closedAt } },
      closedAt,
    );
    assert.equal(duplicateClose, false);
    assert.deepEqual((await events.listTicketEvents(record.id)).map((event) => event.type), eventTypes);
    assert.equal((await events.listOutbox()).length, 2);
  },
);

test(
  'PostgreSQL rolls back ticket state, event history, and outbox when outbox enqueue fails',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    await pool.query('TRUNCATE TABLE tickets CASCADE');

    const tickets = new PostgresTicketRepository(pool);
    const record: TicketRepositoryRecord = {
      id: 'postgres-rollback-ticket',
      guildId: 'postgres-rollback-guild',
      channelId: 'postgres-rollback-channel',
      ticketNumber: '44',
      status: 'open',
      departmentId: 'billing',
      tagId: 'refund',
      ownerId: 'postgres-rollback-user',
      priority: 'normal',
      claimedByIds: [],
      participantIds: ['postgres-rollback-user'],
      metadata: {},
      createdAt: '2026-10-12T12:00:00.000Z',
      updatedAt: '2026-10-12T12:00:00.000Z',
      deletedAt: null,
      deletionReason: null,
    };

    await tickets.create(record);
    await pool.query(`
      CREATE OR REPLACE FUNCTION supportforge_test_fail_claimed_outbox()
      RETURNS trigger
      LANGUAGE plpgsql
      AS 'BEGIN IF NEW.event_type = ''ticket.claimed'' THEN RAISE EXCEPTION ''simulated postgres outbox failure''; END IF; RETURN NEW; END;'
    `);
    await pool.query(`
      CREATE TRIGGER supportforge_test_fail_claimed_outbox_trigger
      BEFORE INSERT ON outbox_events
      FOR EACH ROW
      EXECUTE FUNCTION supportforge_test_fail_claimed_outbox()
    `);

    try {
      await assert.rejects(
        tickets.transitionStatusAndMetadata(
          record.channelId,
          'claimed',
          { priority: 'critical', claimedByIds: ['postgres-rollback-moderator'] },
          '2026-10-12T12:01:00.000Z',
          {
            id: 'postgres-rollback-moderator',
            attribution: 'actorKnown',
            confidence: 'high',
          },
        ),
        /simulated postgres outbox failure/,
      );

      const saved = await tickets.getByChannelId(record.channelId);
      assert.equal(saved?.status, 'open');
      assert.equal(saved?.priority, 'normal');
      assert.deepEqual(saved?.claimedByIds, []);

      const events = await new PostgresEventRepository(pool).listTicketEvents(record.id);
      assert.deepEqual(events.map((event) => event.type), ['ticket.created']);
      assert.equal((await new PostgresEventRepository(pool).listOutbox()).length, 1);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS supportforge_test_fail_claimed_outbox_trigger ON outbox_events');
      await pool.query('DROP FUNCTION IF EXISTS supportforge_test_fail_claimed_outbox()');
    }
  },
);

test(
  'legacy audit history is imported into the PostgreSQL document store without losing identifiers',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    const documents = new PostgresJsonDocumentRepository();
    await pool.query("DELETE FROM app_documents WHERE document_key = 'audit-log'");

    const directory = await mkdtemp(join(tmpdir(), 'supportforge-postgres-audit-'));
    const dataDirectory = join(directory, 'data');
    await mkdir(dataDirectory, { recursive: true });

    const auditStore = {
      version: 2,
      guilds: {
        'postgres-audit-guild': {
          events: [{
            id: 'historical-audit-id',
            guildId: 'postgres-audit-guild',
            category: 'settings',
            action: 'SETTINGS_UPDATED',
            actorId: 'moderator-1',
            actorName: 'Moderator',
            actorAttribution: 'actorKnown',
            actorConfidence: 'high',
            timestamp: '2026-10-12T10:00:00.000Z',
            ticketChannelId: 'historical-ticket-channel',
          }],
          summaries: {},
          overallSummary: null,
          accumulationEnabled: true,
          developerViewers: [],
        },
      },
    };

    try {
      await writeFile(
        join(dataDirectory, 'audit-log.json'),
        JSON.stringify(auditStore),
        'utf8',
      );
      const result = await importLegacyJsonDocuments('postgres', directory, documents);
      assert.deepEqual(result.imported, ['audit-log']);
      assert.deepEqual(await documents.get('audit-log'), auditStore);
    } finally {
      await pool.query("DELETE FROM app_documents WHERE document_key = 'audit-log'");
      await rm(directory, { recursive: true, force: true });
    }
  },
);


test(
  'PostgreSQL prevents concurrent pending ticket-button deletion intents for one channel',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    await pool.query('TRUNCATE TABLE tickets CASCADE');

    const record: TicketRepositoryRecord = {
      id: 'postgres-delete-race-ticket',
      guildId: 'postgres-delete-race-guild',
      channelId: 'postgres-delete-race-channel',
      ticketNumber: '77',
      status: 'open',
      departmentId: 'billing',
      tagId: 'refund',
      ownerId: 'postgres-delete-race-owner',
      priority: 'normal',
      claimedByIds: [],
      participantIds: ['postgres-delete-race-owner'],
      metadata: {},
      createdAt: '2026-10-18T12:00:00.000Z',
      updatedAt: '2026-10-18T12:00:00.000Z',
      deletedAt: null,
      deletionReason: null,
    };
    await new PostgresTicketRepository(pool).create(record);

    const insertIntent = (id: string) => pool.query(
      'INSERT INTO ticket_recovery_events ' +
        '(id,ticket_id,guild_id,original_channel_id,source,status,intent,actor_id,actor_name,actor_attribution,confirmation_stage,metadata) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)',
      [
        id,
        record.id,
        record.guildId,
        record.channelId,
        'ticket_button',
        'pending',
        'intentional',
        'postgres-delete-race-actor',
        'Test actor',
        'actorKnown',
        2,
        JSON.stringify({ channelIdAtDeletion: record.channelId }),
      ],
    );

    await insertIntent('postgres-delete-race-intent-1');
    await assert.rejects(
      insertIntent('postgres-delete-race-intent-2'),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === '23505',
    );
  },
);

test(
  'PostgreSQL recovery replay ledger deduplicates completed original messages',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    await pool.query('TRUNCATE TABLE tickets CASCADE');

    const record: TicketRepositoryRecord = {
      id: 'postgres-replay-ledger-ticket',
      guildId: 'postgres-replay-ledger-guild',
      channelId: 'postgres-replay-ledger-channel',
      ticketNumber: '78',
      status: 'open',
      departmentId: 'billing',
      tagId: 'refund',
      ownerId: 'postgres-replay-ledger-owner',
      priority: 'normal',
      claimedByIds: [],
      participantIds: ['postgres-replay-ledger-owner'],
      metadata: {},
      createdAt: '2026-10-18T12:00:00.000Z',
      updatedAt: '2026-10-18T12:00:00.000Z',
      deletedAt: null,
      deletionReason: null,
    };
    await new PostgresTicketRepository(pool).create(record);
    await pool.query(
      'INSERT INTO ticket_recovery_events (id,ticket_id,guild_id,original_channel_id,source,status,intent,actor_id,actor_name,actor_attribution,confirmation_stage,metadata) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)',
      [
        'postgres-replay-ledger-event',
        record.id,
        record.guildId,
        record.channelId,
        'discord_native',
        'restoring',
        'unknown',
        'unknown',
        'Test actor',
        'actorUnknown',
        0,
        JSON.stringify({ channelIdAtDeletion: record.channelId }),
      ],
    );

    await pool.query(
      'INSERT INTO ticket_recovery_replay_items (recovery_event_id,original_message_id,status) VALUES ($1,$2,$3) ' +
        'ON CONFLICT (recovery_event_id,original_message_id) DO NOTHING',
      ['postgres-replay-ledger-event', 'original-message-1', 'completed'],
    );
    await pool.query(
      'INSERT INTO ticket_recovery_replay_items (recovery_event_id,original_message_id,status) VALUES ($1,$2,$3) ' +
        'ON CONFLICT (recovery_event_id,original_message_id) DO NOTHING',
      ['postgres-replay-ledger-event', 'original-message-1', 'completed'],
    );

    const saved = await pool.query(
      'SELECT original_message_id FROM ticket_recovery_replay_items WHERE recovery_event_id=$1',
      ['postgres-replay-ledger-event'],
    );
    assert.deepEqual(saved.rows.map((row: { original_message_id: string }) => row.original_message_id), ['original-message-1']);
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
