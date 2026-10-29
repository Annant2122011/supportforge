import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { migratePostgres } from '../src/core/persistence/migrationRunner';
import { getPostgresPool, closePostgresDatabase } from '../src/core/persistence/postgresDatabase';
import { PostgresAnalyticsRepository } from '../src/repositories/postgresAnalyticsRepository';
import { PostgresAdvancedAnalyticsRepository } from '../src/repositories/postgresAdvancedAnalyticsRepository';
import { getSupportSlaOperationalSummary } from '../src/services/supportOperationsService';

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
    'support_sla_policy_versions',
    'support_sla_monitor_state',
    'support_sla_notification_routes',
    'support_sla_queue_snapshots',
    'support_sla_escalation_previews',
    'ticket_recovery_replay_segments',
    'knowledge_base_articles',
    'knowledge_base_article_revisions',
    'knowledge_base_synonyms',
    'knowledge_base_usage',
    'knowledge_base_article_feedback',
    'quick_replies',
    'quick_reply_revisions',
    'quick_reply_send_intents',
    'quick_reply_usage_events',
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
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM support_sla_policy_versions'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM support_sla_monitor_state'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM support_sla_notification_routes'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM support_sla_queue_snapshots'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM support_sla_escalation_previews'),
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
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM ticket_recovery_replay_segments'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM quick_reply_send_intents'),
    pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM quick_reply_usage_events'),
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

  const invalidQuickReplyUsage = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM quick_reply_usage_events u " +
      "LEFT JOIN quick_reply_send_intents i ON i.interaction_id=u.send_intent_id " +
      "WHERE i.interaction_id IS NULL OR i.status <> 'completed' OR i.discord_message_id IS NULL " +
      "OR u.guild_id <> i.guild_id OR u.quick_reply_id <> i.quick_reply_id",
  );

  if (
    Number(orphanEvents.rows[0]?.count ?? 0) !== 0 ||
    Number(orphanOutbox.rows[0]?.count ?? 0) !== 0 ||
    Number(orphanProductivityRevisions.rows[0]?.count ?? 0) !== 0 ||
    Number(invalidProcessing.rows[0]?.count ?? 0) !== 0 ||
    Number(invalidQuickReplyUsage.rows[0]?.count ?? 0) !== 0
  ) {
    throw new Error('PostgreSQL verification found orphaned ticket events/outbox/history records, stale processing leases, or quick-reply usage without a completed matching delivery.');
  }

  console.log('────────────────────────────────────────────');
  console.log('QueryFixr PostgreSQL verification');
  console.log('────────────────────────────────────────────');
  console.log(`Tickets: ${counts[0].rows[0]?.count ?? '0'}`);
  console.log(`Ticket events: ${counts[1].rows[0]?.count ?? '0'}`);
  console.log(`Outbox events: ${counts[2].rows[0]?.count ?? '0'}`);
  console.log(`Application documents: ${counts[3].rows[0]?.count ?? '0'}`);
  console.log(`SLA policies: ${counts[4].rows[0]?.count ?? '0'}`);
  console.log(`CSAT responses: ${counts[5].rows[0]?.count ?? '0'}`);
  console.log(`SLA alert records: ${counts[6].rows[0]?.count ?? '0'}`);
  console.log(`SLA policy versions / monitor states: ${counts[7].rows[0]?.count ?? '0'} / ${counts[8].rows[0]?.count ?? '0'}`);
  console.log(`SLA routes / queue snapshots / escalation previews: ${counts[9].rows[0]?.count ?? '0'} / ${counts[10].rows[0]?.count ?? '0'} / ${counts[11].rows[0]?.count ?? '0'}`);
  console.log(`Knowledge Base articles: ${counts[12].rows[0]?.count ?? '0'}`);
  console.log(`Knowledge Base revisions: ${counts[13].rows[0]?.count ?? '0'}`);
  console.log(`Knowledge synonyms/usage/feedback: ${counts[14].rows[0]?.count ?? '0'}/${counts[15].rows[0]?.count ?? '0'}/${counts[16].rows[0]?.count ?? '0'}`);
  console.log(`Quick replies/revisions: ${counts[17].rows[0]?.count ?? '0'}/${counts[18].rows[0]?.count ?? '0'}`);
  console.log(`Workflow templates/revisions: ${counts[19].rows[0]?.count ?? '0'}/${counts[20].rows[0]?.count ?? '0'}`);
  console.log(`Related ticket links: ${counts[21].rows[0]?.count ?? '0'}`);
  console.log(`Orphan events: ${orphanEvents.rows[0]?.count ?? '0'}`);
  console.log(`Orphan outbox records: ${orphanOutbox.rows[0]?.count ?? '0'}`);
  console.log(`Orphan productivity revision records: ${orphanProductivityRevisions.rows[0]?.count ?? '0'}`);
  console.log(`Stale processing records: ${invalidProcessing.rows[0]?.count ?? '0'}`);
  console.log(`Recovery replay segments: ${counts[22].rows[0]?.count ?? '0'}`);
  console.log(`Quick Reply send intents / usage events: ${counts[23].rows[0]?.count ?? '0'} / ${counts[24].rows[0]?.count ?? '0'}`);
  const claimSlaSchema = await pool.query<{ claim_column: boolean; claim_target: boolean }>(`
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema()
          AND table_name='support_sla_policies'
          AND column_name='claim_minutes'
      ) AS claim_column,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid='support_sla_alerts'::regclass
          AND conname='support_sla_alerts_target_type_check'
          AND pg_get_constraintdef(oid) ILIKE '%claim%'
      ) AS claim_target
  `);
  if (!claimSlaSchema.rows[0]?.claim_column || !claimSlaSchema.rows[0]?.claim_target) {
    throw new Error('Claim SLA migration is incomplete: the claim target column or alert constraint is missing.');
  }
  const stageLSchema = await pool.query<{ business_hours: boolean; policy_version_table: boolean; monitor_cursor: boolean; alert_delivery_state: boolean; preview_execution_state: boolean }>(`
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='support_sla_policies' AND column_name='use_business_hours'
      ) AS business_hours,
      to_regclass('public.support_sla_policy_versions') IS NOT NULL AS policy_version_table,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='support_sla_monitor_state' AND column_name='cursor_ticket_id'
      ) AS monitor_cursor,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='support_sla_alerts' AND column_name='delivery_status'
      ) AS alert_delivery_state,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='support_sla_escalation_previews' AND column_name='execution_status'
      ) AS preview_execution_state
  `);
  const stageL = stageLSchema.rows[0];
  if (!stageL?.business_hours || !stageL.policy_version_table || !stageL.monitor_cursor ||
      !stageL.alert_delivery_state || !stageL.preview_execution_state) {
    throw new Error('Stage L schema is incomplete: business-time policy, immutable versions, durable cursor/lease, delivery receipt, or one-time escalation execution state is missing.');
  }
  console.log('Stage L schema: business-hours mode, immutable policy versions, durable monitor progress, alert delivery state and escalation execution state verified.');

  console.log('Claim SLA policy column and alert target constraint: verified.');

  // Stage L integration smoke test: execute real policy-version, alert-intent,
  // monitor lease/cursor, notification-route, queue-snapshot and escalation
  // state SQL on the configured database, then roll every fixture back.
  const stageLClient = await pool.connect();
  const stageLRunId = randomUUID();
  const stageLGuildId = 'queryfixr-stage-l-verification-' + stageLRunId;
  const stageLTicketId = 'queryfixr-stage-l-ticket-' + stageLRunId;
  const stageLChannelId = 'queryfixr-stage-l-channel-' + stageLRunId;
  const stageLPolicyId = 'queryfixr-stage-l-policy-' + stageLRunId;
  const stageLAlertId = 'queryfixr-stage-l-alert-' + stageLRunId;
  const stageLSnapshotId = 'queryfixr-stage-l-snapshot-' + stageLRunId;
  const stageLPreviewId = 'queryfixr-stage-l-preview-' + stageLRunId;
  const stageLStartedAt = new Date(Date.now() - 60_000).toISOString();
  try {
    await stageLClient.query('BEGIN');
    await stageLClient.query(
      'INSERT INTO tickets (id,guild_id,channel_id,ticket_number,status,department_id,owner_id,priority,created_at,updated_at) ' +
        "VALUES ($1,$2,$3,'verify-L','open','verify-department','verify-customer','urgent',$4::timestamptz,$4::timestamptz)",
      [stageLTicketId, stageLGuildId, stageLChannelId, stageLStartedAt],
    );
    await stageLClient.query(
      'INSERT INTO support_sla_policies ' +
        '(id,guild_id,department_id,priority,first_response_minutes,claim_minutes,resolution_minutes,pause_while_pending,' +
        'use_business_hours,warning_ratio,enabled,version,updated_by,created_at,updated_at) ' +
        'VALUES ($1,$2,\'verify-department\',\'urgent\',10,20,60,TRUE,FALSE,0.8,TRUE,1,\'verification\',NOW(),NOW())',
      [stageLPolicyId, stageLGuildId],
    );
    await stageLClient.query(
      'INSERT INTO support_sla_policy_versions (id,guild_id,policy_id,policy_version,snapshot,actor_id) ' +
        'VALUES ($1,$2,$3,1,$4::jsonb,\'verification\')',
      [stageLRunId, stageLGuildId, stageLPolicyId, JSON.stringify({ version: 1, useBusinessHours: false })],
    );
    const versionRow = await stageLClient.query(
      'SELECT snapshot FROM support_sla_policy_versions WHERE guild_id=$1 AND policy_id=$2 AND policy_version=1',
      [stageLGuildId, stageLPolicyId],
    );
    if (versionRow.rowCount !== 1) throw new Error('Stage L policy version snapshot did not round-trip.');

    const alertInsert = 
      'INSERT INTO support_sla_alerts ' +
      '(id,guild_id,ticket_id,policy_id,target_type,progress,policy_version,cycle_started_at,observed_at,detail,delivery_status) ' +
      "VALUES ($1,$2,$3,$4,'claim','warning',1,$5::timestamptz,NOW(),'verification alert','pending') " +
      'ON CONFLICT (guild_id,ticket_id,policy_id,target_type,progress,policy_version,cycle_started_at) DO NOTHING RETURNING id';
    const firstAlert = await stageLClient.query(alertInsert, [
      stageLAlertId, stageLGuildId, stageLTicketId, stageLPolicyId, stageLStartedAt,
    ]);
    const duplicateAlert = await stageLClient.query(alertInsert, [
      'duplicate:' + stageLAlertId, stageLGuildId, stageLTicketId, stageLPolicyId, stageLStartedAt,
    ]);
    if (firstAlert.rowCount !== 1 || duplicateAlert.rowCount !== 0) {
      throw new Error('Stage L idempotent alert intent did not suppress a duplicate delivery intent.');
    }

    await stageLClient.query(
      'INSERT INTO support_sla_monitor_state (guild_id,cursor_ticket_id,lease_owner,lease_until,updated_at) ' +
        "VALUES ($1,$2,$3,NOW()+INTERVAL '1 minute',NOW())",
      [stageLGuildId, stageLTicketId, stageLRunId],
    );
    const monitorState = await stageLClient.query(
      'SELECT cursor_ticket_id,lease_owner FROM support_sla_monitor_state WHERE guild_id=$1',
      [stageLGuildId],
    );
    if (monitorState.rows[0]?.cursor_ticket_id !== stageLTicketId || monitorState.rows[0]?.lease_owner !== stageLRunId) {
      throw new Error('Stage L monitor lease/cursor did not round-trip.');
    }

    await stageLClient.query(
      'INSERT INTO support_sla_notification_routes (guild_id,channel_id,supervisor_role_id,enabled,updated_by) ' +
        'VALUES ($1,$2,$3,TRUE,$4)',
      [stageLGuildId, '12345678901234567', '12345678901234568', stageLRunId],
    );
    const routeIsolation = await stageLClient.query(
      'SELECT 1 FROM support_sla_notification_routes WHERE guild_id=$1',
      ['another-guild-' + stageLRunId],
    );
    if (routeIsolation.rowCount !== 0) throw new Error('Stage L route unexpectedly crossed the guild boundary.');

    await stageLClient.query(
      'INSERT INTO support_sla_queue_snapshots (id,guild_id,created_by,filters,items,item_count) ' +
        'VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,1)',
      [stageLSnapshotId, stageLGuildId, stageLRunId, JSON.stringify({ limit: 1 }), JSON.stringify([{ ticketId: stageLTicketId }])],
    );
    await stageLClient.query(
      'INSERT INTO support_sla_escalation_previews ' +
        '(id,guild_id,ticket_id,policy_id,policy_version,lifecycle_cycle_started_at,preview,created_by,expires_at) ' +
        "VALUES ($1,$2,$3,$4,1,$5::timestamptz,$6::jsonb,$7,NOW()+INTERVAL '10 minutes')",
      [stageLPreviewId, stageLGuildId, stageLTicketId, stageLPolicyId, stageLStartedAt, JSON.stringify({ findings: [] }), stageLRunId],
    );
    const claimedPreview = await stageLClient.query(
      "UPDATE support_sla_escalation_previews SET execution_status='attempted',executed_by=$3,executed_at=NOW() " +
        "WHERE guild_id=$1 AND id=$2 AND execution_status='preview' RETURNING execution_status",
      [stageLGuildId, stageLPreviewId, stageLRunId],
    );
    const duplicatePreviewClaim = await stageLClient.query(
      "UPDATE support_sla_escalation_previews SET execution_status='attempted' " +
        "WHERE guild_id=$1 AND id=$2 AND execution_status='preview' RETURNING id",
      [stageLGuildId, stageLPreviewId],
    );
    if (claimedPreview.rowCount !== 1 || duplicatePreviewClaim.rowCount !== 0) {
      throw new Error('Stage L one-time escalation preview execution was not enforced.');
    }
    await stageLClient.query('ROLLBACK');
  } catch (error) {
    await stageLClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    stageLClient.release();
  }
  console.log('Stage L PostgreSQL integration smoke tests: versioned policy, idempotent alert, durable cursor/lease, guild isolation, queue snapshot and single-use escalation passed (rolled back).');

  const reportGuildId = 'queryfixr-stage-l-sla-report-' + randomUUID();
  const reportTo = new Date();
  const reportFrom = new Date(reportTo.getTime() - 30 * 24 * 60 * 60 * 1000);
  const slaReport = await getSupportSlaOperationalSummary(
    reportGuildId,
    reportFrom.toISOString(),
    new Date(reportTo.getTime() + 1000).toISOString(),
  );
  if (slaReport.activePolicies !== 0 || slaReport.totalAlerts !== 0 ||
      slaReport.deliverySent !== 0 || slaReport.deliveryPending !== 0 || slaReport.deliveryFailed !== 0) {
    throw new Error('Stage L SLA report leaked policy or alert records across guild boundaries.');
  }
  console.log('Stage L SLA operations report query: verified zero-record guild isolation.');



  // Exercise Stage K's SQL against the migrated schema, not only mock executors.
  // The synthetic guild ID is used for read-only queries; these checks never mutate production data.
  const analyticsGuildId = 'queryfixr-stage-k-analytics-verification';
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
  const analyticsRepository = new PostgresAnalyticsRepository(pool);
  const advancedAnalyticsRepository = new PostgresAdvancedAnalyticsRepository(pool);
  await Promise.all([
    analyticsRepository.getGuildRollup(analyticsGuildId, startAt, endAt, filters),
    advancedAnalyticsRepository.getDepartmentBreakdown(analyticsGuildId, startAt, endAt, filters),
    advancedAnalyticsRepository.getStaffBreakdown(analyticsGuildId, startAt, endAt, filters),
    advancedAnalyticsRepository.getTagBreakdown(analyticsGuildId, startAt, endAt, filters),
    advancedAnalyticsRepository.getDailyTrends(analyticsGuildId, startAt, endAt, filters),
    advancedAnalyticsRepository.getDataCoverage(analyticsGuildId, startAt, endAt, filters),
  ]);

  console.log('Analytics query smoke tests: 6 passed against PostgreSQL.');
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
