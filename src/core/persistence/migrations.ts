import { randomUUID } from 'node:crypto';
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

      // Preserve the source before parsing or normalizing anything, including
      // malformed input. Failed migrations leave this backup and original file.
      const backupPath =
        legacyTicketsPath + '.pre-sqlite-' + Date.now() + '-' + randomUUID() + '.backup';
      copyFileSync(legacyTicketsPath, backupPath);

      let source: unknown;
      try {
        source = JSON.parse(readFileSync(legacyTicketsPath, 'utf8')) as unknown;
      } catch (error) {
        throw new Error(
          'SupportForge could not migrate data/tickets.json because the legacy file is invalid JSON. The original file and its backup were preserved.',
          { cause: error },
        );
      }

      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new Error(
          'SupportForge could not migrate data/tickets.json because the root must be a JSON object.',
        );
      }

      const parsed = source as LegacyTicketState;
      if (parsed.version !== undefined && parsed.version !== 1) {
        throw new Error(
          'SupportForge cannot migrate data/tickets.json version ' +
            String(parsed.version) +
            '. Only legacy version 1 is supported by this migration.',
        );
      }

      if (
        !parsed.tickets ||
        typeof parsed.tickets !== 'object' ||
        Array.isArray(parsed.tickets)
      ) {
        throw new Error(
          'SupportForge could not migrate data/tickets.json because its tickets collection is malformed. The original file and its backup were preserved.',
        );
      }

      const optionalString = (
        value: unknown,
        field: string,
        channelId: string,
      ): string | null => {
        if (value === undefined || value === null || value === '') return null;
        if (typeof value !== 'string') {
          throw new Error(
            'Legacy ticket ' + channelId + ' has a non-string ' + field + '. No data was imported.',
          );
        }
        return value;
      };

      const requiredTimestamp = (
        value: unknown,
        field: string,
        channelId: string,
      ): string => {
        if (typeof value !== 'string' || !value.trim() || Number.isNaN(new Date(value).getTime())) {
          throw new Error(
            'Legacy ticket ' + channelId + ' has a missing or invalid ' + field + '. No data was imported.',
          );
        }
        return value;
      };

      const stringArray = (
        value: unknown,
        field: string,
        channelId: string,
      ): string[] => {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
          throw new Error(
            'Legacy ticket ' + channelId + ' has a malformed ' + field + '. No data was imported.',
          );
        }
        return value as string[];
      };

      const metadataObject = (
        value: unknown,
        channelId: string,
      ): Record<string, unknown> => {
        if (value === undefined || value === null) return {};
        if (typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(
            'Legacy ticket ' + channelId + ' has malformed metadata. No data was imported.',
          );
        }
        return value as Record<string, unknown>;
      };

      const supportedStatuses = new Set([
        'open',
        'claimed',
        'pending',
        'reopened',
        'closed',
        'archived',
      ]);

      const insert = db.prepare(
        'INSERT OR IGNORE INTO tickets (' +
        'id, guild_id, channel_id, ticket_number, status, department_id, tag_id, owner_id, priority, ' +
        'claimed_by_json, participant_ids_json, metadata_json, created_at, updated_at, deleted_at, deletion_reason' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      for (const [channelId, rawTicket] of Object.entries(parsed.tickets)) {
        if (!channelId.trim()) {
          throw new Error('Legacy ticket collection contains an empty channel ID.');
        }
        if (!rawTicket || typeof rawTicket !== 'object' || Array.isArray(rawTicket)) {
          throw new Error(
            'Legacy ticket ' + channelId + ' is not a JSON object. No data was imported.',
          );
        }

        const ticket = rawTicket as LegacyTicket;
        const guildId = optionalString(ticket.guildId, 'guildId', channelId);
        if (!guildId) {
          throw new Error(
            'Legacy ticket ' + channelId + ' is missing guildId. No data was imported.',
          );
        }

        if (typeof ticket.status !== 'string' || !supportedStatuses.has(ticket.status)) {
          throw new Error(
            'Legacy ticket ' + channelId + ' has unsupported or missing status: ' +
              String(ticket.status) + '. No data was imported.',
          );
        }

        const ticketNumber = optionalString(ticket.ticketNumber, 'ticketNumber', channelId);
        const departmentId = optionalString(ticket.departmentId, 'departmentId', channelId);
        const tagId = optionalString(ticket.tagId, 'tagId', channelId);
        const ownerId = optionalString(ticket.ownerId, 'ownerId', channelId);
        const priority = optionalString(ticket.priority, 'priority', channelId);
        const claimedByIds = stringArray(ticket.claimedByIds, 'claimedByIds', channelId);
        const participantIds = stringArray(ticket.participantIds, 'participantIds', channelId);
        const metadata = metadataObject(ticket.metadata, channelId);
        const createdAt = requiredTimestamp(ticket.createdAt, 'createdAt', channelId);
        const updatedAt = requiredTimestamp(ticket.updatedAt, 'updatedAt', channelId);
        const deletedAt = optionalString(ticket.deletedAt, 'deletedAt', channelId);
        const deletionReason = optionalString(ticket.deletionReason, 'deletionReason', channelId);

        if (deletedAt !== null && Number.isNaN(new Date(deletedAt).getTime())) {
          throw new Error('Legacy ticket ' + channelId + ' has an invalid deletedAt. No data was imported.');
        }

        const result = insert.run(
          'legacy:' + channelId,
          guildId,
          channelId,
          ticketNumber,
          ticket.status,
          departmentId,
          tagId,
          ownerId,
          priority,
          JSON.stringify(claimedByIds),
          JSON.stringify(participantIds),
          JSON.stringify(metadata),
          createdAt,
          updatedAt,
          deletedAt,
          deletionReason,
        );

        if (Number(result.changes) === 0) {
          const existing = db.prepare(
            'SELECT id, guild_id, channel_id FROM tickets WHERE channel_id = ?',
          ).get(channelId);
          if (
            !existing ||
            existing.id !== 'legacy:' + channelId ||
            existing.guild_id !== guildId
          ) {
            throw new Error(
              'Legacy ticket ' + channelId +
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
