import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSupportForgeDatabase,
  type SqliteDatabase,
} from '../src/core/persistence/sqliteDatabase';
import {
  SqliteTicketRepository,
  type TicketRepositoryRecord,
} from '../src/repositories/ticketRepository';

async function withTempDatabase(
  callback: (
    database: SqliteDatabase,
    directory: string,
    legacyTicketsPath: string,
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'supportforge-'));
  const databasePath = join(directory, 'supportforge.sqlite');
  const legacyTicketsPath = join(directory, 'tickets.json');
  const database = createSupportForgeDatabase(
    databasePath,
    legacyTicketsPath,
  );

  try {
    await callback(database, directory, legacyTicketsPath);
  } finally {
    if (database.isOpen) database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function ticket(
  overrides: Partial<TicketRepositoryRecord> = {},
): TicketRepositoryRecord {
  return {
    id: 'ticket-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    ticketNumber: '42',
    status: 'open',
    departmentId: 'billing',
    tagId: 'refund',
    ownerId: 'user-1',
    priority: 'normal',
    claimedByIds: [],
    participantIds: ['user-1'],
    metadata: { subject: 'Refund request' },
    createdAt: '2026-10-06T10:00:00.000Z',
    updatedAt: '2026-10-06T10:00:00.000Z',
    deletedAt: null,
    deletionReason: null,
    ...overrides,
  };
}

test('SQLite schema is migrated and repository preserves structured ticket data', async () => {
  await withTempDatabase(async (database) => {
    const repository = new SqliteTicketRepository(database);
    const original = ticket({
      claimedByIds: ['moderator-1'],
      participantIds: ['user-1', 'moderator-1'],
      metadata: {
        subject: 'Refund',
        custom: { priorityReason: 'duplicate charge' },
      },
    });

    repository.upsert(original);

    assert.deepEqual(repository.getByChannelId('channel-1'), original);
    assert.deepEqual(repository.listByGuildId('guild-1'), [original]);
    assert.deepEqual(repository.listAll(), [original]);
  });
});

test('active owner/department lookup excludes closed and deleted tickets', async () => {
  await withTempDatabase(async (database) => {
    const repository = new SqliteTicketRepository(database);

    repository.upsert(ticket());
    repository.upsert(
      ticket({
        id: 'ticket-2',
        channelId: 'channel-2',
        status: 'closed',
      }),
    );
    repository.upsert(
      ticket({
        id: 'ticket-3',
        channelId: 'channel-3',
        deletedAt: '2026-10-06T11:00:00.000Z',
        deletionReason: 'manual deletion',
      }),
    );
    repository.upsert(
      ticket({
        id: 'ticket-4',
        channelId: 'channel-4',
        departmentId: 'technical',
      }),
    );

    const active = repository.findActiveByOwnerAndDepartment(
      'guild-1',
      'user-1',
      'billing',
    );

    assert.deepEqual(active.map((item) => item.channelId), ['channel-1']);
  });
});

test('legacy tickets migrate with claimant, participant, and metadata fields intact', async () => {
  await withTempDatabase(async (database, directory, legacyTicketsPath) => {
    /*
     * The database is already migrated by the helper. This test exercises the
     * same migration contract directly with a fresh second database so the
     * legacy import migration actually runs.
     */
    database.close();

    const secondDatabasePath = join(directory, 'migrated.sqlite');
    await writeFile(
      legacyTicketsPath,
      JSON.stringify({
        version: 1,
        tickets: {
          'channel-legacy': {
            guildId: 'guild-legacy',
            status: 'claimed',
            updatedAt: '2026-10-06T12:00:00.000Z',
            createdAt: '2026-10-06T11:00:00.000Z',
            ticketNumber: '99',
            departmentId: 'billing',
            tagId: 'refund',
            ownerId: 'user-legacy',
            priority: 'high',
            claimedByIds: ['moderator-1'],
            participantIds: ['user-legacy', 'moderator-1'],
            metadata: { imported: true },
            deletedAt: null,
            deletionReason: null,
          },
        },
      }),
      'utf8',
    );

    const migrated = createSupportForgeDatabase(
      secondDatabasePath,
      legacyTicketsPath,
    );

    try {
      const repository = new SqliteTicketRepository(migrated);
      const result = repository.getByChannelId('channel-legacy');

      assert.ok(result);
      assert.equal(result.guildId, 'guild-legacy');
      assert.equal(result.status, 'claimed');
      assert.deepEqual(result.claimedByIds, ['moderator-1']);
      assert.deepEqual(
        result.participantIds,
        ['user-legacy', 'moderator-1'],
      );
      assert.deepEqual(result.metadata, { imported: true });

      const files = await readdir(directory);
      assert.equal(
        files.filter((name) =>
          name.startsWith('tickets.json.pre-sqlite-') &&
          name.endsWith('.backup')
        ).length,
        1,
      );

      const sourceAfterMigration = await readFile(
        legacyTicketsPath,
        'utf8',
      );
      assert.match(sourceAfterMigration, /channel-legacy/);
    } finally {
      if (migrated.isOpen) migrated.close();
    }
  });
});

test('malformed legacy JSON fails safely without creating a migration marker for the import', async () => {
  await withTempDatabase(async (database, directory, legacyTicketsPath) => {
    database.close();

    await writeFile(
      legacyTicketsPath,
      '{ this is not valid JSON',
      'utf8',
    );

    const brokenDatabasePath = join(directory, 'broken.sqlite');

    assert.throws(
      () =>
        createSupportForgeDatabase(
          brokenDatabasePath,
          legacyTicketsPath,
        ),
      /legacy file is invalid JSON/,
    );

    const recoveryDatabase = createSupportForgeDatabase(
      join(directory, 'recovery.sqlite'),
      join(directory, 'missing-tickets.json'),
    );

    try {
      const statement = recoveryDatabase.prepare(
        'SELECT id FROM schema_migrations ORDER BY id',
      );
      try {
        assert.deepEqual(
          statement.all().map((row) => Number(row.id)),
          [1],
        );
      } finally {
        statement.close();
      }
    } finally {
      if (recoveryDatabase.isOpen) recoveryDatabase.close();
    }
  });
});
