import 'dotenv/config';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { Pool } from 'pg';

import {
  assertRestoreTargetDistinctFromConfiguredDatabase,
  isAllowedRestoreTargetLabel,
  isSafeBackupFilename,
  RESTORE_TARGET_CONFIRMATION,
  validateBackupManifest,
  type PostgresBackupManifest,
} from '../src/core/persistence/backupRestoreSafety';
import { closePostgresDatabase, getPostgresPool } from '../src/core/persistence/postgresDatabase';
import { CURRENT_POSTGRES_MIGRATION_ID } from '../src/core/persistence/postgresMigrations';
import { migrateAndVerifyPostgres } from '../src/core/persistence/migrationRunner';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + ' is required. Restore was not started.');
  return value;
}

function postgresUrl(value: string, variable: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(variable + ' is not a valid PostgreSQL URL.'); }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(variable + ' must use postgres:// or postgresql://.');
  }
  return url;
}


function postgresClientEnvironment(url: URL): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('PostgreSQL connection URL must include a database name.');
  environment.PGHOST = url.hostname;
  environment.PGPORT = url.port || '5432';
  environment.PGDATABASE = database;
  if (url.username) environment.PGUSER = decodeURIComponent(url.username);
  if (url.password) environment.PGPASSWORD = decodeURIComponent(url.password);
  const queryToEnvironment: Record<string, string> = {
    sslmode: 'PGSSLMODE',
    sslrootcert: 'PGSSLROOTCERT',
    sslcert: 'PGSSLCERT',
    sslkey: 'PGSSLKEY',
    application_name: 'PGAPPNAME',
    connect_timeout: 'PGCONNECT_TIMEOUT',
    target_session_attrs: 'PGTARGETSESSIONATTRS',
    channel_binding: 'PGCHANNELBINDING',
  };
  for (const [queryName, environmentName] of Object.entries(queryToEnvironment)) {
    const value = url.searchParams.get(queryName);
    if (value) environment[environmentName] = value;
  }
  if (!environment.PGSSLMODE) environment.PGSSLMODE = 'verify-full';
  if (environment.PGSSLMODE === 'require') environment.PGSSLMODE = 'verify-full';
  return environment;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function runTool(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(binary, args, { env, stdio: 'ignore', windowsHide: true });
    child.once('error', () => reject(new Error(binary + ' could not start. Install PostgreSQL client tools and ensure the binary is on PATH.')));
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(binary + ' exited with status ' + String(code) + '. Restore stopped; inspect the isolated target before retrying.'));
    });
  });
}

async function main(): Promise<void> {
  const provider = (process.env.SUPPORTFORGE_DATABASE_PROVIDER ?? 'postgres').trim().toLowerCase();
  if (!['postgres', 'postgresql', 'neon'].includes(provider)) {
    throw new Error('Restore supports only the authoritative PostgreSQL/Neon provider.');
  }
  if (required('SUPPORTFORGE_RESTORE_CONFIRMATION') !== RESTORE_TARGET_CONFIRMATION) {
    throw new Error('Set SUPPORTFORGE_RESTORE_CONFIRMATION=' + RESTORE_TARGET_CONFIRMATION + ' only after verifying the target is disposable and non-production.');
  }
  const targetLabel = required('SUPPORTFORGE_RESTORE_TARGET_LABEL');
  if (!isAllowedRestoreTargetLabel(targetLabel)) {
    throw new Error('Restore target label must clearly identify test/staging/restore/non-production and must not identify production, main or live.');
  }

  const backupPath = resolve(required('SUPPORTFORGE_BACKUP_FILE'));
  const filename = basename(backupPath);
  if (!isSafeBackupFilename(filename)) throw new Error('Backup path must point to a single .dump archive filename.');
  const backupStat = await stat(backupPath);
  if (!backupStat.isFile() || backupStat.size <= 0) throw new Error('Backup archive is missing or empty.');
  const manifestPath = backupPath + '.manifest.json';
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const manifestValue: unknown = JSON.parse(manifestRaw);
  const actualSha = await sha256File(backupPath);
  validateBackupManifest(manifestValue, filename, actualSha, backupStat.size);
  const manifest = manifestValue as PostgresBackupManifest;

  const targetValue = required('RESTORE_DATABASE_URL_UNPOOLED');
  const target = postgresUrl(targetValue, 'RESTORE_DATABASE_URL_UNPOOLED');
  const targetDatabaseName = decodeURIComponent(target.pathname.replace(/^\//, '')) || '(default)';
  // Protect active app and migration targets before the restore script redirects
  // its process-local database environment to the destination.
  assertRestoreTargetDistinctFromConfiguredDatabase(target.toString(), [
    process.env.DATABASE_URL,
    process.env.DATABASE_URL_UNPOOLED,
  ]);
  if (target.hostname.toLowerCase() === manifest.databaseHost.toLowerCase() &&
      targetDatabaseName.toLowerCase() === manifest.databaseName.toLowerCase()) {
    throw new Error('Restore target matches the backup source host and database. Refusing to restore onto the source.');
  }

  // Require an empty target before invoking pg_restore. Never use --clean or drop pre-existing objects.
  const probe = new Pool({ connectionString: target.toString(), max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const database = await probe.query<{ name: string }>('SELECT current_database() AS name');
    const objects = await probe.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace " +
      "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' " +
      "AND c.relkind IN ('r','p','v','m','S','f')",
    );
    if (Number(objects.rows[0]?.count ?? 0) > 0) {
      throw new Error('Restore target ' + database.rows[0]?.name + ' is not empty. Nothing was overwritten. Create a new isolated Neon restore branch/database.');
    }
    console.log('Empty target verified for label "' + targetLabel + '" on database "' + database.rows[0]?.name + '".');
  } finally {
    await probe.end();
  }

  await runTool('pg_restore', ['--list', backupPath], { ...process.env });
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalUnpooledUrl = process.env.DATABASE_URL_UNPOOLED;
  try {
    // These environment changes exist only in this process, so migrations target the explicitly supplied restore DB.
    process.env.DATABASE_URL = target.toString();
    process.env.DATABASE_URL_UNPOOLED = target.toString();
    await runTool(
      'pg_restore',
      ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', targetDatabaseName, backupPath],
      postgresClientEnvironment(target),
    );
    await migrateAndVerifyPostgres();

    const pool = getPostgresPool();
    const migration = await pool.query<{ max_id: number | null }>('SELECT MAX(id)::int AS max_id FROM schema_migrations');
    const core = await pool.query<{ tickets: string; events: string; outbox: string }>(
      'SELECT (SELECT COUNT(*)::text FROM tickets) AS tickets,' +
      '(SELECT COUNT(*)::text FROM ticket_events) AS events,' +
      '(SELECT COUNT(*)::text FROM outbox_events) AS outbox',
    );
    const orphans = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM ticket_events e LEFT JOIN tickets t ON t.id=e.ticket_id WHERE t.id IS NULL',
    );
    if (Number(migration.rows[0]?.max_id ?? 0) !== CURRENT_POSTGRES_MIGRATION_ID) {
      throw new Error('Restored database did not reach the required schema migration level.');
    }
    if (Number(orphans.rows[0]?.count ?? 0) !== 0) {
      throw new Error('Restored database contains orphaned ticket events.');
    }

    console.log('Isolated PostgreSQL restore completed and application migrations/integrity checks passed.');
    console.log('Target label: ' + targetLabel);
    console.log('Target host/database: ' + target.hostname + '/' + targetDatabaseName);
    console.log('Schema migration: ' + CURRENT_POSTGRES_MIGRATION_ID);
    console.log('Tickets: ' + core.rows[0]?.tickets + '; events: ' + core.rows[0]?.events + '; outbox: ' + core.rows[0]?.outbox);
    console.log('Backup checksum verified: ' + actualSha);
    console.log('No Discord login, command deployment, or production target operation was performed.');
  } finally {
    await closePostgresDatabase().catch(() => undefined);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalUnpooledUrl === undefined) delete process.env.DATABASE_URL_UNPOOLED; else process.env.DATABASE_URL_UNPOOLED = originalUnpooledUrl;
  }
}

main().catch((error) => {
  console.error('PostgreSQL restore failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
