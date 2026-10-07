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

  return value;
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
    application_name: 'supportforge-db-migrations',
  });

  await client.connect();

  const executor = toTransactionExecutor({
    query: <R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>> => client.query<R>(text, values as unknown[] | undefined),
    release: () => {
      void client.end();
    },
  });

  try {
    return await action(executor);
  } finally {
    executor.release();
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
