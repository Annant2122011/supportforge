import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runMigrations } from './migrations';

export interface SqliteStatement {
  run(...parameters: unknown[]): {
    changes: number | bigint;
    lastInsertRowid?: number | bigint;
  };
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  all(...parameters: unknown[]): Array<Record<string, unknown>>;
  close(): void;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  readonly isOpen: boolean;
}

interface DatabaseSyncConstructor {
  new (
    path: string,
    options?: {
      enableForeignKeyConstraints?: boolean;
      timeout?: number;
    },
  ): SqliteDatabase;
}

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: DatabaseSyncConstructor;
};

const DATA_DIR = join(process.cwd(), 'data');
const DATABASE_PATH = join(DATA_DIR, 'supportforge.sqlite');

let database: SqliteDatabase | null = null;

export function getDatabasePath(): string {
  return DATABASE_PATH;
}

/**
 * Open and migrate an explicitly supplied SQLite database.
 *
 * The application uses getSupportForgeDatabase() for its singleton database.
 * Tests and maintenance tooling can use this factory with an isolated path,
 * without mutating process.cwd().
 */
export function createSupportForgeDatabase(
  databasePath: string,
  legacyTicketsPath?: string,
): SqliteDatabase {
  mkdirSync(dirname(databasePath), { recursive: true });

  const instance = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });

  instance.exec(
    'PRAGMA foreign_keys = ON; ' +
    'PRAGMA journal_mode = WAL; ' +
    'PRAGMA busy_timeout = 5000; ' +
    'PRAGMA synchronous = NORMAL;',
  );

  runMigrations(instance, legacyTicketsPath);

  return instance;
}

export function getSupportForgeDatabase(): SqliteDatabase {
  if (database?.isOpen) {
    return database;
  }

  mkdirSync(DATA_DIR, { recursive: true });

  database = createSupportForgeDatabase(DATABASE_PATH);

  return database;
}

export function closeSupportForgeDatabase(): void {
  if (!database) return;

  if (database.isOpen) {
    database.close();
  }

  database = null;
}

export function withTransaction<T>(
  action: (db: SqliteDatabase) => T,
): T {
  const db = getSupportForgeDatabase();

  db.exec('BEGIN IMMEDIATE');

  try {
    const result = action(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  }
}
