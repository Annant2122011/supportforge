import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSupportForgeDatabase,
  type SqliteDatabase,
} from '../src/core/persistence/sqliteDatabase';
import { SqliteEventRepository } from '../src/repositories/eventRepository';
import {
  SqliteTicketRepository,
  type TicketRepositoryRecord,
} from '../src/repositories/ticketRepository';
import {
  assertTicketStatusTransition,
  canTransitionTicketStatus,
} from '../src/core/domain/ticketLifecycle';

async function withDatabase(
  callback: (db: SqliteDatabase) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'supportforge-stage-c-'));
  const db = createSupportForgeDatabase(
    join(directory, 'supportforge.sqlite'),
    join(directory, 'missing-tickets.json'),
  );

  try {
    await callback(db);
  } finally {
    if (db.isOpen) db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function record(
  overrides: Partial<TicketRepositoryRecord> = {},
): TicketRepositoryRecord {
  return {
    id: 'ticket-c-1',
    guildId: 'guild-c-1',
    channelId: 'channel-c-1',
    ticketNumber: '1',
    status: 'open',
    departmentId: 'billing',
    tagId: 'refund',
    ownerId: 'user-1',
    priority: 'normal',
    claimedByIds: [],
    participantIds: ['user-1'],
    metadata: {},
    createdAt: '2026-10-06T12:00:00.000Z',
    updatedAt: '2026-10-06T12:00:00.000Z',
    deletedAt: null,
    deletionReason: null,
    ...overrides,
  };
}

test('Stage C lifecycle policy accepts valid transitions and rejects invalid ones', () => {
  assert.equal(canTransitionTicketStatus('open', 'claimed'), true);
  assert.equal(canTransitionTicketStatus('closed', 'reopened'), true);
  assert.equal(canTransitionTicketStatus('archived', 'open'), false);

  assert.doesNotThrow(() => {
    assertTicketStatusTransition('closed', 'reopened');
  });

  assert.throws(
    () => assertTicketStatusTransition('archived', 'open'),
    /Invalid QueryFixr ticket lifecycle transition/,
  );
});

test('ticket creation atomically writes the ticket, domain event, and outbox record', async () => {
  await withDatabase(async (db) => {
    const tickets = new SqliteTicketRepository(db);
    tickets.create(record(), {
      id: 'moderator-1',
      attribution: 'actorKnown',
      confidence: 'high',
    });

    const eventRepository = new SqliteEventRepository(db);
    const events = eventRepository.listTicketEvents('ticket-c-1');

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'ticket.created');
    assert.equal(events[0].actorId, 'moderator-1');
    assert.equal(events[0].actorAttribution, 'actorKnown');

    const outbox = eventRepository.listOutbox('pending');
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].type, 'ticket.created');
    assert.equal(outbox[0].aggregateId, 'ticket-c-1');
  });
});

test('status transitions are conditional, durable, and append a domain event plus outbox entry', async () => {
  await withDatabase(async (db) => {
    const tickets = new SqliteTicketRepository(db);
    tickets.create(record());

    tickets.transitionStatus(
      'channel-c-1',
      'claimed',
      '2026-10-06T12:01:00.000Z',
      {
        id: 'moderator-2',
        attribution: 'actorKnown',
        confidence: 'high',
      },
    );

    assert.equal(tickets.getByChannelId('channel-c-1')?.status, 'claimed');

    const eventRepository = new SqliteEventRepository(db);
    const events = eventRepository.listTicketEvents('ticket-c-1');
    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'ticket.claimed');
    assert.deepEqual(events[1].payload, {
      from: 'open',
      to: 'claimed',
    });

    const outbox = eventRepository.listOutbox('pending');
    assert.equal(outbox.length, 2);
  });
});

test('atomic lifecycle and metadata transition commits state, event log, and outbox together', async () => {
  await withDatabase(async (db) => {
    const tickets = new SqliteTicketRepository(db);
    tickets.create(record());

    tickets.transitionStatusAndMetadata(
      'channel-c-1',
      'claimed',
      {
        priority: 'critical',
        claimedByIds: ['moderator-1'],
      },
      '2026-10-06T12:03:00.000Z',
      {
        id: 'moderator-1',
        attribution: 'actorKnown',
        confidence: 'high',
      },
    );

    const saved = tickets.getByChannelId('channel-c-1');
    assert.equal(saved?.status, 'claimed');
    assert.equal(saved?.priority, 'critical');
    assert.deepEqual(saved?.claimedByIds, ['moderator-1']);

    const events = new SqliteEventRepository(db);
    assert.deepEqual(
      events.listTicketEvents('ticket-c-1').map((event) => event.type),
      ['ticket.created', 'ticket.claimed', 'ticket.metadata_changed'],
    );
    assert.equal(events.listOutbox('pending').length, 3);
  });
});

test('failed outbox enqueue rolls back the entire ticket transition', async () => {
  await withDatabase(async (db) => {
    const tickets = new SqliteTicketRepository(db);
    tickets.create(record());
    db.exec(
      "CREATE TRIGGER fail_claimed_outbox BEFORE INSERT ON outbox_events " +
      "WHEN NEW.event_type = 'ticket.claimed' BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END;",
    );

    assert.throws(
      () => tickets.transitionStatusAndMetadata(
        'channel-c-1',
        'claimed',
        { priority: 'high' },
        '2026-10-06T12:04:00.000Z',
      ),
      /simulated outbox failure/,
    );

    const saved = tickets.getByChannelId('channel-c-1');
    assert.equal(saved?.status, 'open');
    assert.equal(saved?.priority, 'normal');

    const events = new SqliteEventRepository(db);
    assert.deepEqual(
      events.listTicketEvents('ticket-c-1').map((event) => event.type),
      ['ticket.created'],
    );
    assert.equal(events.listOutbox('pending').length, 1);
  });
});

test('ticket message activity updates metadata and emits a typed domain event', async () => {
  await withDatabase(async (db) => {
    const tickets = new SqliteTicketRepository(db);
    tickets.create(record());

    const occurredAt = '2026-10-06T12:05:00.000Z';
    tickets.transitionStatusAndMetadata(
      'channel-c-1',
      'open',
      {
        metadata: {
          lastMessageId: 'message-1',
          lastMessageAuthorId: 'user-1',
          lastMessageAuthorType: 'customer',
          lastActivityAt: occurredAt,
          lastCustomerMessageAt: occurredAt,
        },
      },
      occurredAt,
      { id: 'user-1', attribution: 'actorKnown', confidence: 'high' },
    );

    const ticket = tickets.getByChannelId('channel-c-1');
    assert.equal(ticket?.metadata.lastMessageId, 'message-1');
    assert.equal(ticket?.metadata.lastCustomerMessageAt, occurredAt);

    const events = new SqliteEventRepository(db);
    const event = events.listTicketEvents('ticket-c-1')[1];
    assert.equal(event.type, 'ticket.message.received');
    assert.deepEqual(event.payload, {
      changedFields: ['metadata'],
      messageId: 'message-1',
      messageAuthorType: 'customer',
      messageTimestamp: occurredAt,
    });
  });
});

test('invalid status transitions do not mutate durable state or create events', async () => {
  await withDatabase(async (db) => {
    const tickets = new SqliteTicketRepository(db);
    tickets.create(record({ status: 'archived' }));

    assert.throws(
      () =>
        tickets.transitionStatus(
          'channel-c-1',
          'open',
          '2026-10-06T12:02:00.000Z',
        ),
      /Invalid QueryFixr ticket lifecycle transition/,
    );

    assert.equal(tickets.getByChannelId('channel-c-1')?.status, 'archived');

    const eventRepository = new SqliteEventRepository(db);
    assert.equal(eventRepository.listTicketEvents('ticket-c-1').length, 1);
    assert.equal(eventRepository.listOutbox('pending').length, 1);
  });
});

test('outbox claiming prevents duplicate workers and stale processing can recover after restart', async () => {
  await withDatabase(async (db) => {
    const tickets = new SqliteTicketRepository(db);
    tickets.create(record());

    const events = new SqliteEventRepository(db);
    const pending = events.listPendingOutbox();
    assert.equal(pending.length, 1);

    assert.equal(events.markOutboxProcessing(pending[0].id), true);
    assert.equal(events.markOutboxProcessing(pending[0].id), false);

    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    db.prepare(
      "UPDATE outbox_events SET available_at = ?, processing_started_at = ? WHERE id = ?",
    ).run(stale, stale, pending[0].id);

    assert.equal(
      events.recoverStaleProcessing(
        new Date(Date.now() - 30 * 60_000).toISOString(),
      ),
      1,
    );

    assert.equal(events.listPendingOutbox().length, 1);
  });
});
test('outbox automatic retries are bounded and explicit requeue resets the attempt budget', async () => {
  await withDatabase(async (db) => {
    const tickets = new SqliteTicketRepository(db);
    tickets.create(record());

    const events = new SqliteEventRepository(db);
    const first = events.listPendingOutbox()[0];
    assert.ok(first);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      db.prepare(
        "UPDATE outbox_events SET available_at = ? WHERE id = ?",
      ).run(new Date().toISOString(), first.id);
      assert.equal(events.markOutboxProcessing(first.id), true);
      events.markOutboxFailed(
        first.id,
        'simulated Discord error',
        new Date().toISOString(),
      );
    }

    assert.equal(events.listPendingOutbox().length, 0);
    assert.equal(events.listOutbox('failed')[0]?.attempts, 10);

    events.requeueFailed(first.id, new Date().toISOString());
    assert.equal(events.listPendingOutbox().length, 1);
    assert.equal(events.listPendingOutbox()[0]?.attempts, 0);
  });
});

test('removing a ticket preserves the ticket tombstone, full event history, and outbox audit trail', async () => {
  await withDatabase(async (db) => {
    const tickets = new SqliteTicketRepository(db);
    tickets.create(record());

    const events = new SqliteEventRepository(db);
    assert.equal(events.listTicketEvents('ticket-c-1').length, 1);
    assert.equal(events.listOutbox('pending').length, 1);

    tickets.remove('channel-c-1');

    const deleted = tickets.getByChannelId('channel-c-1');
    assert.ok(deleted);
    assert.ok(deleted.deletedAt);
    assert.match(deleted.deletionReason ?? '', /history retained/i);
    assert.deepEqual(
      events.listTicketEvents('ticket-c-1').map((event) => event.type),
      ['ticket.created', 'ticket.deleted'],
    );
    assert.equal(events.listOutbox('pending').length, 2);
  });
});
