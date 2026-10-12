import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getSupportForgeDatabase, type SqliteDatabase } from '../core/persistence/sqliteDatabase';
import { getPostgresPool } from '../core/persistence/postgresDatabase';
import type { PersistenceProvider } from '../core/persistence/provider';

export type JsonDocumentKey = 'guild-config' | 'advanced-settings' | 'reports' | 'audit-log' | 'legacy-tickets-import-status';

export interface JsonDocumentRepository {
  get(key: JsonDocumentKey): Promise<unknown | undefined>;
  put(key: JsonDocumentKey, value: unknown): Promise<void>;
  putIfAbsent(key: JsonDocumentKey, value: unknown): Promise<boolean>;
}

interface SqliteDocumentRow extends Record<string, unknown> {
  document_key: string;
  payload_json: string;
  updated_at: string;
}

interface PostgresDocumentRow {
  document_key: string;
  payload: unknown;
  updated_at: Date | string;
}

function parseJson(payload: string, key: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch (error) {
    throw new Error(
      'SupportForge database document "' + key + '" contains invalid JSON.',
      { cause: error },
    );
  }
}

function serialized(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) {
    throw new Error('SupportForge JSON documents cannot store undefined.');
  }
  return result;
}

export class SqliteJsonDocumentRepository implements JsonDocumentRepository {
  public constructor(
    private readonly database: SqliteDatabase = getSupportForgeDatabase(),
  ) {}

  public async get(key: JsonDocumentKey): Promise<unknown | undefined> {
    const row = this.database
      .prepare('SELECT document_key, payload_json, updated_at FROM app_documents WHERE document_key = ?')
      .get(key) as SqliteDocumentRow | undefined;
    return row ? parseJson(row.payload_json, key) : undefined;
  }

  public async put(key: JsonDocumentKey, value: unknown): Promise<void> {
    this.database.prepare(
      'INSERT INTO app_documents (document_key, payload_json, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(document_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at',
    ).run(key, serialized(value), new Date().toISOString());
  }

  public async putIfAbsent(key: JsonDocumentKey, value: unknown): Promise<boolean> {
    const result = this.database.prepare(
      'INSERT OR IGNORE INTO app_documents (document_key, payload_json, updated_at) VALUES (?, ?, ?)',
    ).run(key, serialized(value), new Date().toISOString());
    return Number(result.changes) === 1;
  }
}

export class PostgresJsonDocumentRepository implements JsonDocumentRepository {
  public async get(key: JsonDocumentKey): Promise<unknown | undefined> {
    const result = await getPostgresPool().query<PostgresDocumentRow>(
      'SELECT document_key, payload, updated_at FROM app_documents WHERE document_key = $1',
      [key],
    );
    return result.rows[0]?.payload;
  }

  public async put(key: JsonDocumentKey, value: unknown): Promise<void> {
    await getPostgresPool().query(
      'INSERT INTO app_documents (document_key, payload, updated_at) VALUES ($1, $2::jsonb, NOW()) ' +
      'ON CONFLICT(document_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()',
      [key, serialized(value)],
    );
  }

  public async putIfAbsent(key: JsonDocumentKey, value: unknown): Promise<boolean> {
    const result = await getPostgresPool().query(
      'INSERT INTO app_documents (document_key, payload, updated_at) VALUES ($1, $2::jsonb, NOW()) ' +
      'ON CONFLICT(document_key) DO NOTHING',
      [key, serialized(value)],
    );
    return (result.rowCount ?? 0) === 1;
  }
}

const LEGACY_DOCUMENTS: ReadonlyArray<{
  key: JsonDocumentKey;
  path: string;
  fallbackPath?: string;
}> = [
  { key: 'guild-config', path: 'data/config.json' },
  { key: 'advanced-settings', path: 'data/advanced-settings.json' },
  { key: 'reports', path: 'data/reports.json' },
  {
    key: 'audit-log',
    path: 'data/audit-log.json',
    // The prior filesystem-backed audit store maintained a backup. Keep that
    // recovery path available if the primary file is absent or malformed.
    fallbackPath: 'data/audit-log.backup.json',
  },
];

function readLegacyDocument(path: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      'SupportForge cannot import legacy file "' + path +
      '" because it is invalid JSON. The source file was not modified.',
      { cause: error },
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'SupportForge cannot import legacy file "' + path +
      '" because the root value must be a JSON object. The source file was not modified.',
    );
  }

  return parsed;
}

/**
 * Import existing JSON-backed application state once. The database is the
 * authority after import; source JSON files are preserved and backed up.
 * INSERT-if-absent prevents a restarted bot from overwriting newer DB state.
 */
export async function importLegacyJsonDocuments(
  provider: PersistenceProvider,
  rootDirectory = process.cwd(),
  repositoryOverride?: JsonDocumentRepository,
): Promise<{ imported: JsonDocumentKey[]; skipped: JsonDocumentKey[] }> {
  const repository: JsonDocumentRepository =
    repositoryOverride ?? (
      provider === 'postgres'
        ? new PostgresJsonDocumentRepository()
        : new SqliteJsonDocumentRepository()
    );

  const imported: JsonDocumentKey[] = [];
  const skipped: JsonDocumentKey[] = [];

  for (const document of LEGACY_DOCUMENTS) {
    // Never let a legacy local file overwrite an existing durable document.
    if (await repository.get(document.key) !== undefined) {
      skipped.push(document.key);
      continue;
    }

    const candidates = [
      join(rootDirectory, document.path),
      ...(document.fallbackPath ? [join(rootDirectory, document.fallbackPath)] : []),
    ].filter(existsSync);

    if (!candidates.length) {
      skipped.push(document.key);
      continue;
    }

    let value: unknown;
    let selectedPath: string | undefined;
    let lastError: unknown;

    for (const candidatePath of candidates) {
      // Backup every attempted source before parsing it. The original file is
      // never modified or deleted, even when its contents are malformed.
      const backupPath =
        candidatePath + '.pre-database-' + Date.now() + '-' + randomUUID() + '.backup';
      copyFileSync(candidatePath, backupPath);

      try {
        value = readLegacyDocument(candidatePath);
        selectedPath = candidatePath;
        break;
      } catch (error) {
        lastError = error;
        if (candidatePath !== candidates[candidates.length - 1]) {
          console.warn(
            '⚠️ Legacy SupportForge file could not be imported; trying its configured backup: ' +
            candidatePath,
          );
        }
      }
    }

    if (!selectedPath) {
      throw new Error(
        'SupportForge could not import legacy document "' + document.key +
        '". All available source files were invalid; no source was modified.',
        { cause: lastError },
      );
    }

    if (document.key === 'audit-log' && selectedPath !== candidates[0]) {
      console.warn(
        '⚠️ Imported audit history from the retained backup because the primary audit file was unavailable or invalid.',
      );
    }

    if (await repository.putIfAbsent(document.key, value)) {
      imported.push(document.key);
    } else {
      skipped.push(document.key);
    }
  }

  if (imported.length) {
    console.info(
      '✅ Imported legacy SupportForge JSON documents into durable storage: ' +
      imported.join(', ') + '. Legacy files and backups were retained.',
    );
  }

  return { imported, skipped };
}
