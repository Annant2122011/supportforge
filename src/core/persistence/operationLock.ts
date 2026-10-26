import { withUnpooledPostgres } from './postgresDatabase';

/**
 * Run an operation while holding a PostgreSQL session advisory lock.
 *
 * The lock uses a dedicated direct connection instead of consuming a pooled
 * runtime connection. The callback commonly performs its own repository
 * queries through the pool; using one pooled connection for the lock and then
 * asking the pool for another can deadlock when concurrent operations exhaust
 * the pool (each lock holder would wait for a second connection).
 *
 * PostgreSQL releases the lock when the direct connection closes. Keep the
 * callback's durable steps idempotent: the lock prevents overlapping workers,
 * but it does not make Discord REST calls atomic with database writes.
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

  return withUnpooledPostgres(async (client) => {
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
    }
  });
}
