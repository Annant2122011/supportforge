import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  closePostgresDatabase,
  getPostgresPool,
} from '../src/core/persistence/postgresDatabase';
import { migratePostgres } from '../src/core/persistence/migrationRunner';
import { getPersistedTicket } from '../src/services/ticketPersistenceService';
import { executeWorkflowTemplateForTicket, listWorkflowExecutionRunsForTicket } from '../src/services/workflowExecutionService';
import { PostgresEventRepository } from '../src/repositories/postgresEventRepository';
import { PostgresJsonDocumentRepository, importLegacyJsonDocuments } from '../src/repositories/jsonDocumentRepository';
import { PostgresTicketRepository } from '../src/repositories/postgresTicketRepository';
import {
  deleteQuickReply,
  listQuickReplies,
  listQuickReplyRevisions,
  saveQuickReply,
} from '../src/services/quickReplyService';
import {
  deleteWorkflowTemplate,
  listWorkflowTemplates,
  listWorkflowTemplateRevisions,
  saveWorkflowTemplate,
  setWorkflowTemplateEnabled,
} from '../src/services/workflowTemplateService';
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

    const afterMetadataUpdate = await tickets.getByChannelId(record.channelId);
    assert.equal(afterMetadataUpdate?.priority, 'critical');
    assert.equal(afterMetadataUpdate?.status, 'claimed', 'metadata/activity updates must not replay a stale lifecycle status');

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
    assert.deepEqual(eventTypes, ['ticket.created', 'ticket.closed', 'ticket.metadata_changed']);
    assert.equal((await events.listOutbox()).length, 3);

    const duplicateClose = await tickets.closeIfActivityUnchanged(
      record.channelId,
      activityAt,
      { metadata: { inactivityAutoClosedAt: closedAt } },
      closedAt,
    );
    assert.equal(duplicateClose, false);
    assert.deepEqual((await events.listTicketEvents(record.id)).map((event) => event.type), eventTypes);
    assert.equal((await events.listOutbox()).length, 3);
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


test(
  'PostgreSQL durable recovery segment ledger preserves intent and completed Discord message identity',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    await pool.query('TRUNCATE TABLE tickets CASCADE');
    const record: TicketRepositoryRecord = {
      id: 'postgres-replay-segment-ticket',
      guildId: 'postgres-replay-segment-guild',
      channelId: 'postgres-replay-segment-channel',
      ticketNumber: '79',
      status: 'open',
      departmentId: 'billing',
      tagId: 'refund',
      ownerId: 'postgres-replay-segment-owner',
      priority: 'normal',
      claimedByIds: [],
      participantIds: ['postgres-replay-segment-owner'],
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
        'postgres-replay-segment-event',
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

    const key = ['postgres-replay-segment-event', 'original-message-1', 'content:0'];
    await pool.query(
      'INSERT INTO ticket_recovery_replay_segments ' +
        '(recovery_event_id,original_message_id,segment_key,status,attempts,attempt_started_at) ' +
        "VALUES ($1,$2,$3,'pending',1,NOW()) ON CONFLICT DO NOTHING",
      key,
    );
    await pool.query(
      'INSERT INTO ticket_recovery_replay_segments ' +
        '(recovery_event_id,original_message_id,segment_key,status,attempts,attempt_started_at) ' +
        "VALUES ($1,$2,$3,'pending',1,NOW()) ON CONFLICT DO NOTHING",
      key,
    );
    const pending = await pool.query(
      'SELECT status,attempts,discord_message_id FROM ticket_recovery_replay_segments WHERE recovery_event_id=$1 AND original_message_id=$2 AND segment_key=$3',
      key,
    );
    assert.equal(pending.rows.length, 1);
    assert.equal(pending.rows[0].status, 'pending');
    assert.equal(Number(pending.rows[0].attempts), 1);
    assert.equal(pending.rows[0].discord_message_id, null);

    await pool.query(
      "UPDATE ticket_recovery_replay_segments SET status='completed',discord_message_id=$4,updated_at=NOW() WHERE recovery_event_id=$1 AND original_message_id=$2 AND segment_key=$3",
      [...key, 'discord-message-recovered-1'],
    );
    const complete = await pool.query(
      'SELECT status,discord_message_id FROM ticket_recovery_replay_segments WHERE recovery_event_id=$1 AND original_message_id=$2 AND segment_key=$3',
      key,
    );
    assert.equal(complete.rows[0].status, 'completed');
    assert.equal(complete.rows[0].discord_message_id, 'discord-message-recovered-1');
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


test(
  'quick replies preserve revisions, reject stale edits, and soft-delete with expected-version protection',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    const guildId = 'postgres-quick-reply-' + randomUUID();
    const actorId = 'postgres-test-admin';
    try {
      const created = await saveQuickReply(guildId, actorId, {
        name: 'Billing update',
        body: 'Your request is being reviewed.',
        category: 'Billing',
      });
      assert.equal(created.version, 1);

      const updated = await saveQuickReply(guildId, actorId, {
        name: 'Billing update',
        body: 'Your refund request is being reviewed.',
        category: 'Billing',
      }, 1);
      assert.equal(updated.version, 2);
      await assert.rejects(
        () => saveQuickReply(guildId, actorId, {
          name: 'Billing update',
          body: 'Stale content must not overwrite the latest version.',
        }, 1),
        /changed since you opened it/,
      );

      const removed = await deleteQuickReply(guildId, 'Billing update', 2, actorId);
      assert.equal(removed, true);
      assert.deepEqual(await listQuickReplies(guildId, { isAdmin: true, roleIds: [] }), []);
      const revisions = await listQuickReplyRevisions(guildId, created.id);
      assert.deepEqual(revisions.map((item) => item.version), [3, 2, 1]);
      assert.deepEqual(revisions.map((item) => item.operation), ['deleted', 'updated', 'created']);

      const recreated = await saveQuickReply(guildId, actorId, {
        name: 'Billing update',
        body: 'This is a new active definition.',
        category: 'Billing',
      });
      assert.notEqual(recreated.id, created.id);
      assert.deepEqual(await listQuickReplies(guildId, { isAdmin: true, roleIds: [] }).then((items) => items.map((item) => item.id)), [recreated.id]);
    } finally {
      await pool.query('DELETE FROM quick_reply_revisions WHERE guild_id=$1', [guildId]);
      await pool.query('DELETE FROM quick_replies WHERE guild_id=$1', [guildId]);
    }
  },
);

test(
  'workflow templates preserve revisions through edits, enablement, stale writes, and soft deletion',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    const guildId = 'postgres-workflow-' + randomUUID();
    const actorId = 'postgres-test-admin';
    const firstDefinition = {
      conditions: [{ field: 'priority', equals: 'urgent' }],
      actions: [{ type: 'set_priority', value: 'high' }],
    };
    const secondDefinition = {
      conditions: [{ field: 'status', equals: 'open' }],
      actions: [{ type: 'set_priority', value: 'critical' }],
    };
    try {
      const created = await saveWorkflowTemplate(guildId, actorId, 'Urgent triage', firstDefinition);
      assert.equal(created.version, 1);

      const updated = await saveWorkflowTemplate(guildId, actorId, 'Urgent triage', secondDefinition, 1);
      assert.equal(updated.version, 2);
      await assert.rejects(
        () => saveWorkflowTemplate(guildId, actorId, 'Urgent triage', firstDefinition, 1),
        /changed since you opened it/,
      );

      const enabled = await setWorkflowTemplateEnabled(guildId, created.id, 2, true, actorId);
      assert.equal(enabled.version, 3);
      assert.equal(enabled.enabled, true);
      const disabled = await setWorkflowTemplateEnabled(guildId, created.id, 3, false, actorId);
      assert.equal(disabled.version, 4);
      assert.equal(disabled.enabled, false);

      assert.equal(await deleteWorkflowTemplate(guildId, created.id, 4, actorId), true);
      assert.deepEqual(await listWorkflowTemplates(guildId), []);
      const revisions = await listWorkflowTemplateRevisions(guildId, created.id);
      assert.deepEqual(revisions.map((item) => item.version), [5, 4, 3, 2, 1]);
      assert.deepEqual(revisions.map((item) => item.operation), ['deleted', 'disabled', 'enabled', 'updated', 'created']);
      assert.equal(revisions[0]?.deleted, true);
    } finally {
      await pool.query('DELETE FROM workflow_template_revisions WHERE guild_id=$1', [guildId]);
      await pool.query('DELETE FROM workflow_templates WHERE guild_id=$1', [guildId]);
    }
  },
);


test(
  'manual workflow execution is confirmed, ledgered, and idempotent for a repeated interaction',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    const tickets = new PostgresTicketRepository(pool);
    const guildId = 'postgres-workflow-run-' + randomUUID();
    const actorId = 'postgres-workflow-admin';
    const ticketId = 'ticket-' + randomUUID();
    const channelId = 'channel-' + randomUUID();
    const interactionId = 'interaction-' + randomUUID();
    const now = new Date().toISOString();
    const record: TicketRepositoryRecord = {
      id: ticketId,
      guildId,
      channelId,
      ticketNumber: '71',
      status: 'open',
      departmentId: null,
      tagId: null,
      ownerId: 'workflow-test-owner',
      priority: 'normal',
      claimedByIds: [],
      participantIds: ['workflow-test-owner'],
      metadata: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletionReason: null,
    };

    try {
      await tickets.create(record, { id: actorId, attribution: 'actorKnown', confidence: 'high' });
      const template = await saveWorkflowTemplate(guildId, actorId, 'Set high priority', {
        conditions: [{ field: 'priority', equals: 'normal' }],
        actions: [{ type: 'set_priority', value: 'high' }],
      });
      const enabled = await setWorkflowTemplateEnabled(guildId, template.id, template.version, true, actorId);
      assert.equal(enabled.enabled, true);
      assert.equal(enabled.version, 2);

      const baseInput = {
        guildId,
        channel: { id: channelId } as never,
        actorId,
        actorName: 'Workflow Test Admin',
        interactionId,
        templateId: template.id,
        expectedVersion: enabled.version,
      };
      await assert.rejects(
        executeWorkflowTemplateForTicket({ ...baseInput, confirmation: 'RUN ' + template.id + ' v1' }),
        /Type exactly: RUN/,
      );

      const run = await executeWorkflowTemplateForTicket({
        ...baseInput,
        confirmation: 'RUN ' + template.id + ' v' + enabled.version,
      });
      assert.equal(run.status, 'completed');
      assert.equal(run.steps.length, 1);
      assert.equal(run.steps[0]?.status, 'completed');
      assert.equal((await getPersistedTicket(channelId))?.priority, 'high');

      const duplicateInteraction = await executeWorkflowTemplateForTicket({
        ...baseInput,
        confirmation: 'RUN ' + template.id + ' v' + enabled.version,
      });
      assert.equal(duplicateInteraction.id, run.id);
      assert.equal((await listWorkflowExecutionRunsForTicket(guildId, ticketId)).length, 1);
    } finally {
      await pool.query('DELETE FROM workflow_execution_steps WHERE guild_id=$1', [guildId]);
      await pool.query('DELETE FROM workflow_execution_runs WHERE guild_id=$1', [guildId]);
      await pool.query('DELETE FROM workflow_template_revisions WHERE guild_id=$1', [guildId]);
      await pool.query('DELETE FROM workflow_templates WHERE guild_id=$1', [guildId]);
      await pool.query('DELETE FROM ticket_events WHERE guild_id=$1', [guildId]);
      await pool.query('DELETE FROM outbox_events WHERE guild_id=$1', [guildId]);
      await pool.query('DELETE FROM tickets WHERE guild_id=$1', [guildId]);
      await pool.query('DELETE FROM app_documents WHERE POSITION($1 IN document_key)>0', [guildId]);
    }
  },
);
