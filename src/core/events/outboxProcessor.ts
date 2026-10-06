import { getSupportForgeDatabase } from '../persistence/sqliteDatabase';
import {
  SqliteEventRepository,
} from '../../repositories/eventRepository';
import type { OutboxEvent } from './domainEvents';

const MAX_BATCH_SIZE = 100;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const STALE_PROCESSING_MS = 10 * 60_000;

export interface OutboxPublisher {
  publish(event: OutboxEvent): Promise<void>;
}

export interface OutboxProcessResult {
  claimed: number;
  published: number;
  failed: number;
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 0), 10);
  return Math.min(1_000 * 2 ** exponent, MAX_RETRY_DELAY_MS);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publishes durable outbox records. Claiming is conditional, so duplicate
 * workers cannot both process the same pending record.
 *
 * Delivery is intentionally at-least-once. Consumers must use the durable
 * outbox event id as their idempotency key because a crash can happen after
 * an external side effect but before the published marker is committed.
 */
export async function processOutboxBatch(
  publisher: OutboxPublisher,
  limit = MAX_BATCH_SIZE,
): Promise<OutboxProcessResult> {
  const database = getSupportForgeDatabase();
  const repository = new SqliteEventRepository(database);
  const safeLimit = Math.max(1, Math.min(limit, MAX_BATCH_SIZE));

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
      const delay = retryDelayMs(event.attempts + 1);
      repository.markOutboxFailed(
        event.id,
        errorMessage(error),
        new Date(Date.now() + delay).toISOString(),
      );
    }
  }

  return { claimed, published, failed };
}

/**
 * A small bounded scheduler for process-level workers. The scheduler does not
 * own business state, and stopping it never loses events because events remain
 * durable until successfully published.
 */
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
