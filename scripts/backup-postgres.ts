import 'dotenv/config';

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';

import { isSafeBackupFilename, type PostgresBackupManifest } from '../src/core/persistence/backupRestoreSafety';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + ' is required. No backup was created.');
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
      else reject(new Error(binary + ' exited with status ' + String(code) + '. Check local PostgreSQL client logs; connection secrets were not printed.'));
    });
  });
}

async function main(): Promise<void> {
  const provider = (process.env.SUPPORTFORGE_DATABASE_PROVIDER ?? 'postgres').trim().toLowerCase();
  if (!['postgres', 'postgresql', 'neon'].includes(provider)) {
    throw new Error('Database backup supports only the authoritative PostgreSQL/Neon provider.');
  }
  const source = postgresUrl(required('DATABASE_URL_UNPOOLED'), 'DATABASE_URL_UNPOOLED');
  const directory = resolve(process.env.SUPPORTFORGE_BACKUP_DIR?.trim() || join(process.cwd(), 'backups', 'neon'));
  await mkdir(directory, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const filename = 'resolvx-neon-' + stamp + '-' + randomUUID().slice(0, 8) + '.dump';
  if (!isSafeBackupFilename(filename)) throw new Error('Generated backup filename failed validation.');
  const finalPath = join(directory, filename);
  const temporaryPath = join(directory, '.' + filename + '.partial');
  const env = postgresClientEnvironment(source);

  try {
    // A custom-format dump is compressed by pg_dump and can be inspected by pg_restore.
    await runTool('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', temporaryPath, '--dbname', env.PGDATABASE!], env);
    const backupStat = await stat(temporaryPath);
    if (!backupStat.isFile() || backupStat.size <= 0) throw new Error('pg_dump produced an empty backup; no manifest was written.');
    await runTool('pg_restore', ['--list', temporaryPath], env);
    const sha256 = await sha256File(temporaryPath);
    await rename(temporaryPath, finalPath);

    const manifest: PostgresBackupManifest = {
      format: 'postgres-custom',
      filename: basename(finalPath),
      sha256,
      sizeBytes: backupStat.size,
      createdAt: new Date().toISOString(),
      databaseHost: source.hostname,
      databaseName: decodeURIComponent(source.pathname.replace(/^\//, '')) || '(default)',
    };
    const manifestPath = finalPath + '.manifest.json';
    const manifestTemporaryPath = manifestPath + '.partial';
    await writeFile(manifestTemporaryPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(manifestTemporaryPath, manifestPath);

    console.log('PostgreSQL backup created and structurally verified.');
    console.log('Archive: ' + finalPath);
    console.log('Manifest: ' + manifestPath);
    console.log('Bytes: ' + backupStat.size);
    console.log('SHA-256: ' + sha256);
    console.log('Source host/database: ' + manifest.databaseHost + '/' + manifest.databaseName);
    console.log('No restore or production write was performed.');
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

main().catch((error) => {
  console.error('PostgreSQL backup failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
