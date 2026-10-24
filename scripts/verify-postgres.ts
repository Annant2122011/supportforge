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

    'knowledge_base_articles',
    'knowledge_base_article_revisions',
    'knowledge_base_synonyms',
    'knowledge_base_usage',
    'knowledge_base_feedback',
    'quick_reply_templates',
    'quick_reply_usage',
    'quick_reply_template_revisions',
    'related_ticket_links',  ];

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

    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM knowledge_base_articles'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM knowledge_base_article_revisions'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM knowledge_base_synonyms'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM knowledge_base_feedback'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM quick_reply_templates'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM quick_reply_template_revisions'),  ]);

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
  console.log(`Knowledge articles: ${counts[8].rows[0]?.count ?? '0'}`);
  console.log(`Knowledge revisions: ${counts[9].rows[0]?.count ?? '0'}`);
  console.log(`Knowledge synonyms: ${counts[10].rows[0]?.count ?? '0'}`);
  console.log(`Knowledge feedback: ${counts[11].rows[0]?.count ?? '0'}`);
  console.log(`Quick replies: ${counts[12].rows[0]?.count ?? '0'}`);
  console.log(`Quick reply revisions: ${counts[13].rows[0]?.count ?? '0'}`);
  const relatedLinks = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM related_ticket_links');
  console.log(`Related-ticket links: ${relatedLinks.rows[0]?.count ?? '0'}`);
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
