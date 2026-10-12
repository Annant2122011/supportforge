import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSupportForgeDatabase,
  type SqliteDatabase,
} from '../src/core/persistence/sqliteDatabase';
import { SqliteJsonDocumentRepository } from '../src/repositories/jsonDocumentRepository';

async function withDatabase(
  callback: (database: SqliteDatabase) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'supportforge-json-documents-'));
  const database = createSupportForgeDatabase(
    join(directory, 'supportforge.sqlite'),
    join(directory, 'missing-tickets.json'),
  );

  try {
    await callback(database);
  } finally {
    if (database.isOpen) database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('SQLite application documents persist JSON values and update timestamps', async () => {
  await withDatabase(async (database) => {
    const documents = new SqliteJsonDocumentRepository(database);
    const value = {
      version: 1,
      guilds: {
        'guild-1': {
          tier: 'free',
          departments: { billing: { name: 'Billing' } },
        },
      },
    };

    await documents.put('guild-config', value);

    assert.deepEqual(await documents.get('guild-config'), value);

    const row = database.prepare(
      'SELECT updated_at FROM app_documents WHERE document_key = ?',
    ).get('guild-config') as { updated_at: string } | undefined;

    assert.ok(row?.updated_at);
    assert.equal(Number.isNaN(new Date(row.updated_at).getTime()), false);
  });
});

test('insert-if-absent makes legacy import idempotent and never overwrites current data', async () => {
  await withDatabase(async (database) => {
    const documents = new SqliteJsonDocumentRepository(database);

    assert.equal(await documents.putIfAbsent('reports', { version: 1, guilds: {} }), true);
    assert.equal(await documents.putIfAbsent('reports', { version: 2, guilds: { wrong: {} } }), false);
    assert.deepEqual(await documents.get('reports'), { version: 1, guilds: {} });

    assert.equal(await documents.putIfAbsent('advanced-settings', { version: 5, guilds: {} }), true);
    assert.deepEqual(
      await documents.get('advanced-settings'),
      { version: 5, guilds: {} },
    );
  });
});

test('malformed persisted document JSON fails closed rather than replacing settings with defaults', async () => {
  await withDatabase(async (database) => {
    const documents = new SqliteJsonDocumentRepository(database);
    database.prepare(
      'INSERT INTO app_documents (document_key, payload_json, updated_at) VALUES (?, ?, ?)',
    ).run('guild-config', '{not-json', new Date().toISOString());

    await assert.rejects(
      documents.get('guild-config'),
      /contains invalid JSON/,
    );
  });
});

test('undefined is rejected rather than silently dropping a persistence write', async () => {
  await withDatabase(async (database) => {
    const documents = new SqliteJsonDocumentRepository(database);
    await assert.rejects(
      documents.put('guild-config', undefined),
      /cannot store undefined/i,
    );
  });
});
