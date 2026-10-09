import type { TransactionExecutor } from './database';

interface PostgresMigration {
  id: number;
  name: string;
  up: (db: TransactionExecutor) => Promise<void>;
}

const MIGRATIONS: readonly PostgresMigration[] = [
  {
    id: 1,
    name: 'create_core_ticket_tables',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS tickets (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL UNIQUE,
          ticket_number TEXT,
          status TEXT NOT NULL CHECK (
            status IN ('open', 'claimed', 'pending', 'reopened', 'closed', 'archived')
          ),
          department_id TEXT,
          tag_id TEXT,
          owner_id TEXT,
          priority TEXT,
          claimed_by_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          participant_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          deleted_at TIMESTAMPTZ,
          deletion_reason TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_tickets_guild_status
          ON tickets (guild_id, status);
        CREATE INDEX IF NOT EXISTS idx_tickets_guild_ticket_number
          ON tickets (guild_id, ticket_number);
        CREATE INDEX IF NOT EXISTS idx_tickets_guild_owner
          ON tickets (guild_id, owner_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_department
          ON tickets (guild_id, department_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_tag
          ON tickets (guild_id, tag_id);
      `);
    },
  },
  {
    id: 2,
    name: 'create_domain_events',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ticket_events (
          id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK (
            event_type IN (
              'ticket.created',
              'ticket.status_changed',
              'ticket.metadata_changed',
              'ticket.deleted'
            )
          ),
          actor_id TEXT NOT NULL,
          actor_attribution TEXT NOT NULL CHECK (
            actor_attribution IN ('actorKnown', 'actorInferred', 'actorUnknown')
          ),
          actor_confidence TEXT NOT NULL CHECK (
            actor_confidence IN ('high', 'low', 'none')
          ),
          payload JSONB NOT NULL DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_created
          ON ticket_events (ticket_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_ticket_events_guild_created
          ON ticket_events (guild_id, created_at);
      `);
    },
  },
  {
    id: 3,
    name: 'create_outbox',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS outbox_events (
          id TEXT PRIMARY KEY,
          aggregate_type TEXT NOT NULL CHECK (aggregate_type = 'ticket'),
          aggregate_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          guild_id TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK (
            event_type IN (
              'ticket.created',
              'ticket.status_changed',
              'ticket.metadata_changed',
              'ticket.deleted'
            )
          ),
          payload JSONB NOT NULL DEFAULT '{}'::JSONB,
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'processing', 'published', 'failed')
          ),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          available_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          processed_at TIMESTAMPTZ,
          processing_started_at TIMESTAMPTZ,
          last_error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_outbox_pending
          ON outbox_events (status, available_at, created_at)
          WHERE status IN ('pending', 'failed');

        CREATE INDEX IF NOT EXISTS idx_outbox_processing
          ON outbox_events (status, processing_started_at)
          WHERE status = 'processing';

        CREATE INDEX IF NOT EXISTS idx_outbox_aggregate
          ON outbox_events (aggregate_type, aggregate_id, created_at);
      `);
    },
  },
];

export async function runPostgresMigrations(
  db: TransactionExecutor,
): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = await db.query<{ id: number }>(
    'SELECT id FROM schema_migrations ORDER BY id ASC',
  );
  const appliedIds = new Set(applied.rows.map((row) => Number(row.id)));

  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) continue;

    await db.query('BEGIN');

    try {
      await migration.up(db);

      await db.query(
        'INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, NOW())',
        [migration.id, migration.name],
      );

      await db.query('COMMIT');
    } catch (error) {
      try {
        await db.query('ROLLBACK');
      } catch {
        // Preserve the original migration failure.
      }

      throw new Error(
        `SupportForge PostgreSQL migration ${migration.id} (${migration.name}) failed. The migration marker was not recorded.`,
        { cause: error },
      );
    }
  }
}
