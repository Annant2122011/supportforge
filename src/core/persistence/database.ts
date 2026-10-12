import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Query boundary for the live PostgreSQL/Neon persistence repositories.
 * SQLite implementation code is retained for legacy migration tooling and
 * isolated repository tests, but is not a supported live bot provider.
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
