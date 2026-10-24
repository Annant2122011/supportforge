import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { closePostgresDatabase, getPostgresPool } from '../src/core/persistence/postgresDatabase';
import { migratePostgres } from '../src/core/persistence/migrationRunner';
import { deleteQuickReply, saveQuickReply, getQuickReply, listQuickReplyRevisions, restoreQuickReplyRevision } from '../src/services/quickReplyService';
import { deleteWorkflowTemplate, saveWorkflowTemplate, listWorkflowTemplates, listWorkflowTemplateRevisions, restoreWorkflowTemplateRevision } from '../src/services/workflowTemplateService';

const hasPostgres =
  process.env.SUPPORTFORGE_POSTGRES_TEST === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DATABASE_URL_UNPOOLED);
const isLocalPostgres = /@(localhost|127\.0\.0\.1)(:\d+)?\//i.test(process.env.DATABASE_URL ?? '');
const integrationEnabled = hasPostgres && isLocalPostgres;

if (hasPostgres && !isLocalPostgres) {
  throw new Error('Refusing Stage 4 concurrency integration tests against a non-local database.');
}

test('quick reply saves require an expected version and reject stale concurrent updates', { skip: !integrationEnabled }, async () => {
  await migratePostgres();
  const pool = getPostgresPool();
  const guildId = 'stage4-quick-' + randomUUID();
  const actorId = 'stage4-test-admin';

  try {
    const created = await saveQuickReply(guildId, actorId, {
      name: 'Refund guidance ' + guildId.slice(-8),
      body: 'First version',
    });
    assert.equal(created.version, 1);
    assert.equal(created.enabled, true);

    await assert.rejects(
      saveQuickReply(guildId, actorId, { name: created.name, body: 'Blind overwrite' }),
      /already exists at version 1.*expected-version/,
    );

    const disabled = await saveQuickReply(
      guildId,
      actorId,
      { name: created.name, body: 'Second version', enabled: false },
      created.version,
    );
    assert.equal(disabled.version, 2);
    assert.equal(disabled.enabled, false);

    const stillDisabled = await saveQuickReply(
      guildId,
      actorId,
      { name: created.name, body: 'Third version' },
      disabled.version,
    );
    assert.equal(stillDisabled.version, 3);
    assert.equal(stillDisabled.enabled, false, 'editing must not silently re-enable a disabled reply');

    await assert.rejects(
      saveQuickReply(guildId, actorId, { name: created.name, body: 'Stale version' }, disabled.version),
      /changed since you opened it/,
    );

    const concurrent = await Promise.allSettled([
      saveQuickReply(guildId, actorId, { name: created.name, body: 'Concurrent A' }, stillDisabled.version),
      saveQuickReply(guildId, actorId, { name: created.name, body: 'Concurrent B' }, stillDisabled.version),
    ]);
    assert.equal(concurrent.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((item) => item.status === 'rejected').length, 1);
    const final = await getQuickReply(guildId, created.id, { isAdmin: true, roleIds: [] });
    assert.equal(final?.version, 4);
    assert.equal(final?.enabled, false);
    assert.ok(['Concurrent A', 'Concurrent B'].includes(final?.body ?? ''));

    const restored = await restoreQuickReplyRevision(guildId, actorId, created.id, 1, final!.version);
    assert.equal(restored.version, 5);
    assert.equal(restored.body, 'First version');
    assert.equal(restored.enabled, true);

    assert.equal(await deleteQuickReply(guildId, created.id, restored.version, actorId), true);
    const restoredAfterDelete = await restoreQuickReplyRevision(guildId, actorId, created.id, 2, 6);
    assert.equal(restoredAfterDelete.version, 7);
    assert.equal(restoredAfterDelete.body, 'Second version');
    assert.equal(restoredAfterDelete.enabled, false);
    assert.equal((await listWorkflowTemplateRevisions(guildId, created.id))[0]?.operation, 'restored');
    assert.equal((await getQuickReply(guildId, created.id, { isAdmin: true, roleIds: [] }))?.version, 7);
    assert.equal((await listQuickReplyRevisions(guildId, created.id))[0]?.operation, 'restored');

    await assert.rejects(
      restoreQuickReplyRevision(guildId, actorId, created.id, 1, 6),
      /changed since it was opened/,
    );
  } finally {
    await pool.query('DELETE FROM quick_reply_revisions WHERE guild_id=$1', [guildId]);
    await pool.query('DELETE FROM quick_replies WHERE guild_id=$1', [guildId]);
    await pool.query('DELETE FROM app_documents WHERE POSITION($1 IN document_key)>0', [guildId]);
    await closePostgresDatabase();
  }
});

test('workflow template saves require an expected version instead of silently replacing newer definitions', { skip: !integrationEnabled }, async () => {
  await migratePostgres();
  const pool = getPostgresPool();
  const guildId = 'stage4-workflow-' + randomUUID();
  const actorId = 'stage4-test-admin';
  const name = 'Escalation policy ' + guildId.slice(-8);
  const definition = { conditions: [{ field: 'priority', equals: 'urgent' }], actions: [{ type: 'set_priority', value: 'high' }] };

  try {
    const created = await saveWorkflowTemplate(guildId, actorId, name, definition);
    assert.equal(created.version, 1);
    assert.equal(created.enabled, false);

    await assert.rejects(
      saveWorkflowTemplate(guildId, actorId, name, { conditions: [], actions: [{ type: 'set_priority', value: 'normal' }] }),
      /already exists at version 1.*expected-version/,
    );

    const updated = await saveWorkflowTemplate(
      guildId,
      actorId,
      name,
      { conditions: [{ field: 'priority', equals: 'urgent' }], actions: [{ type: 'set_priority', value: 'critical' }] },
      created.version,
    );
    assert.equal(updated.version, 2);
    assert.equal(updated.enabled, false, 'edits must disable catalogue entries pending review');

    await assert.rejects(
      saveWorkflowTemplate(guildId, actorId, name, definition, created.version),
      /changed since you opened it/,
    );

    const saved = (await listWorkflowTemplates(guildId)).find((template) => template.id === created.id);
    assert.equal(saved?.version, 2);
    assert.deepEqual(saved?.definition, { conditions: [{ field: 'priority', equals: 'urgent' }], actions: [{ type: 'set_priority', value: 'critical' }] });

    const restored = await restoreWorkflowTemplateRevision(guildId, created.id, 1, saved!.version, actorId);
    assert.equal(restored.version, 3);
    assert.deepEqual(restored.definition, definition);
    assert.equal(restored.enabled, false);

    assert.equal(await deleteWorkflowTemplate(guildId, created.id, restored.version, actorId), true);
    const restoredAfterDelete = await restoreWorkflowTemplateRevision(guildId, created.id, 2, 4, actorId);
    assert.equal(restoredAfterDelete.version, 5);
    assert.deepEqual(restoredAfterDelete.definition, {
      conditions: [{ field: 'priority', equals: 'urgent' }],
      actions: [{ type: 'set_priority', value: 'critical' }],
    });
    assert.equal(restoredAfterDelete.enabled, false);

    await assert.rejects(
      restoreWorkflowTemplateRevision(guildId, created.id, 1, 4, actorId),
      /changed since it was opened/,
    );
  } finally {
    await pool.query('DELETE FROM workflow_template_revisions WHERE guild_id=$1', [guildId]);
    await pool.query('DELETE FROM workflow_templates WHERE guild_id=$1', [guildId]);
    await pool.query('DELETE FROM app_documents WHERE POSITION($1 IN document_key)>0', [guildId]);
    await closePostgresDatabase();
  }
});
