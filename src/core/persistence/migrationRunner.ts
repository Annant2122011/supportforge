import {
  withUnpooledPostgres,
  pingPostgres,
} from './postgresDatabase';
import { runPostgresMigrations } from './postgresMigrations';

export const POSTGRES_MIGRATION_LOCK_KEY = '71910262026';

export interface PostgresMigrationResult {
  applied: number;
}

export async function migratePostgres(): Promise<PostgresMigrationResult> {
  let applied = 0;

  await withUnpooledPostgres(async (db) => {
    await db.query(
      'SELECT pg_advisory_lock($1::bigint)',
      [POSTGRES_MIGRATION_LOCK_KEY],
    );

    try {
      const schemaState = await db.query<{ exists: boolean }>(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
      );

      const before = schemaState.rows[0]?.exists
        ? await db.query<{ id: number }>(
            'SELECT id FROM schema_migrations ORDER BY id ASC',
          )
        : { rows: [] as { id: number }[] };

      await runPostgresMigrations(db);

      const after = await db.query<{ id: number }>(
        'SELECT id FROM schema_migrations ORDER BY id ASC',
      );

      const beforeIds = new Set(before.rows.map((row) => Number(row.id)));
      applied = after.rows.filter(
        (row) => !beforeIds.has(Number(row.id)),
      ).length;
    } finally {
      await db.query(
        'SELECT pg_advisory_unlock($1::bigint)',
        [POSTGRES_MIGRATION_LOCK_KEY],
      ).catch(() => undefined);
    }
  });

  return { applied };
}

export async function verifyPostgresConnection(): Promise<void> {
  await pingPostgres();
}

export async function migrateAndVerifyPostgres(): Promise<PostgresMigrationResult> {
  const result = await migratePostgres();
  await verifyPostgresConnection();
  return result;
}
