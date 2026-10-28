import { join } from 'node:path';
import { readLegacyTicketJson } from './legacyTicketData';

import type { SqliteDatabase } from './sqliteDatabase';

interface Migration {
  id: number;
  name: string;
  up: (db: SqliteDatabase, legacyTicketsPath: string) => void;
}

const DATA_DIR = join(process.cwd(), 'data');
const LEGACY_TICKETS_PATH = join(DATA_DIR, 'tickets.json');

const migrations: readonly Migration[] = [
  {
    id: 1,
    name: 'create_core_ticket_tables',
    up: (db) => {
      db.exec(
        'CREATE TABLE IF NOT EXISTS tickets (' +
        'id TEXT PRIMARY KEY, ' +
        'guild_id TEXT NOT NULL, ' +
        'channel_id TEXT NOT NULL UNIQUE, ' +
        'ticket_number TEXT, ' +
        "status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'pending', 'reopened', 'closed', 'archived')), " +
        'department_id TEXT, ' +
        'tag_id TEXT, ' +
        'owner_id TEXT, ' +
        'priority TEXT, ' +
        "claimed_by_json TEXT NOT NULL DEFAULT '[]', " +
        "participant_ids_json TEXT NOT NULL DEFAULT '[]', " +
        "metadata_json TEXT NOT NULL DEFAULT '{}', " +
        'created_at TEXT NOT NULL, ' +
        'updated_at TEXT NOT NULL, ' +
        'deleted_at TEXT, ' +
        'deletion_reason TEXT' +
        ') STRICT; ' +
        'CREATE INDEX IF NOT EXISTS idx_tickets_guild_status ON tickets(guild_id, status); ' +
        'CREATE INDEX IF NOT EXISTS idx_tickets_guild_ticket_number ON tickets(guild_id, ticket_number); ' +
        'CREATE INDEX IF NOT EXISTS idx_tickets_guild_owner ON tickets(guild_id, owner_id); ' +
        'CREATE INDEX IF NOT EXISTS idx_tickets_department ON tickets(guild_id, department_id); ' +
        'CREATE INDEX IF NOT EXISTS idx_tickets_tag ON tickets(guild_id, tag_id);'
      );
    },
  },
  {
    id: 2,
    name: 'import_legacy_ticket_json',
    up: (db, legacyTicketsPath) => {
      const records = readLegacyTicketJson(legacyTicketsPath);
      if (!records) return;

      const insert = db.prepare(
        'INSERT OR IGNORE INTO tickets (' +
        'id, guild_id, channel_id, ticket_number, status, department_id, tag_id, owner_id, priority, ' +
        'claimed_by_json, participant_ids_json, metadata_json, created_at, updated_at, deleted_at, deletion_reason' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      for (const ticket of records) {
        const result = insert.run(
          ticket.id,
          ticket.guildId,
          ticket.channelId,
          ticket.ticketNumber,
          ticket.status,
          ticket.departmentId,
          ticket.tagId,
          ticket.ownerId,
          ticket.priority,
          JSON.stringify(ticket.claimedByIds),
          JSON.stringify(ticket.participantIds),
          JSON.stringify(ticket.metadata),
          ticket.createdAt,
          ticket.updatedAt,
          ticket.deletedAt,
          ticket.deletionReason,
        );

        if (Number(result.changes) === 0) {
          const existing = db.prepare(
            'SELECT id, guild_id, channel_id FROM tickets WHERE channel_id = ?',
          ).get(ticket.channelId);

          if (
            !existing ||
            existing.id !== ticket.id ||
            existing.guild_id !== ticket.guildId
          ) {
            throw new Error(
              'Legacy ticket ' + ticket.channelId +
                ' conflicts with an existing database record. The migration refused to overwrite it.',
            );
          }
        }
      }
    },
  },
  {
    id: 3,
    name: 'create_domain_events_and_outbox',
    up: (db) => {
      db.exec(
        'CREATE TABLE IF NOT EXISTS ticket_events (' +
        'id TEXT PRIMARY KEY, ' +
        'ticket_id TEXT NOT NULL, ' +
        'guild_id TEXT NOT NULL, ' +
        'channel_id TEXT NOT NULL, ' +
        'event_type TEXT NOT NULL, ' +
        'actor_id TEXT NOT NULL, ' +
        "actor_attribution TEXT NOT NULL CHECK (actor_attribution IN ('actorKnown', 'actorInferred', 'actorUnknown')), " +
        "actor_confidence TEXT NOT NULL CHECK (actor_confidence IN ('high', 'low', 'none')), " +
        "payload_json TEXT NOT NULL DEFAULT '{}', " +
        'created_at TEXT NOT NULL' +
        ') STRICT; ' +
        'CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_created ON ticket_events(ticket_id, created_at); ' +
        'CREATE INDEX IF NOT EXISTS idx_ticket_events_guild_created ON ticket_events(guild_id, created_at); ' +
        'CREATE TABLE IF NOT EXISTS outbox_events (' +
        'id TEXT PRIMARY KEY, ' +
        'aggregate_type TEXT NOT NULL, ' +
        'aggregate_id TEXT NOT NULL, ' +
        'guild_id TEXT NOT NULL, ' +
        'event_type TEXT NOT NULL, ' +
        "payload_json TEXT NOT NULL DEFAULT '{}', " +
        "status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'published', 'failed')), " +
        'attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), ' +
        'available_at TEXT NOT NULL, ' +
        'created_at TEXT NOT NULL, ' +
        'processed_at TEXT, ' +
        'last_error TEXT' +
        ') STRICT; ' +
        'CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, available_at, created_at); ' +
        'CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox_events(aggregate_type, aggregate_id, created_at);'
      );
    },
  },
  {
    id: 4,
    name: 'add_document_storage_and_outbox_processing_lease',
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(outbox_events)').all();
      if (!columns.some((column) => column.name === 'processing_started_at')) {
        db.exec('ALTER TABLE outbox_events ADD COLUMN processing_started_at TEXT');
      }

      db.exec(
        'CREATE TABLE IF NOT EXISTS app_documents (' +
        'document_key TEXT PRIMARY KEY, ' +
        'payload_json TEXT NOT NULL, ' +
        'updated_at TEXT NOT NULL' +
        ') STRICT; ' +
        'CREATE INDEX IF NOT EXISTS idx_app_documents_updated_at ON app_documents(updated_at);'
      );
    },
  },
];

export function runMigrations(
  db: SqliteDatabase,
  legacyTicketsPath = LEGACY_TICKETS_PATH,
): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
    'id INTEGER PRIMARY KEY, ' +
    'name TEXT NOT NULL, ' +
    'applied_at TEXT NOT NULL' +
    ') STRICT;'
  );

  const appliedRows = db
    .prepare('SELECT id FROM schema_migrations ORDER BY id ASC')
    .all();

  const appliedIds = new Set(
    appliedRows
      .map((row) => Number(row.id))
      .filter((id) => Number.isInteger(id)),
  );

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) continue;

    db.exec('BEGIN IMMEDIATE');

    try {
      migration.up(db, legacyTicketsPath);

      db.prepare(
        'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
      ).run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );

      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve migration failure.
      }

      throw new Error(
        'QueryFixr database migration ' +
          migration.id +
          ' (' +
          migration.name +
          ') failed. No migration marker was recorded.',
        { cause: error },
      );
    }
  }
}
