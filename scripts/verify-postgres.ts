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
    'knowledge_base_articles',
    'knowledge_base_article_revisions',
    'knowledge_base_synonyms',
    'knowledge_base_usage',
    'knowledge_base_article_feedback',
    'quick_replies',
    'quick_reply_revisions',
    'workflow_templates',
    'workflow_template_revisions',
    'related_ticket_links',
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
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM knowledge_base_articles'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM knowledge_base_article_revisions'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM knowledge_base_synonyms'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM knowledge_base_usage'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM knowledge_base_article_feedback'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM quick_replies'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM quick_reply_revisions'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM workflow_templates'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM workflow_template_revisions'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM related_ticket_links'),
  ]);

  // Exercise the database-maintained full-text index inside a transaction so
  // CI verifies inserts and edits without leaving synthetic article data behind.
  const verificationClient = await pool.connect();
  try {
    await verificationClient.query('BEGIN');
    await verificationClient.query(
      'INSERT INTO knowledge_base_articles ' +
        '(id,guild_id,slug,title,summary,body,category,tags,status,visibility,allowed_role_ids,created_by,updated_by) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'published','public',$9,$10,$10)",
      [
        'resolvx-postgres-verification-article',
        'resolvx-postgres-verification',
        'knowledge-search-verification',
        'Knowledge Search Verification',
        'Verifying full-text search',
        'This synthetic article verifies searchable PostgreSQL content.',
        'Verification',
        ['knowledge', 'verification'],
        [],
        'resolvx-verification',
      ],
    );
    const insertedSearch = await verificationClient.query<{ matched: boolean }>(
      "SELECT search_vector @@ plainto_tsquery('english','knowledge verification') AS matched " +
        'FROM knowledge_base_articles WHERE id=$1',
      ['resolvx-postgres-verification-article'],
    );
    if (!insertedSearch.rows[0]?.matched) {
      throw new Error('Knowledge Base full-text trigger did not index a newly inserted article.');
    }
    await verificationClient.query(
      "UPDATE knowledge_base_articles SET title=$2,body=$3 WHERE id=$1",
      ['resolvx-postgres-verification-article', 'Updated Refund Verification', 'Updated searchable body'],
    );
    const updatedSearch = await verificationClient.query<{ matched: boolean }>(
      "SELECT search_vector @@ plainto_tsquery('english','refund verification') AS matched " +
        'FROM knowledge_base_articles WHERE id=$1',
      ['resolvx-postgres-verification-article'],
    );
    if (!updatedSearch.rows[0]?.matched) {
      throw new Error('Knowledge Base full-text trigger did not refresh the index after an article edit.');
    }
    await verificationClient.query('ROLLBACK');
  } catch (error) {
    await verificationClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    verificationClient.release();
  }

  const orphanEvents = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM ticket_events e LEFT JOIN tickets t ON t.id = e.ticket_id WHERE t.id IS NULL',
  );

  const orphanOutbox = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM outbox_events o LEFT JOIN tickets t ON t.id = o.aggregate_id WHERE t.id IS NULL',
  );

  const orphanProductivityRevisions = await pool.query<{ count: string }>(
    'SELECT ' +
      '(SELECT COUNT(*) FROM knowledge_base_article_revisions r LEFT JOIN knowledge_base_articles a ON a.id=r.article_id WHERE a.id IS NULL) + ' +
      '(SELECT COUNT(*) FROM quick_reply_revisions r LEFT JOIN quick_replies q ON q.id=r.quick_reply_id WHERE q.id IS NULL) + ' +
      '(SELECT COUNT(*) FROM workflow_template_revisions r LEFT JOIN workflow_templates w ON w.id=r.template_id WHERE w.id IS NULL) AS count',
  );

  const invalidProcessing = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM outbox_events WHERE status = 'processing' AND (processing_started_at IS NULL OR processing_started_at < NOW() - INTERVAL '10 minutes')",
  );

  if (
    Number(orphanEvents.rows[0]?.count ?? 0) !== 0 ||
    Number(orphanOutbox.rows[0]?.count ?? 0) !== 0 ||
    Number(orphanProductivityRevisions.rows[0]?.count ?? 0) !== 0 ||
    Number(invalidProcessing.rows[0]?.count ?? 0) !== 0
  ) {
    throw new Error('PostgreSQL verification found orphaned ticket events/outbox/history records or stale processing leases.');
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
  console.log(`Knowledge Base articles: ${counts[7].rows[0]?.count ?? '0'}`);
  console.log(`Knowledge Base revisions: ${counts[8].rows[0]?.count ?? '0'}`);
  console.log(`Knowledge synonyms/usage/feedback: ${counts[9].rows[0]?.count ?? '0'}/${counts[10].rows[0]?.count ?? '0'}/${counts[11].rows[0]?.count ?? '0'}`);
  console.log(`Quick replies/revisions: ${counts[12].rows[0]?.count ?? '0'}/${counts[13].rows[0]?.count ?? '0'}`);
  console.log(`Workflow templates/revisions: ${counts[14].rows[0]?.count ?? '0'}/${counts[15].rows[0]?.count ?? '0'}`);
  console.log(`Related ticket links: ${counts[16].rows[0]?.count ?? '0'}`);
  console.log(`Orphan events: ${orphanEvents.rows[0]?.count ?? '0'}`);
  console.log(`Orphan outbox records: ${orphanOutbox.rows[0]?.count ?? '0'}`);
  console.log(`Orphan productivity revision records: ${orphanProductivityRevisions.rows[0]?.count ?? '0'}`);
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
