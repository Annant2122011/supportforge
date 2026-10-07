import 'dotenv/config';

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, type QueryResultRow } from 'pg';

import {
  migratePostgres,
  POSTGRES_MIGRATION_LOCK_KEY,
} from '../src/core/persistence/migrationRunner';

interface SqliteRow {
  [key: string]: unknown;
}

interface SqliteStatement {
  run(...params: unknown[]): {
    changes: number | bigint;
  };
  all(...params: unknown[]): SqliteRow[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface DatabaseSyncConstructor {
  new (path: string, options?: { readOnly?: boolean }): SqliteDatabase;
}

interface TicketSnapshot {
  id: string;
  guild_id: string;
  channel_id: string;
  status: string;
  ticket_number: string | null;
  department_id: string | null;
  tag_id: string | null;
  owner_id: string | null;
  priority: string | null;
  claimed_by_json: string;
  participant_ids_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deletion_reason: string | null;
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
      'DATABASE_URL_UNPOOLED is required for the migration. Do not paste credentials into source files.',
    );
  }
  return value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function jsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected a JSON array in SQLite ticket data.');
  }
  return parsed.filter((item): item is string => typeof item === 'string');
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new Error('Expected a JSON object in SQLite ticket data.');
  }
  return parsed as Record<string, unknown>;
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableObject(item)]),
    );
  }
  return value;
}

function digest(values: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify(stableObject(values)))
    .digest('hex');
}

function requireNonEmpty(value: string | null, label: string): string {
  if (!value) throw new Error(`SQLite row is missing required field: ${label}`);
  return value;
}

function assertValidTicketStatus(value: string): void {
  if (!['open', 'claimed', 'pending', 'reopened', 'closed', 'archived'].includes(value)) {
    throw new Error(`SQLite contains unsupported ticket status: ${value}`);
  }
}

function validateSource(
  tables: Set<string>,
  tickets: SqliteRow[],
  ticketEvents: SqliteRow[],
  outboxEvents: SqliteRow[],
): void {
  if (!tables.has('tickets')) {
    throw new Error('SQLite source has no tickets table.');
  }

  const ticketIds = new Set<string>();

  for (const row of tickets) {
    const id = requireNonEmpty(stringOrNull(row.id), 'tickets.id');
    requireNonEmpty(stringOrNull(row.guild_id), 'tickets.guild_id');
    requireNonEmpty(stringOrNull(row.channel_id), 'tickets.channel_id');

    if (ticketIds.has(id)) {
      throw new Error(`Duplicate SQLite ticket id detected: ${id}`);
    }
    ticketIds.add(id);

    assertValidTicketStatus(stringOrNull(row.status) ?? 'open');
    jsonArray(row.claimed_by_json ?? '[]');
    jsonArray(row.participant_ids_json ?? '[]');
    jsonObject(row.metadata_json ?? '{}');

    if (!stringOrNull(row.created_at) || !stringOrNull(row.updated_at)) {
      throw new Error(`SQLite ticket ${id} is missing a timestamp.`);
    }
  }

  const eventIds = new Set<string>();
  for (const row of ticketEvents) {
    const id = requireNonEmpty(stringOrNull(row.id), 'ticket_events.id');
    const ticketId = requireNonEmpty(
      stringOrNull(row.ticket_id),
      'ticket_events.ticket_id',
    );

    if (!ticketIds.has(ticketId)) {
      throw new Error(
        `SQLite event ${id} references missing ticket ${ticketId}.`,
      );
    }

    if (eventIds.has(id)) {
      throw new Error(`Duplicate SQLite event id detected: ${id}`);
    }
    eventIds.add(id);

    jsonObject(row.payload_json ?? '{}');
  }

  const outboxIds = new Set<string>();
  for (const row of outboxEvents) {
    const id = requireNonEmpty(stringOrNull(row.id), 'outbox_events.id');
    const aggregateId = requireNonEmpty(
      stringOrNull(row.aggregate_id),
      'outbox_events.aggregate_id',
    );

    if (!ticketIds.has(aggregateId)) {
      throw new Error(
        `SQLite outbox record ${id} references missing ticket ${aggregateId}.`,
      );
    }

    if (stringOrNull(row.aggregate_type) !== 'ticket') {
      throw new Error(
        `SQLite outbox record ${id} has unsupported aggregate type.`,
      );
    }

    const status = stringOrNull(row.status) ?? 'pending';
    if (!['pending', 'processing', 'published', 'failed'].includes(status)) {
      throw new Error(
        `SQLite outbox record ${id} has unsupported status: ${status}`,
      );
    }

    if (outboxIds.has(id)) {
      throw new Error(`Duplicate SQLite outbox id detected: ${id}`);
    }
    outboxIds.add(id);

    jsonObject(row.payload_json ?? '{}');
  }
}

async function targetCount(
  client: Client,
  table: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

function rowTicketSnapshot(row: SqliteRow): TicketSnapshot {
  const id = requireNonEmpty(stringOrNull(row.id), 'tickets.id');

  return {
    id,
    guild_id: requireNonEmpty(stringOrNull(row.guild_id), 'tickets.guild_id'),
    channel_id: requireNonEmpty(stringOrNull(row.channel_id), 'tickets.channel_id'),
    status: stringOrNull(row.status) ?? 'open',
    ticket_number: stringOrNull(row.ticket_number),
    department_id: stringOrNull(row.department_id),
    tag_id: stringOrNull(row.tag_id),
    owner_id: stringOrNull(row.owner_id),
    priority: stringOrNull(row.priority),
    claimed_by_json: JSON.stringify(jsonArray(row.claimed_by_json ?? '[]')),
    participant_ids_json: JSON.stringify(jsonArray(row.participant_ids_json ?? '[]')),
    metadata_json: JSON.stringify(stableObject(jsonObject(row.metadata_json ?? '{}'))),
    created_at: requireNonEmpty(stringOrNull(row.created_at), 'tickets.created_at'),
    updated_at: requireNonEmpty(stringOrNull(row.updated_at), 'tickets.updated_at'),
    deleted_at: stringOrNull(row.deleted_at),
    deletion_reason: stringOrNull(row.deletion_reason),
  };
}

function postgresString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowPostgresTicketSnapshot(row: QueryResultRow): TicketSnapshot {
  const id = requireNonEmpty(postgresString(row.id), 'tickets.id');

  return {
    id,
    guild_id: requireNonEmpty(postgresString(row.guild_id), 'tickets.guild_id'),
    channel_id: requireNonEmpty(postgresString(row.channel_id), 'tickets.channel_id'),
    status: requireNonEmpty(postgresString(row.status), 'tickets.status'),
    ticket_number: postgresString(row.ticket_number),
    department_id: postgresString(row.department_id),
    tag_id: postgresString(row.tag_id),
    owner_id: postgresString(row.owner_id),
    priority: postgresString(row.priority),
    claimed_by_json: JSON.stringify(
      Array.isArray(row.claimed_by_ids) ? row.claimed_by_ids : [],
    ),
    participant_ids_json: JSON.stringify(
      Array.isArray(row.participant_ids) ? row.participant_ids : [],
    ),
    metadata_json: JSON.stringify(
      stableObject(
        row.metadata &&
        typeof row.metadata === 'object' &&
        !Array.isArray(row.metadata)
          ? row.metadata
          : {},
      ),
    ),
    created_at: requireNonEmpty(postgresString(row.created_at), 'tickets.created_at'),
    updated_at: requireNonEmpty(postgresString(row.updated_at), 'tickets.updated_at'),
    deleted_at: postgresString(row.deleted_at),
    deletion_reason: postgresString(row.deletion_reason),
  };
}

async function main(): Promise<void> {
  if (!existsSync(sqlitePath)) {
    throw new Error(`SQLite source database does not exist: ${sqlitePath}`);
  }

  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });

  try {
    /*
     * Read every source table from one SQLite snapshot. The snapshot is
     * released before target writes begin, so the source is never modified
     * and is not held open for the duration of the network migration.
     */
    sqlite.exec('BEGIN');

    let tickets: SqliteRow[];
    let ticketEvents: SqliteRow[];
    let outboxEvents: SqliteRow[];

    try {
      const tables = new Set(
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => String(row.name)),
      );

      if (!tables.has('tickets')) {
        throw new Error('SQLite source has no tickets table.');
      }

      tickets = sqlite
        .prepare('SELECT * FROM tickets ORDER BY created_at ASC, id ASC')
        .all();

      ticketEvents = tables.has('ticket_events')
        ? sqlite
            .prepare('SELECT * FROM ticket_events ORDER BY created_at ASC, id ASC')
            .all()
        : [];

      outboxEvents = tables.has('outbox_events')
        ? sqlite
            .prepare('SELECT * FROM outbox_events ORDER BY created_at ASC, id ASC')
            .all()
        : [];

      validateSource(tables, tickets, ticketEvents, outboxEvents);
      sqlite.exec('COMMIT');
    } catch (error) {
      try {
        sqlite.exec('ROLLBACK');
      } catch {
        // Preserve the original source-validation error.
      }
      throw error;
    }

    const ticketSnapshots = tickets.map(rowTicketSnapshot);

    console.log('────────────────────────────────────────────');
    console.log('SupportForge SQLite → Neon PostgreSQL migration');
    console.log('────────────────────────────────────────────');
    console.log(`Source: ${sqlitePath}`);
    console.log(`Tickets: ${tickets.length}`);
    console.log(`Ticket events: ${ticketEvents.length}`);
    console.log(`Outbox events: ${outboxEvents.length}`);
    console.log(`Source ticket fingerprint: ${digest(ticketSnapshots)}`);
    console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
    console.log('');

    const client = new Client({
      connectionString: requireDatabaseUrl(),
      application_name: 'supportforge-sqlite-postgres-migration',
    });

    await client.connect();

    try {
      await migratePostgres();

      /*
       * Hold the same advisory lock used by schema migration while checking
       * and copying target data. The runtime remains on SQLite until cutover,
       * so this lock is an additional guard against accidental concurrent
       * PostgreSQL migration jobs.
       */
      await client.query(
        'SELECT pg_advisory_lock($1::bigint)',
        [POSTGRES_MIGRATION_LOCK_KEY],
      );

      try {
        const existingTickets = await targetCount(client, 'tickets');
        const existingEvents = await targetCount(client, 'ticket_events');
        const existingOutbox = await targetCount(client, 'outbox_events');

        console.log(
          `Target currently contains tickets=${existingTickets}, events=${existingEvents}, outbox=${existingOutbox}.`,
        );

        if (
          existingTickets !== 0 ||
          existingEvents !== 0 ||
          existingOutbox !== 0
        ) {
          throw new Error(
            'Target PostgreSQL tables are not empty. Migration refuses to merge or overwrite existing data.',
          );
        }

        if (!apply) {
          console.log(
            '✅ Dry run completed. No SQLite or PostgreSQL data was modified.',
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
                jsonArray(ticket.claimed_by_json ?? '[]'),
                jsonArray(ticket.participant_ids_json ?? '[]'),
                JSON.stringify(jsonObject(ticket.metadata_json ?? '{}')),
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
                stringOrNull(event.id),
                stringOrNull(event.ticket_id),
                stringOrNull(event.guild_id) ?? 'unknown',
                stringOrNull(event.channel_id) ?? '',
                stringOrNull(event.event_type) ?? 'ticket.metadata_changed',
                stringOrNull(event.actor_id) ?? 'supportforge-system',
                stringOrNull(event.actor_attribution) ?? 'actorUnknown',
                stringOrNull(event.actor_confidence) ?? 'none',
                JSON.stringify(jsonObject(event.payload_json ?? '{}')),
                stringOrNull(event.created_at) ?? new Date().toISOString(),
              ],
            );
          }

          for (const outbox of outboxEvents) {
            const sourceStatus = stringOrNull(outbox.status) ?? 'pending';
            const targetStatus =
              sourceStatus === 'processing'
                ? 'pending'
                : sourceStatus;

            await client.query(
              'INSERT INTO outbox_events (' +
                'id, aggregate_type, aggregate_id, guild_id, event_type, payload, status, attempts, available_at, created_at, processed_at, processing_started_at, last_error' +
                ') VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz, NULL, $12)',
              [
                stringOrNull(outbox.id),
                stringOrNull(outbox.aggregate_type) ?? 'ticket',
                stringOrNull(outbox.aggregate_id),
                stringOrNull(outbox.guild_id) ?? 'unknown',
                stringOrNull(outbox.event_type) ?? 'ticket.metadata_changed',
                JSON.stringify(jsonObject(outbox.payload_json ?? '{}')),
                targetStatus,
                Math.max(0, Number(outbox.attempts ?? 0)),
                stringOrNull(outbox.available_at) ?? new Date().toISOString(),
                stringOrNull(outbox.created_at) ?? new Date().toISOString(),
                targetStatus === 'published'
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
              `Migration verification failed inside transaction. Target tickets=${migratedTickets}, events=${migratedEvents}, outbox=${migratedOutbox}; source tickets=${tickets.length}, events=${ticketEvents.length}, outbox=${outboxEvents.length}.`,
            );
          }

          const targetTicketRows = await client.query<QueryResultRow>(
            'SELECT id, guild_id, channel_id, status, ticket_number, department_id, tag_id, owner_id, priority, claimed_by_ids, participant_ids, metadata, created_at, updated_at, deleted_at, deletion_reason FROM tickets ORDER BY created_at ASC, id ASC',
          );
          const targetEventIds = await client.query<QueryResultRow>(
            'SELECT id FROM ticket_events ORDER BY created_at ASC, id ASC',
          );
          const targetOutboxIds = await client.query<QueryResultRow>(
            'SELECT id FROM outbox_events ORDER BY created_at ASC, id ASC',
          );

          const targetTicketSnapshots = targetTicketRows.rows.map(
            rowPostgresTicketSnapshot,
          );
          const sourceEventIds = ticketEvents.map((row) =>
            requireNonEmpty(stringOrNull(row.id), 'ticket_events.id'),
          );
          const sourceOutboxIds = outboxEvents.map((row) =>
            requireNonEmpty(stringOrNull(row.id), 'outbox_events.id'),
          );

          const targetIds = {
            events: targetEventIds.rows.map((row) => String(row.id)),
            outbox: targetOutboxIds.rows.map((row) => String(row.id)),
          };

          if (digest(ticketSnapshots) !== digest(targetTicketSnapshots)) {
            throw new Error(
              'Ticket content verification failed. The migrated ticket records do not exactly match the source snapshot.',
            );
          }
          if (digest(sourceEventIds) !== digest(targetIds.events)) {
            throw new Error('Ticket event ID verification failed.');
          }
          if (digest(sourceOutboxIds) !== digest(targetIds.outbox)) {
            throw new Error('Outbox ID verification failed.');
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
          console.log(`Verified ticket fingerprint: ${digest(targetTicketSnapshots)}`);
          console.log('✅ Ticket/event/outbox IDs verified.');
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
        await client.query(
          'SELECT pg_advisory_unlock($1::bigint)',
          [POSTGRES_MIGRATION_LOCK_KEY],
        ).catch(() => undefined);
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
