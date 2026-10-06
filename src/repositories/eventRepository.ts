import { randomUUID } from 'node:crypto';

import type {
  DomainEvent,
  EventActorAttribution,
  EventActorConfidence,
  DomainEventType,
  OutboxEvent,
} from '../core/events/domainEvents';
import type { SqliteDatabase } from '../core/persistence/sqliteDatabase';

interface EventRow extends Record<string, unknown> {
  id: string;
  ticket_id: string;
  guild_id: string;
  channel_id: string;
  event_type: DomainEventType;
  actor_id: string;
  actor_attribution: EventActorAttribution;
  actor_confidence: EventActorConfidence;
  payload_json: string;
  created_at: string;
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  aggregate_type: 'ticket';
  aggregate_id: string;
  guild_id: string;
  event_type: DomainEventType;
  payload_json: string;
  status: OutboxEvent['status'];
  attempts: number;
  available_at: string;
  created_at: string;
  processed_at: string | null;
  last_error: string | null;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
    payload: parseObject(row.payload_json),
    occurredAt: row.created_at,
  };
}

function fromOutboxRow(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    guildId: row.guild_id,
    type: row.event_type,
    payload: parseObject(row.payload_json),
    status: row.status,
    attempts: Number(row.attempts),
    availableAt: row.available_at,
    createdAt: row.created_at,
    processedAt: row.processed_at,
    lastError: row.last_error,
  };
}

export interface EventActor {
  id: string;
  attribution?: EventActorAttribution;
  confidence?: EventActorConfidence;
}

export class SqliteEventRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public append(
    event: DomainEvent,
    outboxPayload: Record<string, unknown> = event.payload,
  ): void {
    this.database.prepare(
      'INSERT INTO ticket_events (' +
      'id, ticket_id, guild_id, channel_id, event_type, actor_id, actor_attribution, actor_confidence, payload_json, created_at' +
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
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
    );

    this.database.prepare(
      'INSERT INTO outbox_events (' +
      'id, aggregate_type, aggregate_id, guild_id, event_type, payload_json, status, attempts, available_at, created_at' +
      ') VALUES (?, ?, ?, ?, ?, ?, \'pending\', 0, ?, ?)',
    ).run(
      randomUUID(),
      event.aggregateType,
      event.aggregateId,
      event.guildId,
      event.type,
      JSON.stringify(outboxPayload),
      event.occurredAt,
      event.occurredAt,
    );
  }

  public listTicketEvents(ticketId: string, limit = 500): DomainEvent[] {
    return this.database.prepare(
      'SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at ASC LIMIT ?',
    ).all(ticketId, Math.max(1, Math.min(limit, 5_000)))
      .map((row) => fromEventRow(row as EventRow));
  }

  public listPendingOutbox(limit = 100): OutboxEvent[] {
    return this.database.prepare(
      "SELECT * FROM outbox_events WHERE status = 'pending' AND available_at <= ? ORDER BY created_at ASC LIMIT ?",
    ).all(new Date().toISOString(), Math.max(1, Math.min(limit, 500)))
      .map((row) => fromOutboxRow(row as OutboxRow));
  }

  public markOutboxProcessing(id: string): boolean {
    const result = this.database.prepare(
      "UPDATE outbox_events SET status = 'processing', attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
    ).run(id);
    return Number(result.changes) === 1;
  }

  public markOutboxPublished(id: string, processedAt = new Date().toISOString()): void {
    this.database.prepare(
      "UPDATE outbox_events SET status = 'published', processed_at = ?, last_error = NULL WHERE id = ? AND status = 'processing'",
    ).run(processedAt, id);
  }

  public markOutboxFailed(
    id: string,
    error: string,
    availableAt: string,
  ): void {
    this.database.prepare(
      "UPDATE outbox_events SET status = 'failed', last_error = ?, available_at = ? WHERE id = ? AND status = 'processing'",
    ).run(error.slice(0, 2_000), availableAt, id);
  }

  public requeueProcessing(id: string, availableAt: string): void {
    this.database.prepare(
      "UPDATE outbox_events SET status = 'pending', available_at = ? WHERE id = ? AND status = 'processing'",
    ).run(availableAt, id);
  }

  public listOutbox(status?: OutboxEvent['status'], limit = 500): OutboxEvent[] {
    const safeLimit = Math.max(1, Math.min(limit, 5_000));
    if (!status) {
      return this.database.prepare(
        'SELECT * FROM outbox_events ORDER BY created_at ASC LIMIT ?',
      ).all(safeLimit).map((row) => fromOutboxRow(row as OutboxRow));
    }

    return this.database.prepare(
      'SELECT * FROM outbox_events WHERE status = ? ORDER BY created_at ASC LIMIT ?',
    ).all(status, safeLimit).map((row) => fromOutboxRow(row as OutboxRow));
  }
}
