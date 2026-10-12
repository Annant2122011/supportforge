import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import type {
  DomainEvent,
  DomainEventType,
  EventActorAttribution,
  EventActorConfidence,
  OutboxEvent,
} from '../core/events/domainEvents';
import { getPostgresPool } from '../core/persistence/postgresDatabase';
import type { DatabaseExecutor, TransactionExecutor } from '../core/persistence/database';

interface EventRow extends QueryResultRow {
  id: string;
  ticket_id: string;
  guild_id: string;
  channel_id: string;
  event_type: DomainEventType;
  actor_id: string;
  actor_attribution: EventActorAttribution;
  actor_confidence: EventActorConfidence;
  payload: Record<string, unknown> | null;
  created_at: Date | string;
}

interface OutboxRow extends QueryResultRow {
  id: string;
  aggregate_type: 'ticket';
  aggregate_id: string;
  guild_id: string;
  event_type: DomainEventType;
  payload: Record<string, unknown> | null;
  status: OutboxEvent['status'];
  attempts: number;
  available_at: Date | string;
  created_at: Date | string;
  processed_at: Date | string | null;
  processing_started_at: Date | string | null;
  last_error: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function objectValue(value: Record<string, unknown> | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function fromEventRow(row: EventRow): DomainEvent {
  return {
    id: row.id,
    type: row.event_type,
    aggregateType: 'ticket',
    aggregateId: row.ticket_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    actorId: row.actor_id,
    actorAttribution: row.actor_attribution,
    actorConfidence: row.actor_confidence,
    payload: objectValue(row.payload),
    occurredAt: iso(row.created_at) as string,
  };
}

function fromOutboxRow(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    guildId: row.guild_id,
    type: row.event_type,
    payload: objectValue(row.payload),
    status: row.status,
    attempts: Number(row.attempts),
    availableAt: iso(row.available_at) as string,
    createdAt: iso(row.created_at) as string,
    processedAt: iso(row.processed_at),
    lastError: row.last_error,
  };
}

export class PostgresEventRepository {
  private readonly executor: DatabaseExecutor;

  public constructor(executor: DatabaseExecutor = getPostgresPool()) {
    this.executor = executor;
  }

  public async append(
    event: DomainEvent,
    outboxPayload: Record<string, unknown> = event.payload,
    executor: DatabaseExecutor = this.executor,
  ): Promise<void> {
    await executor.query(
      'INSERT INTO ticket_events (' +
        'id, ticket_id, guild_id, channel_id, event_type, actor_id, actor_attribution, actor_confidence, payload, created_at' +
        ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz)',
      [
        event.id,
        event.aggregateId,
        event.guildId,
        event.channelId,
        event.type,
        event.actorId,
        event.actorAttribution,
        event.actorConfidence,
        JSON.stringify(event.payload),
        event.occurredAt,
      ],
    );

    await executor.query(
      'INSERT INTO outbox_events (' +
        'id, aggregate_type, aggregate_id, guild_id, event_type, payload, status, attempts, available_at, created_at' +
        ') VALUES ($1, $2, $3, $4, $5, $6::jsonb, \'pending\', 0, $7::timestamptz, $8::timestamptz)',
      [
        randomUUID(),
        event.aggregateType,
        event.aggregateId,
        event.guildId,
        event.type,
        JSON.stringify(outboxPayload),
        event.occurredAt,
        event.occurredAt,
      ],
    );
  }

  public async listTicketEvents(ticketId: string, limit = 500): Promise<DomainEvent[]> {
    const safeLimit = Math.max(1, Math.min(limit, 5_000));
    const result = await this.executor.query<EventRow>(
      'SELECT * FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at ASC LIMIT $2',
      [ticketId, safeLimit],
    );
    return result.rows.map(fromEventRow);
  }

  public async recoverStaleProcessing(
    olderThan: string,
    availableAt = new Date().toISOString(),
  ): Promise<number> {
    const result = await this.executor.query(
      "UPDATE outbox_events SET status = 'pending', available_at = $1::timestamptz, processing_started_at = NULL WHERE status = 'processing' AND processing_started_at < $2::timestamptz",
      [availableAt, olderThan],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Atomically claims pending work. FOR UPDATE SKIP LOCKED prevents two
   * process workers from claiming the same event.
   */
  public async claimPendingOutbox(limit = 100): Promise<OutboxEvent[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const client = await getPostgresPool().connect();

    try {
      await client.query('BEGIN');

      const result = await client.query<OutboxRow>(
        "WITH candidates AS (" +
          "SELECT id FROM outbox_events " +
          "WHERE status IN ('pending', 'failed') AND available_at <= NOW() " +
          "ORDER BY created_at ASC " +
          "LIMIT $1 " +
          "FOR UPDATE SKIP LOCKED" +
        ") " +
        "UPDATE outbox_events AS o " +
        "SET status = 'processing', attempts = o.attempts + 1, processing_started_at = NOW() " +
        "FROM candidates " +
        "WHERE o.id = candidates.id " +
        "RETURNING o.*",
        [safeLimit],
      );

      await client.query('COMMIT');
      return result.rows.map(fromOutboxRow);
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async listPendingOutbox(limit = 100): Promise<OutboxEvent[]> {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const result = await this.executor.query<OutboxRow>(
      "SELECT * FROM outbox_events WHERE status IN ('pending', 'failed') AND available_at <= NOW() ORDER BY created_at ASC LIMIT $1",
      [safeLimit],
    );
    return result.rows.map(fromOutboxRow);
  }

  public async markOutboxProcessing(id: string): Promise<boolean> {
    const result = await this.executor.query(
      "UPDATE outbox_events SET status = 'processing', attempts = attempts + 1, processing_started_at = NOW() WHERE id = $1 AND status IN ('pending', 'failed')",
      [id],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markOutboxPublished(
    id: string,
    processedAt = new Date().toISOString(),
  ): Promise<boolean> {
    const result = await this.executor.query(
      "UPDATE outbox_events SET status = 'published', processed_at = $1::timestamptz, processing_started_at = NULL, last_error = NULL WHERE id = $2 AND status = 'processing'",
      [processedAt, id],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markOutboxFailed(
    id: string,
    error: string,
    availableAt: string,
  ): Promise<boolean> {
    const result = await this.executor.query(
      "UPDATE outbox_events SET status = 'failed', last_error = $1, available_at = $2::timestamptz, processing_started_at = NULL WHERE id = $3 AND status = 'processing'",
      [error.slice(0, 2_000), availableAt, id],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async requeueProcessing(id: string, availableAt: string): Promise<boolean> {
    const result = await this.executor.query(
      "UPDATE outbox_events SET status = 'pending', available_at = $1::timestamptz, processing_started_at = NULL WHERE id = $2 AND status = 'processing'",
      [availableAt, id],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async requeueFailed(id: string, availableAt: string): Promise<boolean> {
    const result = await this.executor.query(
      "UPDATE outbox_events SET status = 'pending', available_at = $1::timestamptz, last_error = NULL WHERE id = $2 AND status = 'failed'",
      [availableAt, id],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async listOutbox(
    status?: OutboxEvent['status'],
    limit = 500,
  ): Promise<OutboxEvent[]> {
    const safeLimit = Math.max(1, Math.min(limit, 5_000));
    const result = status
      ? await this.executor.query<OutboxRow>(
          'SELECT * FROM outbox_events WHERE status = $1 ORDER BY created_at ASC LIMIT $2',
          [status, safeLimit],
        )
      : await this.executor.query<OutboxRow>(
          'SELECT * FROM outbox_events ORDER BY created_at ASC LIMIT $1',
          [safeLimit],
        );

    return result.rows.map(fromOutboxRow);
  }
}
