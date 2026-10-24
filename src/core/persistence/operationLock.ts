import { getPostgresPool } from './postgresDatabase';

/**
 * Run an operation while holding a PostgreSQL session advisory lock.
 * The lock survives process crashes only as long as the database session does;
 * PostgreSQL releases it automatically when the client connection closes.
 *
 * Keep the callback's durable steps idempotent. This prevents overlapping
 * workers, but it does not make Discord REST calls atomic with database writes.
 */
export async function withPostgresAdvisoryLock<T>(
  key: string,
  busyMessage: string,
  action: () => Promise<T>,
): Promise<T> {
  const normalizedKey = key.trim();
  if (!normalizedKey || normalizedKey.length > 500) {
    throw new Error('A non-empty operation lock key of at most 500 characters is required.');
  }

  const client = await getPostgresPool().connect();
  let acquired = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [normalizedKey],
    );
    acquired = result.rows[0]?.locked === true;
    if (!acquired) throw new Error(busyMessage);
    return await action();
  } finally {
    if (acquired) {
      await client.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
        [normalizedKey],
      ).catch(() => undefined);
    }
    client.release();
  }
}
