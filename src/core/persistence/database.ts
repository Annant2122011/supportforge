import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Database boundary shared by persistence repositories.
 *
 * The application currently supports SQLite during the migration window and
 * PostgreSQL/Neon as the target production provider.
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
