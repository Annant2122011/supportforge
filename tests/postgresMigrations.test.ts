import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';

import {
  CURRENT_POSTGRES_MIGRATION_ID,
  runPostgresMigrations,
} from '../src/core/persistence/postgresMigrations';
import type { TransactionExecutor } from '../src/core/persistence/database';

test('forward migration repairs the pre-merge Stage 4 id-13 collision without rewriting migration history', async () => {
  const statements: string[] = [];
  const insertedMigrationIds: number[] = [];
  // Simulate an unreleased candidate database that already recorded IDs 1–16,
  // where the old Stage 4 draft had used ID 13 for Knowledge Base tables.
  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) => {
      statements.push(sql);
      let rows: unknown[] = [];
      if (sql.trim() === 'SELECT id FROM schema_migrations ORDER BY id ASC') {
        rows = Array.from({ length: 16 }, (_, index) => ({ id: index + 1 }));
      }
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        insertedMigrationIds.push(Number(values?.[0]));
      }
      return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows } as unknown as QueryResult<T>;
    },
    release: () => undefined,
  } as TransactionExecutor;

  await runPostgresMigrations(db);

  assert.equal(CURRENT_POSTGRES_MIGRATION_ID, 18);
  assert.deepEqual(insertedMigrationIds, [17, 18]);
  assert.ok(
    statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS ticket_recovery_replay_segments')),
    'the forward-compatible migration must ensure the recovery ledger exists even when migration 13 was already marked applied',
  );
  assert.ok(
    !insertedMigrationIds.includes(13),
    'existing migration identifiers are not rewritten or re-used',
  );
});
