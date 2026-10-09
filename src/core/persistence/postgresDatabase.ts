import { Pool, type QueryResult, type QueryResultRow } from 'pg';

import type { TransactionExecutor } from './database';

const DEFAULT_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

let pool: Pool | null = null;

function requireConnectionString(name: 'DATABASE_URL' | 'DATABASE_URL_UNPOOLED'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `SupportForge PostgreSQL configuration is missing ${name}. Configure Neon connection variables before enabling PostgreSQL persistence.`,
    );
  }

  return normalizePostgresConnectionString(value);
}

/**
 * pg 8.23+ warns that legacy SSL modes such as `require` currently behave
 * like `verify-full`, and that this behavior will change in a future major.
 * Neon connection strings commonly contain `sslmode=require`, so make the
 * intended certificate/hostname verification explicit without weakening SSL.
 *
 * We only rewrite an explicitly supplied legacy mode. Local/test URLs without
 * sslmode are left untouched so CI and local PostgreSQL continue to work.
 */
export function normalizePostgresConnectionString(value: string): string {
  const url = new URL(value);
  const sslmode = url.searchParams.get('sslmode');

  if (sslmode === 'prefer' || sslmode === 'require' || sslmode === 'verify-ca') {
    url.searchParams.set('sslmode', 'verify-full');
  }

  return url.toString();
}

function configurePool(): Pool {
  const connectionString = requireConnectionString('DATABASE_URL');
  const max = Number(process.env.SUPPORTFORGE_DB_POOL_MAX ?? DEFAULT_POOL_MAX);
  const idleTimeoutMillis = Number(
    process.env.SUPPORTFORGE_DB_IDLE_TIMEOUT_MS ?? DEFAULT_IDLE_TIMEOUT_MS,
  );
  const connectionTimeoutMillis = Number(
    process.env.SUPPORTFORGE_DB_CONNECTION_TIMEOUT_MS ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  );

  const instance = new Pool({
    connectionString,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    max: Number.isInteger(max) && max > 0 ? Math.min(max, 50) : DEFAULT_POOL_MAX,
    idleTimeoutMillis:
      Number.isFinite(idleTimeoutMillis) && idleTimeoutMillis >= 0
        ? idleTimeoutMillis
        : DEFAULT_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis:
      Number.isFinite(connectionTimeoutMillis) && connectionTimeoutMillis > 0
        ? connectionTimeoutMillis
        : DEFAULT_CONNECTION_TIMEOUT_MS,
    application_name: 'supportforge-discord-bot',
  });

  instance.on('error', (error) => {
    console.error('❌ SupportForge PostgreSQL pool error:', error);
  });

  return instance;
}

export function getPostgresPool(): Pool {
  if (!pool) {
    pool = configurePool();
  }

  return pool;
}

interface ReleasableQueryClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  release(): void;
}

function toTransactionExecutor(client: ReleasableQueryClient): TransactionExecutor {
  return {
    query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<T>> {
      return client.query<T>(text, values as unknown[] | undefined);
    },
    release(): void {
      client.release();
    },
  };
}

/**
 * Uses the direct/unpooled Neon connection for schema migrations.
 *
 * We intentionally do not run DDL through the pooled runtime path. Neon
 * exposes DATABASE_URL_UNPOOLED specifically for direct administrative work,
 * while DATABASE_URL is the preferred pooled runtime connection.
 */
export async function withUnpooledPostgres<T>(
  action: (executor: TransactionExecutor) => Promise<T>,
): Promise<T> {
  const connectionString = requireConnectionString('DATABASE_URL_UNPOOLED');
  const { Client } = await import('pg');
  const client = new Client({
    connectionString,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: 'supportforge-db-migrations',
  });

  client.on('error', (error) => {
    console.error('❌ SupportForge PostgreSQL migration connection error:', error);
  });

  await client.connect();

  const executor = toTransactionExecutor({
    query: <R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>> =>
      client.query<R>(text, values as unknown[] | undefined),
    release: () => {
      // The enclosing helper owns this direct connection and closes it in the
      // finally block below. A no-op release prevents accidental early close.
    },
  });

  try {
    return await action(executor);
  } finally {
    await client.end();
  }
}

export async function closePostgresDatabase(): Promise<void> {
  if (!pool) return;

  const current = pool;
  pool = null;
  await current.end();
}

export async function pingPostgres(): Promise<void> {
  await getPostgresPool().query('SELECT 1');
}
