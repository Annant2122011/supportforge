import { randomUUID } from 'node:crypto';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { initializePersistence } from '../core/persistence/provider';

const DEFAULT_LEASE_MS = 20 * 60_000;

interface LeaseRow extends Record<string, unknown> {
  token: string;
}

/**
 * Cross-process mutex for ticket creation. The in-memory lock in the
 * interaction handler is retained for fast local rejection, while this
 * database lease protects against multiple bot workers racing to create the
 * same user's ticket for one department.
 */
export async function acquireTicketCreationLease(
  guildId: string,
  ownerId: string,
  departmentId: string,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<string | null> {
  await initializePersistence();
  const token = randomUUID();
  const safeLeaseMs = Math.max(60_000, Math.min(leaseMs, 30 * 60_000));
  const pool = getPostgresPool();

  await pool.query('DELETE FROM ticket_creation_locks WHERE expires_at <= NOW()');

  const result = await pool.query<LeaseRow>(
    'INSERT INTO ticket_creation_locks (guild_id, owner_id, department_id, token, expires_at) ' +
    "VALUES ($1,$2,$3,$4,NOW() + ($5::integer * INTERVAL '1 millisecond')) " +
    'ON CONFLICT (guild_id, owner_id, department_id) DO UPDATE ' +
    'SET token=EXCLUDED.token, expires_at=EXCLUDED.expires_at ' +
    'WHERE ticket_creation_locks.expires_at <= NOW() RETURNING token',
    [guildId, ownerId, departmentId, token, safeLeaseMs],
  );

  return result.rows[0]?.token ?? null;
}

export async function releaseTicketCreationLease(
  guildId: string,
  ownerId: string,
  departmentId: string,
  token: string,
): Promise<void> {
  await initializePersistence();
  await getPostgresPool().query(
    'DELETE FROM ticket_creation_locks WHERE guild_id=$1 AND owner_id=$2 AND department_id=$3 AND token=$4',
    [guildId, ownerId, departmentId, token],
  );
}
