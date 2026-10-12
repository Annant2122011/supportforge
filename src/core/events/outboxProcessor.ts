import { getSupportForgeDatabase } from '../persistence/sqliteDatabase';
import { getPersistenceProvider } from '../persistence/provider';
import { SqliteEventRepository } from '../../repositories/eventRepository';
import { PostgresEventRepository } from '../../repositories/postgresEventRepository';
import { MAX_OUTBOX_ATTEMPTS, type OutboxEvent } from './domainEvents';

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

  for (let depth = 0; depth < 5 && current && !visited.has(current); depth += 1) {
    visited.add(current);
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;

      // discord.js RateLimitError exposes retryAfter in milliseconds.
      const milliseconds = Number(record.retryAfter);
      if (Number.isFinite(milliseconds) && milliseconds > 0) {
        return Math.ceil(milliseconds);
      }

      const raw = record.rawError && typeof record.rawError === 'object'
        ? record.rawError as Record<string, unknown>
        : undefined;
      for (const value of [record.retry_after, raw?.retry_after]) {
        const seconds = Number(value);
        if (value !== undefined && Number.isFinite(seconds) && seconds > 0) {
          return Math.ceil(seconds * 1_000);
        }
      }

      const headers = record.headers as { get?: (name: string) => string | null } | undefined;
      if (headers && typeof headers.get === 'function') {
        const seconds = Number(headers.get('retry-after'));
        if (Number.isFinite(seconds) && seconds > 0) {
          return Math.ceil(seconds * 1_000);
        }
      }

      current = record.cause;
      continue;
    }

    const message = String(current);
    const seconds = message.match(/another\s+(\d+)s\b/i);
    if (seconds) return Number(seconds[1]) * 1_000;
    break;
  }

  const message = error instanceof Error ? error.message : String(error);
  const seconds = message.match(/another\s+(\d+)s\b/i);
  if (seconds) return Number(seconds[1]) * 1_000;
  const milliseconds = message.match(/retry(?:\s+after|After)[=: ]+\s*(\d+)\s*ms/i);
  return milliseconds ? Number(milliseconds[1]) : null;
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

    void processOutboxBatch(publisher)
      .catch((error) => {
        console.error('SupportForge outbox processor failed:', error);
      })
      .finally(() => {
        running = false;
      });
  };

  tick();
  const timer = setInterval(tick, interval);

  return () => clearInterval(timer);
}
