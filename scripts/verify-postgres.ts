import 'dotenv/config';

import { migratePostgres } from '../src/core/persistence/migrationRunner';
import { getPostgresPool, closePostgresDatabase } from '../src/core/persistence/postgresDatabase';

async function main(): Promise<void> {
  await migratePostgres();

  const pool = getPostgresPool();

  const requiredTables = [
    'schema_migrations',
    'tickets',
    'ticket_events',
    'outbox_events',
    'app_documents',
    'support_sla_policies',
    'support_csat_responses',
    'support_sla_alerts',
    'ticket_recovery_replay_segments',
  ];

  for (const table of requiredTables) {
    const result = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [`public.${table}`],
    );

    if (!result.rows[0]?.exists) {
      throw new Error(`Required PostgreSQL table is missing: ${table}`);
    }
  }

  const counts = await Promise.all([
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM tickets'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM ticket_events'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM outbox_events'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM app_documents'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM support_sla_policies'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM support_csat_responses'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM support_sla_alerts'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM ticket_recovery_replay_segments'),
  ]);

  const orphanEvents = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM ticket_events e LEFT JOIN tickets t ON t.id = e.ticket_id WHERE t.id IS NULL',
  );

  const orphanOutbox = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM outbox_events o LEFT JOIN tickets t ON t.id = o.aggregate_id WHERE t.id IS NULL',
  );

  const invalidProcessing = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM outbox_events WHERE status = 'processing' AND (processing_started_at IS NULL OR processing_started_at < NOW() - INTERVAL '10 minutes')",
  );

  if (
    Number(orphanEvents.rows[0]?.count ?? 0) !== 0 ||
    Number(orphanOutbox.rows[0]?.count ?? 0) !== 0 ||
    Number(invalidProcessing.rows[0]?.count ?? 0) !== 0
  ) {
    throw new Error('PostgreSQL verification found orphaned ticket events/outbox records or stale processing leases.');
  }

  console.log('────────────────────────────────────────────');
  console.log('ResolvX PostgreSQL verification');
  console.log('────────────────────────────────────────────');
  console.log(`Tickets: ${counts[0].rows[0]?.count ?? '0'}`);
  console.log(`Ticket events: ${counts[1].rows[0]?.count ?? '0'}`);
  console.log(`Outbox events: ${counts[2].rows[0]?.count ?? '0'}`);
  console.log(`Application documents: ${counts[3].rows[0]?.count ?? '0'}`);
  console.log(`SLA policies: ${counts[4].rows[0]?.count ?? '0'}`);
  console.log(`CSAT responses: ${counts[5].rows[0]?.count ?? '0'}`);
  console.log(`SLA alert records: ${counts[6].rows[0]?.count ?? '0'}`);
  console.log(`Recovery replay segments: ${counts[7].rows[0]?.count ?? '0'}`);
  console.log(`Orphan events: ${orphanEvents.rows[0]?.count ?? '0'}`);
  console.log(`Orphan outbox records: ${orphanOutbox.rows[0]?.count ?? '0'}`);
  console.log(`Stale processing records: ${invalidProcessing.rows[0]?.count ?? '0'}`);
  console.log('✅ Required tables, referential integrity, and active outbox lease state verified.');
}

main()
  .catch((error) => {
    console.error('❌ PostgreSQL verification failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePostgresDatabase();
  });
