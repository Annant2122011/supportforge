import {
  withUnpooledPostgres,
  pingPostgres,
} from './postgresDatabase';
import { runPostgresMigrations } from './postgresMigrations';

export interface PostgresMigrationResult {
  applied: number;
}

export async function migratePostgres(): Promise<PostgresMigrationResult> {
  let applied = 0;

  await withUnpooledPostgres(async (db) => {
    const before = await db.query<{ id: number }>(
      'SELECT id FROM schema_migrations ORDER BY id ASC',
    ).catch(() => ({ rows: [] } as { rows: { id: number }[] }));

    await runPostgresMigrations(db);

    const after = await db.query<{ id: number }>(
      'SELECT id FROM schema_migrations ORDER BY id ASC',
    );

    const beforeIds = new Set(before.rows.map((row) => Number(row.id)));
    applied = after.rows.filter(
      (row) => !beforeIds.has(Number(row.id)),
    ).length;
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
