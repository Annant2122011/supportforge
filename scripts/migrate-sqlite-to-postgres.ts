import 'dotenv/config';

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

import { migratePostgres } from '../src/core/persistence/migrationRunner';

interface SqliteRow {
  [key: string]: unknown;
}

interface SqliteDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): SqliteRow[];
    get(...params: unknown[]): SqliteRow | undefined;
  };
  close(): void;
}

interface DatabaseSyncConstructor {
  new (path: string, options?: { readOnly?: boolean }): SqliteDatabase;
}

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: DatabaseSyncConstructor;
};

const apply = process.argv.includes('--apply');
const sqlitePath = resolve(
  process.env.SUPPORTFORGE_SQLITE_PATH ??
    join(process.cwd(), 'data', 'supportforge.sqlite'),
);

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL_UNPOOLED?.trim();
  if (!value) {
    throw new Error(
      'DATABASE_URL_UNPOOLED is required for the migration because the target Neon database must be accessed directly.',
    );
  }
  return value;
}

function jsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function count(rows: SqliteRow[]): number {
  return rows.length;
}

async function targetCount(client: Client, table: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function main(): Promise<void> {
  if (!existsSync(sqlitePath)) {
    throw new Error(
      `SQLite source database does not exist: ${sqlitePath}`,
    );
  }

  /*
   * Open the source read-only. The migration command must never mutate the
   * existing SQLite database or its supportforge.sqlite WAL/shm files.
   */
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });

  try {
    const tables = new Set(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .all()
        .map((row) => String(row.name)),
    );

    if (!tables.has('tickets')) {
      throw new Error('SQLite source has no tickets table.');
    }

    const tickets = sqlite
      .prepare('SELECT * FROM tickets ORDER BY created_at ASC')
      .all();

    const ticketEvents = tables.has('ticket_events')
      ? sqlite
          .prepare('SELECT * FROM ticket_events ORDER BY created_at ASC')
          .all()
      : [];

    const outboxEvents = tables.has('outbox_events')
      ? sqlite
          .prepare('SELECT * FROM outbox_events ORDER BY created_at ASC')
          .all()
      : [];

    console.log('────────────────────────────────────────────');
    console.log('SupportForge SQLite → Neon PostgreSQL migration');
    console.log('────────────────────────────────────────────');
    console.log(`Source: ${sqlitePath}`);
    console.log(`Tickets: ${count(tickets)}`);
    console.log(`Ticket events: ${count(ticketEvents)}`);
    console.log(`Outbox events: ${count(outboxEvents)}`);
    console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
    console.log('');

    const client = new Client({
      connectionString: requireDatabaseUrl(),
      application_name: 'supportforge-sqlite-postgres-migration',
    });

    await client.connect();

    try {
      await migratePostgres();

      const existingTickets = await targetCount(client, 'tickets');
      const existingEvents = await targetCount(client, 'ticket_events');
      const existingOutbox = await targetCount(client, 'outbox_events');

      console.log(
        `Target currently contains tickets=${existingTickets}, events=${existingEvents}, outbox=${existingOutbox}.`,
      );

      if (
        existingTickets > 0 ||
        existingEvents > 0 ||
        existingOutbox > 0
      ) {
        throw new Error(
          'Target PostgreSQL tables are not empty. Migration is intentionally refusing to merge or overwrite existing production data.',
        );
      }

      if (!apply) {
        console.log(
          '✅ Dry run completed. No source or target data was modified. Run with --apply to perform the migration.',
        );
        return;
      }

      await client.query('BEGIN');

      try {
        for (const ticket of tickets) {
          await client.query(
            'INSERT INTO tickets (' +
              'id, guild_id, channel_id, ticket_number, status, department_id, tag_id, owner_id, priority, claimed_by_ids, participant_ids, metadata, created_at, updated_at, deleted_at, deletion_reason' +
              ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[], $12::jsonb, $13::timestamptz, $14::timestamptz, $15::timestamptz, $16)',
            [
              stringOrNull(ticket.id),
              stringOrNull(ticket.guild_id) ?? 'unknown',
              stringOrNull(ticket.channel_id) ?? '',
              stringOrNull(ticket.ticket_number),
              stringOrNull(ticket.status) ?? 'open',
              stringOrNull(ticket.department_id),
              stringOrNull(ticket.tag_id),
              stringOrNull(ticket.owner_id),
              stringOrNull(ticket.priority),
              jsonArray(ticket.claimed_by_json),
              jsonArray(ticket.participant_ids_json),
              JSON.stringify(jsonObject(ticket.metadata_json)),
              stringOrNull(ticket.created_at) ?? new Date().toISOString(),
              stringOrNull(ticket.updated_at) ?? new Date().toISOString(),
              stringOrNull(ticket.deleted_at),
              stringOrNull(ticket.deletion_reason),
            ],
          );
        }

        for (const event of ticketEvents) {
          await client.query(
            'INSERT INTO ticket_events (' +
              'id, ticket_id, guild_id, channel_id, event_type, actor_id, actor_attribution, actor_confidence, payload, created_at' +
              ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz)',
            [
              stringOrNull(event.id) ?? '',
              stringOrNull(event.ticket_id) ?? '',
              stringOrNull(event.guild_id) ?? 'unknown',
              stringOrNull(event.channel_id) ?? '',
              stringOrNull(event.event_type) ?? 'ticket.metadata_changed',
              stringOrNull(event.actor_id) ?? 'supportforge-system',
              stringOrNull(event.actor_attribution) ?? 'actorUnknown',
              stringOrNull(event.actor_confidence) ?? 'none',
              JSON.stringify(jsonObject(event.payload_json)),
              stringOrNull(event.created_at) ?? new Date().toISOString(),
            ],
          );
        }

        let resetProcessing = 0;

        for (const outbox of outboxEvents) {
          const sourceStatus = stringOrNull(outbox.status) ?? 'pending';
          /*
           * A SQLite worker may have been processing an event when the bot was
           * stopped. PostgreSQL has a real processing lease, so processing
           * rows are safely restored to pending and retried after migration.
           */
          const status = sourceStatus === 'processing'
            ? 'pending'
            : sourceStatus;

          if (sourceStatus === 'processing') resetProcessing += 1;

          await client.query(
            'INSERT INTO outbox_events (' +
              'id, aggregate_type, aggregate_id, guild_id, event_type, payload, status, attempts, available_at, created_at, processed_at, processing_started_at, last_error' +
              ') VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz, NULL, $12)',
            [
              stringOrNull(outbox.id) ?? '',
              stringOrNull(outbox.aggregate_type) ?? 'ticket',
              stringOrNull(outbox.aggregate_id) ?? '',
              stringOrNull(outbox.guild_id) ?? 'unknown',
              stringOrNull(outbox.event_type) ?? 'ticket.metadata_changed',
              JSON.stringify(jsonObject(outbox.payload_json)),
              status,
              Number(outbox.attempts ?? 0),
              stringOrNull(outbox.available_at) ?? new Date().toISOString(),
              stringOrNull(outbox.created_at) ?? new Date().toISOString(),
              status === 'published'
                ? stringOrNull(outbox.processed_at)
                : null,
              stringOrNull(outbox.last_error),
            ],
          );
        }

        const migratedTickets = await targetCount(client, 'tickets');
        const migratedEvents = await targetCount(client, 'ticket_events');
        const migratedOutbox = await targetCount(client, 'outbox_events');

        if (
          migratedTickets !== tickets.length ||
          migratedEvents !== ticketEvents.length ||
          migratedOutbox !== outboxEvents.length
        ) {
          throw new Error(
            `Migration verification failed inside transaction. Target counts are tickets=${migratedTickets}, events=${migratedEvents}, outbox=${migratedOutbox}; source counts are tickets=${tickets.length}, events=${ticketEvents.length}, outbox=${outboxEvents.length}.`,
          );
        }

        const orphanEvents = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM ticket_events e LEFT JOIN tickets t ON t.id = e.ticket_id WHERE t.id IS NULL',
        );
        const orphanOutbox = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM outbox_events o LEFT JOIN tickets t ON t.id = o.aggregate_id WHERE t.id IS NULL',
        );

        if (
          Number(orphanEvents.rows[0]?.count ?? 0) !== 0 ||
          Number(orphanOutbox.rows[0]?.count ?? 0) !== 0
        ) {
          throw new Error(
            'Migration verification found orphaned ticket events or outbox records.',
          );
        }

        await client.query('COMMIT');

        console.log('');
        console.log('✅ PostgreSQL migration committed successfully.');
        console.log(`Tickets migrated: ${tickets.length}`);
        console.log(`Ticket events migrated: ${ticketEvents.length}`);
        console.log(`Outbox events migrated: ${outboxEvents.length}`);
        console.log(`Processing outbox rows safely reset: ${resetProcessing}`);
        console.log('✅ Referential-integrity checks passed.');
        console.log('✅ SQLite source database was not modified.');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original migration failure.
        }
        throw error;
      }
    } finally {
      await client.end();
    }
  } finally {
    sqlite.close();
  }
}

main().catch((error) => {
  console.error('❌ SQLite → PostgreSQL migration failed:', error);
  process.exitCode = 1;
});
