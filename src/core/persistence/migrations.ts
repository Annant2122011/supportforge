import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SqliteDatabase } from './sqliteDatabase';

interface Migration {
  id: number;
  name: string;
  up: (db: SqliteDatabase, legacyTicketsPath: string) => void;
}

interface LegacyTicket {
  guildId?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  ticketNumber?: unknown;
  departmentId?: unknown;
  tagId?: unknown;
  ownerId?: unknown;
  priority?: unknown;
  claimedByIds?: unknown;
  participantIds?: unknown;
  metadata?: unknown;
  deletedAt?: unknown;
  deletionReason?: unknown;
}

interface LegacyTicketState {
  version?: unknown;
  tickets?: Record<string, LegacyTicket | null>;
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
      if (!existsSync(legacyTicketsPath)) return;

      const raw = readFileSync(legacyTicketsPath, 'utf8');
      let parsed: LegacyTicketState;

      try {
        parsed = JSON.parse(raw) as LegacyTicketState;
      } catch (error) {
        throw new Error(
          'SupportForge could not migrate data/tickets.json because the legacy file is invalid JSON. The file was not modified.',
          { cause: error },
        );
      }

      if (
        !parsed.tickets ||
        typeof parsed.tickets !== 'object' ||
        Array.isArray(parsed.tickets)
      ) {
        throw new Error(
          'SupportForge could not migrate data/tickets.json because its tickets collection is malformed. The file was not modified.',
        );
      }

      /*
       * Validate the complete source before touching either the database or
       * the legacy file. The backup is intentionally retained even if the DB
       * transaction later fails, because recovery is preferable to cleanup.
       */
      const backupPath =
        legacyTicketsPath + '.pre-sqlite-' + Date.now() + '.backup';
      copyFileSync(legacyTicketsPath, backupPath);

      const stringOrNull = (value: unknown): string | null =>
        typeof value === 'string' && value.trim() ? value : null;

      const stringArray = (value: unknown): string[] =>
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : [];

      const metadataObject = (value: unknown): Record<string, unknown> =>
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
          ? value as Record<string, unknown>
          : {};

      const insert = db.prepare(
        'INSERT OR IGNORE INTO tickets (' +
        'id, guild_id, channel_id, ticket_number, status, department_id, tag_id, owner_id, priority, ' +
        'claimed_by_json, participant_ids_json, metadata_json, created_at, updated_at, deleted_at, deletion_reason' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      for (const [channelId, rawTicket] of Object.entries(parsed.tickets)) {
        const ticket = rawTicket ?? {};
        const now = new Date().toISOString();
        const status =
          ticket.status === 'claimed' ||
          ticket.status === 'pending' ||
          ticket.status === 'reopened' ||
          ticket.status === 'closed' ||
          ticket.status === 'archived'
            ? ticket.status
            : 'open';

        insert.run(
          'legacy:' + channelId,
          stringOrNull(ticket.guildId) ?? 'unknown',
          channelId,
          stringOrNull(ticket.ticketNumber),
          status,
          stringOrNull(ticket.departmentId),
          stringOrNull(ticket.tagId),
          stringOrNull(ticket.ownerId),
          stringOrNull(ticket.priority),
          JSON.stringify(stringArray(ticket.claimedByIds)),
          JSON.stringify(stringArray(ticket.participantIds)),
          JSON.stringify(metadataObject(ticket.metadata)),
          stringOrNull(ticket.createdAt) ?? now,
          stringOrNull(ticket.updatedAt) ?? now,
          stringOrNull(ticket.deletedAt),
          stringOrNull(ticket.deletionReason),
        );
      }
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
        'SupportForge database migration ' +
          migration.id +
          ' (' +
          migration.name +
          ') failed. No migration marker was recorded.',
        { cause: error },
      );
    }
  }
}
