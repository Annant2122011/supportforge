import 'dotenv/config';

import { migratePostgres } from '../src/core/persistence/migrationRunner';
import { getPostgresPool, closePostgresDatabase } from '../src/core/persistence/postgresDatabase';
import { PostgresAnalyticsRepository } from '../src/repositories/postgresAnalyticsRepository';
import { PostgresAdvancedAnalyticsRepository } from '../src/repositories/postgresAdvancedAnalyticsRepository';

async function main(): Promise<void> {
  await migratePostgres();

  const pool = getPostgresPool();

  const requiredTables = [
    'schema_migrations',
    'tickets',
    'ticket_events',
    'outbox_events',
    'app_documents',
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

  // Smoke-test every analytics query against PostgreSQL itself, not just a mock
  // executor. A CI run must prove the SQL parses against the migrated schema.
  // Use a dedicated synthetic guild key and perform reads only.
  const analyticsGuildId = 'supportforge-stage-k-analytics-verification';
  const analyticsEnd = new Date();
  const analyticsStart = new Date(analyticsEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startAt = analyticsStart.toISOString();
  const endAt = analyticsEnd.toISOString();
  const filters = {
    departmentId: 'verification-department',
    tagId: 'verification-tag',
    priority: 'urgent' as const,
    status: 'open' as const,
  };
  const baseAnalytics = new PostgresAnalyticsRepository(pool);
  const advancedAnalytics = new PostgresAdvancedAnalyticsRepository(pool);
  await Promise.all([
    baseAnalytics.getGuildRollup(analyticsGuildId, startAt, endAt, filters),
    advancedAnalytics.getDepartmentBreakdown(analyticsGuildId, startAt, endAt, filters),
    advancedAnalytics.getStaffBreakdown(analyticsGuildId, startAt, endAt, filters),
    advancedAnalytics.getTagBreakdown(analyticsGuildId, startAt, endAt, filters),
    advancedAnalytics.getDailyTrends(analyticsGuildId, startAt, endAt, filters),
    advancedAnalytics.getDataCoverage(analyticsGuildId, startAt, endAt, filters),
  ]);

  console.log('────────────────────────────────────────────');
  console.log('ResolvX PostgreSQL verification');
  console.log('────────────────────────────────────────────');
  console.log(`Tickets: ${counts[0].rows[0]?.count ?? '0'}`);
  console.log(`Ticket events: ${counts[1].rows[0]?.count ?? '0'}`);
  console.log(`Outbox events: ${counts[2].rows[0]?.count ?? '0'}`);
  console.log(`Application documents: ${counts[3].rows[0]?.count ?? '0'}`);
  console.log(`Orphan events: ${orphanEvents.rows[0]?.count ?? '0'}`);
  console.log(`Orphan outbox records: ${orphanOutbox.rows[0]?.count ?? '0'}`);
  console.log(`Stale processing records: ${invalidProcessing.rows[0]?.count ?? '0'}`);
  console.log('Analytics query smoke tests: 6 passed against PostgreSQL.');
  console.log('✅ Required tables, referential integrity, active outbox lease state, and analytics SQL verified.');
}

main()
  .catch((error) => {
    console.error('❌ PostgreSQL verification failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePostgresDatabase();
  });
