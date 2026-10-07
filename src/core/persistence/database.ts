import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Small database boundary used by persistence code.
 *
 * Repositories should depend on this contract rather than on a provider
 * implementation. PostgreSQL currently implements it, while SQLite remains
 * available during the migration window.
 */
export interface DatabaseExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

export interface TransactionExecutor extends DatabaseExecutor {
  release(): void;
}

export interface PostgresDatabase extends DatabaseExecutor {
  connect(): Promise<TransactionExecutor & { query: DatabaseExecutor['query'] }>;
  close(): Promise<void>;
}

export interface MigrationDatabase extends DatabaseExecutor {
  close(): Promise<void>;
}
