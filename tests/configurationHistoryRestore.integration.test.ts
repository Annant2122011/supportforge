import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closePostgresDatabase,
  getPostgresPool,
} from '../src/core/persistence/postgresDatabase';
import { migratePostgres } from '../src/core/persistence/migrationRunner';
import {
  createConfigurationSnapshot,
  listConfigurationSnapshots,
  restoreConfigurationSnapshot,
  reviewConfigurationSnapshot,
} from '../src/services/configurationHistoryService';
import { getGuildConfig, updateGuildConfig } from '../src/services/configService';
import { getAdvancedSettings, updateAdvancedSettings } from '../src/services/advancedSettingsService';

const hasPostgres =
  process.env.SUPPORTFORGE_POSTGRES_TEST === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DATABASE_URL_UNPOOLED);
const isLocalPostgres = [
  process.env.DATABASE_URL,
  process.env.DATABASE_URL_UNPOOLED,
].every((value) => {
  try {
    const hostname = new URL(value ?? '').hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
});
const postgresIntegrationEnabled = hasPostgres && isLocalPostgres;

if (hasPostgres && !isLocalPostgres) {
  throw new Error(
    'Refusing configuration-restore integration tests against a non-local database. ' +
      'Use the disposable local PostgreSQL service for SUPPORTFORGE_POSTGRES_TEST=1.',
  );
}

interface StoredSnapshot {
  id: string;
  payload: {
    supportHours: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface StoredHistory {
  version: number;
  guilds: Record<string, StoredSnapshot[]>;
}

test(
  'configuration snapshots remain newest-first and isolated by guild in PostgreSQL',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();
    const nonce = BigInt(Date.now()) * 100_000n;
    const guildA = String(nonce);
    const guildB = String(nonce + 1n);
    const actor = { id: '223456789012345678', name: 'CI snapshot isolation test' };

    try {
      const first = await createConfigurationSnapshot(guildA, actor, 'first guild A checkpoint');
      await updateGuildConfig(guildA, (config) => {
        config.theme = 'ocean';
      });
      const second = await createConfigurationSnapshot(guildA, actor, 'second guild A checkpoint');
      const otherGuild = await createConfigurationSnapshot(guildB, actor, 'separate guild B checkpoint');

      const listA = await listConfigurationSnapshots(guildA);
      const listB = await listConfigurationSnapshots(guildB);

      assert.deepEqual(listA.map((item) => item.id), [second.id, first.id]);
      assert.deepEqual(listB.map((item) => item.id), [otherGuild.id]);
      assert.ok(listA.every((item) => item.guildId === guildA));
      assert.ok(listB.every((item) => item.guildId === guildB));
    } finally {
      await closePostgresDatabase();
    }
  },
);

test(
  'configuration restore compensates prior writes when a later service rejects the snapshot',
  { skip: !postgresIntegrationEnabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    const guildId = String(BigInt(Date.now()) * 100_000n);
    const actor = { id: '223456789012345678', name: 'CI restore test' };

    try {
      const checkpoint = await createConfigurationSnapshot(guildId, actor, 'before injected failure');
      await updateGuildConfig(guildId, (config) => {
        config.theme = 'ember';
      });
      await updateAdvancedSettings(guildId, (settings) => {
        settings.retention.closedDays = 17;
      });

      // Corrupt only this disposable-test snapshot's support-hours payload.
      // The history envelope remains valid, so restore reaches the service
      // boundary after writing the guild and advanced-settings documents.
      const historyRow = await pool.query<{ payload: unknown }>(
        'SELECT payload FROM app_documents WHERE document_key = $1',
        ['configuration-history'],
      );
      assert.ok(historyRow.rows[0], 'configuration-history row should exist');
      const history = JSON.parse(JSON.stringify(historyRow.rows[0].payload)) as StoredHistory;
      const snapshots = history.guilds[guildId];
      assert.ok(snapshots, 'the test guild snapshot list should exist');
      const targetIndex = snapshots.findIndex((snapshot) => snapshot.id === checkpoint.id);
      assert.notEqual(targetIndex, -1, 'the target snapshot should still be present');
      snapshots[targetIndex]!.payload.supportHours = [{ scopeType: 'unsupported-test-scope' }];

      const write = await pool.query(
        'UPDATE app_documents SET payload = $1::jsonb WHERE document_key = $2',
        [JSON.stringify(history), 'configuration-history'],
      );
      assert.equal(write.rowCount, 1, 'the isolated test history should be updated');

      const preview = await reviewConfigurationSnapshot(guildId, checkpoint.id);
      assert.ok(preview, 'the snapshot preview should exist');
      await assert.rejects(
        restoreConfigurationSnapshot(
          guildId,
          checkpoint.id,
          'RESTORE ' + checkpoint.id,
          actor,
          preview.currentFingerprint,
        ),
        /previous configuration was reapplied from the pre-restore checkpoint/,
      );

      // Guild and advanced-settings writes happen before support-hours
      // validation rejects the fixture. These assertions prove compensation
      // put both documents back to their exact pre-restore values.
      assert.equal((await getGuildConfig(guildId)).theme, 'ember');
      assert.equal((await getAdvancedSettings(guildId)).retention.closedDays, 17);

      const historyAfterRestore = await listConfigurationSnapshots(guildId);
      assert.ok(historyAfterRestore.some((item) => item.id === checkpoint.id));
      assert.ok(historyAfterRestore.some((item) => item.reason.includes('Automatic checkpoint before restoring')));
    } finally {
      await closePostgresDatabase();
    }
  },
);
