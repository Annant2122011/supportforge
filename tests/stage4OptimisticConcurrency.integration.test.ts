import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { closePostgresDatabase, getPostgresPool } from '../src/core/persistence/postgresDatabase';
import { migratePostgres } from '../src/core/persistence/migrationRunner';
import { saveQuickReply, getQuickReply } from '../src/services/quickReplyService';
import { saveWorkflowTemplate, listWorkflowTemplates } from '../src/services/workflowTemplateService';

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
  } finally {
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
  const definition = { conditions: [], actions: [] };

  try {
    const created = await saveWorkflowTemplate(guildId, actorId, name, definition);
    assert.equal(created.version, 1);
    assert.equal(created.enabled, false);

    await assert.rejects(
      saveWorkflowTemplate(guildId, actorId, name, { conditions: [], actions: [] }),
      /already exists at version 1.*expected-version/,
    );

    const updated = await saveWorkflowTemplate(
      guildId,
      actorId,
      name,
      { conditions: [{ field: 'priority', equals: 'urgent' }], actions: [] },
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
    assert.deepEqual(saved?.definition, { conditions: [{ field: 'priority', equals: 'urgent' }], actions: [] });
  } finally {
    await pool.query('DELETE FROM workflow_templates WHERE guild_id=$1', [guildId]);
    await pool.query('DELETE FROM app_documents WHERE POSITION($1 IN document_key)>0', [guildId]);
    await closePostgresDatabase();
  }
});
