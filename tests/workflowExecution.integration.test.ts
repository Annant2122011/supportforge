import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { TextChannel } from 'discord.js';

import { closePostgresDatabase, getPostgresPool } from '../src/core/persistence/postgresDatabase';
import { migratePostgres } from '../src/core/persistence/migrationRunner';
import { getPersistedTicket, registerTicket, updatePersistedTicketMetadata } from '../src/services/ticketPersistenceService';
import {
  executeWorkflowTemplateForTicket,
  listWorkflowExecutionRunsForTicket,
  resumeWorkflowExecutionForTicket,
} from '../src/services/workflowExecutionService';
import { saveWorkflowTemplate, setWorkflowTemplateEnabled } from '../src/services/workflowTemplateService';

const hasPostgres =
  process.env.SUPPORTFORGE_POSTGRES_TEST === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DATABASE_URL_UNPOOLED);
const isLocalPostgres = /@(localhost|127\.0\.0\.1)(:\d+)?\//i.test(process.env.DATABASE_URL ?? '');
const integrationEnabled = hasPostgres && isLocalPostgres;

if (hasPostgres && !isLocalPostgres) {
  throw new Error('Refusing workflow execution integration tests against a non-local database.');
}

function testChannel(id: string): TextChannel {
  return { id, messages: { fetch: async () => new Map() } } as unknown as TextChannel;
}

async function createTicket(guildId: string, channelId: string, ticketId: string, priority = 'normal'): Promise<void> {
  await registerTicket(channelId, {
    guildId, status: 'open', ticketNumber: ticketId.slice(-8),
    departmentId: 'billing', tagId: 'refund', ownerId: 'workflow-test-owner',
    priority: priority as 'low' | 'normal' | 'high' | 'urgent' | 'critical',
    createdAt: new Date().toISOString(), participantIds: ['workflow-test-owner'],
  }, { id: 'workflow-test-admin', attribution: 'actorKnown', confidence: 'high' });
}

async function cleanupGuild(guildId: string): Promise<void> {
  const pool = getPostgresPool();
  await pool.query('DELETE FROM workflow_execution_steps WHERE guild_id=$1', [guildId]);
  await pool.query('DELETE FROM workflow_execution_runs WHERE guild_id=$1', [guildId]);
  await pool.query('DELETE FROM workflow_template_revisions WHERE guild_id=$1', [guildId]);
  await pool.query('DELETE FROM workflow_templates WHERE guild_id=$1', [guildId]);
  await pool.query('DELETE FROM tickets WHERE guild_id=$1', [guildId]);
  await pool.query('DELETE FROM app_documents WHERE POSITION($1 IN document_key)>0', [guildId]);
}

test('manual workflow execution records durable steps, applies a guarded mutation once, and resumes after a simulated crash', { skip: !integrationEnabled }, async () => {
  await migratePostgres();
  const pool = getPostgresPool();
  const guildId = 'stage4-workflow-run-' + randomUUID();
  const channelId = 'workflow-channel-' + randomUUID();
  const ticketId = 'workflow-ticket-' + randomUUID();
  const actorId = 'workflow-test-admin';
  const interactionId = 'workflow-interaction-' + randomUUID();

  try {
    await createTicket(guildId, channelId, ticketId);
    const template = await saveWorkflowTemplate(guildId, actorId, 'Manual priority ' + ticketId.slice(-8), {
      conditions: [], actions: [{ type: 'set_priority', value: 'critical' }],
    });
    const enabled = await setWorkflowTemplateEnabled(guildId, template.id, template.version, true, actorId);
    const channel = testChannel(channelId);
    const command = {
      guildId, channel, actorId, actorName: actorId, interactionId,
      templateId: template.id, expectedVersion: enabled.version,
      confirmation: 'RUN ' + template.id + ' v' + enabled.version,
    };

    const run = await executeWorkflowTemplateForTicket(command);
    assert.equal(run.status, 'completed');
    assert.equal(run.steps.length, 1);
    assert.equal(run.steps[0]?.status, 'completed');
    assert.equal((await getPersistedTicket(channelId))?.priority, 'critical');

    const duplicate = await executeWorkflowTemplateForTicket(command);
    assert.equal(duplicate.id, run.id, 'replaying one Discord interaction ID cannot create a duplicate run');
    assert.equal((await listWorkflowExecutionRunsForTicket(guildId, run.ticketId)).length, 1);

    // Simulate process death after the ticket update committed but before the step ledger was completed.
    await pool.query("UPDATE workflow_execution_steps SET status='running',completed_at=NULL WHERE run_id=$1 AND step_index=0", [run.id]);
    await pool.query("UPDATE workflow_execution_runs SET status='failed',finished_at=NULL,current_step_index=0 WHERE id=$1", [run.id]);

    const resumed = await resumeWorkflowExecutionForTicket({
      guildId, channel, actorId, actorName: actorId, runId: run.id, confirmation: 'RESUME ' + run.id,
    });
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.steps[0]?.status, 'completed');
    assert.equal((await getPersistedTicket(channelId))?.priority, 'critical');
    assert.equal((await listWorkflowExecutionRunsForTicket(guildId, run.ticketId)).length, 1);

    // A separate administrator changes the ticket after a partial execution. Resume must not overwrite that intervening change.
    const changedChannelId = 'workflow-channel-' + randomUUID();
    const changedTicketMarker = 'workflow-ticket-' + randomUUID();
    await createTicket(guildId, changedChannelId, changedTicketMarker);
    const changedRun = await executeWorkflowTemplateForTicket({
      guildId,
      channel: testChannel(changedChannelId),
      actorId,
      actorName: actorId,
      interactionId: 'workflow-interaction-' + randomUUID(),
      templateId: template.id,
      expectedVersion: enabled.version,
      confirmation: 'RUN ' + template.id + ' v' + enabled.version,
    });
    assert.equal(changedRun.status, 'completed');
    await pool.query(
      "UPDATE workflow_execution_steps SET status='running',completed_at=NULL WHERE run_id=$1 AND step_index=0",
      [changedRun.id],
    );
    await pool.query(
      "UPDATE workflow_execution_runs SET status='failed',finished_at=NULL,current_step_index=0 WHERE id=$1",
      [changedRun.id],
    );
    await updatePersistedTicketMetadata(
      changedChannelId,
      { priority: 'urgent' },
      { id: 'another-admin', attribution: 'actorKnown', confidence: 'high' },
    );
    const needsReview = await resumeWorkflowExecutionForTicket({
      guildId,
      channel: testChannel(changedChannelId),
      actorId,
      actorName: actorId,
      runId: changedRun.id,
      confirmation: 'RESUME ' + changedRun.id,
    });
    assert.equal(needsReview.status, 'needs_review');
    assert.equal(needsReview.steps[0]?.status, 'needs_review');
    assert.equal((await getPersistedTicket(changedChannelId))?.priority, 'urgent');
  } finally {
    await cleanupGuild(guildId);
  }
});

test('manual workflows record a condition mismatch without creating executable steps', { skip: !integrationEnabled }, async () => {
  await migratePostgres();
  const pool = getPostgresPool();
  const guildId = 'stage4-workflow-mismatch-' + randomUUID();
  const channelId = 'workflow-channel-' + randomUUID();
  const ticketId = 'workflow-ticket-' + randomUUID();
  const actorId = 'workflow-test-admin';

  try {
    await createTicket(guildId, channelId, ticketId, 'normal');
    const template = await saveWorkflowTemplate(guildId, actorId, 'Conditional priority ' + ticketId.slice(-8), {
      conditions: [{ field: 'priority', equals: 'urgent' }],
      actions: [{ type: 'set_priority', value: 'critical' }],
    });
    const enabled = await setWorkflowTemplateEnabled(guildId, template.id, template.version, true, actorId);
    const run = await executeWorkflowTemplateForTicket({
      guildId, channel: testChannel(channelId), actorId, actorName: actorId,
      interactionId: 'workflow-interaction-' + randomUUID(), templateId: template.id,
      expectedVersion: enabled.version, confirmation: 'RUN ' + template.id + ' v' + enabled.version,
    });

    assert.equal(run.status, 'not_matched');
    assert.equal(run.steps.length, 0);
    assert.equal((await getPersistedTicket(channelId))?.priority, 'normal');
    const ledger = await pool.query<{ count: number | string }>(
      'SELECT COUNT(*)::int AS count FROM workflow_execution_steps WHERE run_id=$1', [run.id],
    );
    assert.equal(Number(ledger.rows[0]?.count ?? 0), 0);
  } finally {
    await cleanupGuild(guildId);
    await closePostgresDatabase();
  }
});

test.after(async () => {
  await closePostgresDatabase();
});
