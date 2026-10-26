import { getSupportForgeDatabase } from '../persistence/sqliteDatabase';
import { getPersistenceProvider } from '../persistence/provider';
import { SqliteEventRepository } from '../../repositories/eventRepository';
import { PostgresEventRepository } from '../../repositories/postgresEventRepository';
import { MAX_OUTBOX_ATTEMPTS, type OutboxEvent } from './domainEvents';
import { getDiscordRetryAfterMs } from '../../utils/discordRateLimit';
import { runTrackedOperationalTask } from '../../services/operationalTaskTelemetry';

const MAX_BATCH_SIZE = 100;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const STALE_PROCESSING_MS = 10 * 60_000;

/**
 * Marks an operation that should not be retried automatically. The failed
 * record is retained for operator diagnosis and can be explicitly requeued.
 */
export class PermanentOutboxPublishError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentOutboxPublishError';
  }
}

function isPermanentFailure(error: unknown): boolean {
  if (error instanceof PermanentOutboxPublishError) return true;
  if (error && typeof error === 'object' && 'retryable' in error) {
    return (error as { retryable?: unknown }).retryable === false;
  }
  return false;
}

export interface OutboxPublisher {
  publish(event: OutboxEvent): Promise<void>;
}

export interface OutboxProcessResult {
  claimed: number;
  published: number;
  failed: number;
}

function retryAfterMs(error: unknown): number | null {
  let current: unknown = error;
  const visited = new Set<unknown>();

  // Reuse the shared parser so REST mutations and durable outbox retries
  // interpret discord.js milliseconds, raw Discord seconds, headers, and
  // wrapped errors consistently. Walk causes because libraries often wrap
  // the original rate-limit response in a higher-level error.
  for (let depth = 0; depth < 5 && current && !visited.has(current); depth += 1) {
    visited.add(current);
    const retryAfter = getDiscordRetryAfterMs(current);
    if (retryAfter !== null) return retryAfter;

    if (typeof current !== 'object') break;
    current = (current as Record<string, unknown>).cause;
  }

  return null;
}

export function calculateOutboxRetryDelayMs(attempts: number, error?: unknown): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 10);
  const exponential = Math.min(1_000 * 2 ** exponent, MAX_RETRY_DELAY_MS);
  const serverCooldown = error === undefined ? null : retryAfterMs(error);
  // Respect the server's Retry-After even when it exceeds normal backoff.
  return serverCooldown === null
    ? exponential
    : Math.max(exponential, serverCooldown + 1_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function processSqliteOutboxBatch(
  publisher: OutboxPublisher,
  safeLimit: number,
): Promise<OutboxProcessResult> {
  const database = getSupportForgeDatabase();
  const repository = new SqliteEventRepository(database);

  repository.recoverStaleProcessing(
    new Date(Date.now() - STALE_PROCESSING_MS).toISOString(),
  );

  const events = repository.listPendingOutbox(safeLimit);
  let claimed = 0;
  let published = 0;
  let failed = 0;

  for (const event of events) {
    if (!repository.markOutboxProcessing(event.id)) continue;
    claimed += 1;

    try {
      await publisher.publish(event);
      repository.markOutboxPublished(event.id);
      published += 1;
    } catch (error) {
      failed += 1;
      const permanent = isPermanentFailure(error);
      const delay = permanent ? 0 : calculateOutboxRetryDelayMs(event.attempts + 1, error);
      repository.markOutboxFailed(
        event.id,
        errorMessage(error),
        new Date(Date.now() + delay).toISOString(),
        permanent,
      );
    }
  }

  return { claimed, published, failed };
}

async function processPostgresOutboxBatch(
  publisher: OutboxPublisher,
  safeLimit: number,
): Promise<OutboxProcessResult> {
  const repository = new PostgresEventRepository();

  await repository.recoverStaleProcessing(
    new Date(Date.now() - STALE_PROCESSING_MS).toISOString(),
  );

  /*
   * Claiming is transactional and uses FOR UPDATE SKIP LOCKED. Once an event
   * is returned here it is already in the processing state and has an
   * incremented attempt count.
   */
  const events = await repository.claimPendingOutbox(safeLimit);
  let published = 0;
  let failed = 0;

  for (const event of events) {
    try {
      await publisher.publish(event);
      if (await repository.markOutboxPublished(event.id)) {
        published += 1;
      }
    } catch (error) {
      failed += 1;
      const permanent = isPermanentFailure(error);
      const delay = permanent ? 0 : calculateOutboxRetryDelayMs(event.attempts, error);
      await repository.markOutboxFailed(
        event.id,
        errorMessage(error),
        new Date(Date.now() + delay).toISOString(),
        permanent,
      );
    }
  }

  return {
    claimed: events.length,
    published,
    failed,
  };
}

/**
 * Publishes durable outbox records.
 *
 * SQLite keeps the original conditional-claim implementation for the
 * migration window. PostgreSQL uses an atomic SKIP LOCKED claim so multiple
 * worker processes can safely drain the same outbox without double-claiming.
 *
 * Delivery remains at-least-once. Consumers must use the durable outbox
 * event id as their idempotency key because a crash may happen after an
 * external side effect but before the published marker is persisted.
 */
export async function processOutboxBatch(
  publisher: OutboxPublisher,
  limit = MAX_BATCH_SIZE,
): Promise<OutboxProcessResult> {
  const safeLimit = Math.max(1, Math.min(limit, MAX_BATCH_SIZE));

  return getPersistenceProvider() === 'postgres'
    ? processPostgresOutboxBatch(publisher, safeLimit)
    : processSqliteOutboxBatch(publisher, safeLimit);
}

export function startOutboxProcessor(
  publisher: OutboxPublisher,
  intervalMs = 5_000,
): () => void {
  const interval = Math.max(1_000, Math.min(intervalMs, 60_000));
  let running = false;

  const tick = (): void => {
    if (running) return;
    running = true;

    void runTrackedOperationalTask('outbox-processor', null, () => processOutboxBatch(publisher))
      .catch((error) => {
        console.error('ResolvX outbox processor failed:', error);
      })
      .finally(() => {
        running = false;
      });
  };

  tick();
  const timer = setInterval(tick, interval);

  return () => clearInterval(timer);
}
