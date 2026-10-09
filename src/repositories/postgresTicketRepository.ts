import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import {
  assertTicketStatusTransition,
  type TicketStatus,
} from '../core/domain/ticketLifecycle';
import type { EventActor } from '../core/events/domainEvents';
import { getPostgresPool } from '../core/persistence/postgresDatabase';
import type { DatabaseExecutor } from '../core/persistence/database';
import {
  PostgresEventRepository,
} from './postgresEventRepository';
import type { TicketRepositoryRecord } from './ticketRepository';

interface TicketRow extends QueryResultRow {
  id: string;
  guild_id: string;
  channel_id: string;
  ticket_number: string | null;
  status: TicketStatus;
  department_id: string | null;
  tag_id: string | null;
  owner_id: string | null;
  priority: string | null;
  claimed_by_ids: string[] | null;
  participant_ids: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
  deletion_reason: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: TicketRow): TicketRepositoryRecord {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    ticketNumber: row.ticket_number,
    status: row.status,
    departmentId: row.department_id,
    tagId: row.tag_id,
    ownerId: row.owner_id,
    priority: row.priority,
    claimedByIds: Array.isArray(row.claimed_by_ids) ? row.claimed_by_ids : [],
    participantIds: Array.isArray(row.participant_ids) ? row.participant_ids : [],
    metadata:
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? row.metadata
        : {},
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
    deletionReason: row.deletion_reason,
  };
}

export interface AsyncTicketRepository {
  getByChannelId(channelId: string): Promise<TicketRepositoryRecord | undefined>;
  listByGuildId(guildId: string): Promise<TicketRepositoryRecord[]>;
  findActiveByOwnerAndDepartment(
    guildId: string,
    ownerId: string,
    departmentId: string,
  ): Promise<TicketRepositoryRecord[]>;
  listAll(): Promise<TicketRepositoryRecord[]>;
  upsert(record: TicketRepositoryRecord): Promise<void>;
  create(record: TicketRepositoryRecord, actor?: EventActor): Promise<void>;
  listEvents(channelId: string, limit?: number): Promise<import('../core/events/domainEvents').DomainEvent[]>;
  setStatus(channelId: string, status: TicketStatus, updatedAt: string): Promise<void>;
  transitionStatus(
    channelId: string,
    status: TicketStatus,
    updatedAt: string,
    actor?: EventActor,
  ): Promise<void>;
  updateMetadata(
    channelId: string,
    updates: Partial<
      Pick<
        TicketRepositoryRecord,
        | 'departmentId'
        | 'tagId'
        | 'ownerId'
        | 'priority'
        | 'claimedByIds'
        | 'participantIds'
        | 'metadata'
      >
    >,
    updatedAt: string,
    actor?: EventActor,
  ): Promise<void>;
  markDeleted(channelId: string, deletedAt: string, reason: string, actor?: EventActor): Promise<void>;
  remove(channelId: string): Promise<void>;
  clearAll(): Promise<void>;
}

const DEFAULT_ACTOR: EventActor = {
  id: 'supportforge-system',
  attribution: 'actorKnown',
  confidence: 'high',
};

function resolveActor(actor?: EventActor): Required<EventActor> {
  return {
    id: actor?.id ?? DEFAULT_ACTOR.id,
    attribution: actor?.attribution ?? DEFAULT_ACTOR.attribution!,
    confidence: actor?.confidence ?? DEFAULT_ACTOR.confidence!,
  };
}

function insertParameters(record: TicketRepositoryRecord): unknown[] {
  return [
    record.id,
    record.guildId,
    record.channelId,
    record.ticketNumber,
    record.status,
    record.departmentId,
    record.tagId,
    record.ownerId,
    record.priority,
    record.claimedByIds,
    record.participantIds,
    JSON.stringify(record.metadata),
    record.createdAt,
    record.updatedAt,
    record.deletedAt,
    record.deletionReason,
  ];
}

export class PostgresTicketRepository implements AsyncTicketRepository {
  private readonly executor: DatabaseExecutor;
  private readonly events: PostgresEventRepository;

  public constructor(executor: DatabaseExecutor = getPostgresPool()) {
    this.executor = executor;
    this.events = new PostgresEventRepository(executor);
  }

  public async getByChannelId(
    channelId: string,
  ): Promise<TicketRepositoryRecord | undefined> {
    const result = await this.executor.query<TicketRow>(
      'SELECT * FROM tickets WHERE channel_id = $1 LIMIT 1',
      [channelId],
    );
    const row = result.rows[0];
    return row ? fromRow(row) : undefined;
  }

  public async listByGuildId(guildId: string): Promise<TicketRepositoryRecord[]> {
    const result = await this.executor.query<TicketRow>(
      'SELECT * FROM tickets WHERE guild_id = $1 ORDER BY created_at ASC',
      [guildId],
    );
    return result.rows.map(fromRow);
  }

  public async findActiveByOwnerAndDepartment(
    guildId: string,
    ownerId: string,
    departmentId: string,
  ): Promise<TicketRepositoryRecord[]> {
    const result = await this.executor.query<TicketRow>(
      "SELECT * FROM tickets WHERE guild_id = $1 AND owner_id = $2 AND department_id = $3 AND deleted_at IS NULL AND status IN ('open', 'claimed', 'pending', 'reopened') ORDER BY created_at ASC",
      [guildId, ownerId, departmentId],
    );
    return result.rows.map(fromRow);
  }

  public async listAll(): Promise<TicketRepositoryRecord[]> {
    const result = await this.executor.query<TicketRow>(
      'SELECT * FROM tickets ORDER BY created_at ASC',
    );
    return result.rows.map(fromRow);
  }

  public async create(record: TicketRepositoryRecord, actor?: EventActor): Promise<void> {
    const client = await getPostgresPool().connect();

    try {
      await client.query('BEGIN');

      await client.query(
        'INSERT INTO tickets (' +
          'id, guild_id, channel_id, ticket_number, status, department_id, tag_id, owner_id, priority, claimed_by_ids, participant_ids, metadata, created_at, updated_at, deleted_at, deletion_reason' +
          ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[], $12::jsonb, $13::timestamptz, $14::timestamptz, $15::timestamptz, $16)',
        insertParameters(record),
      );

      await this.events.append({
        id: randomUUID(),
        type: 'ticket.created',
        aggregateType: 'ticket',
        aggregateId: record.id,
        guildId: record.guildId,
        channelId: record.channelId,
        actorId: resolveActor(actor).id,
        actorAttribution: resolveActor(actor).attribution,
        actorConfidence: resolveActor(actor).confidence,
        payload: {
          status: record.status,
          ticketNumber: record.ticketNumber ?? '',
          departmentId: record.departmentId ?? '',
          ownerId: record.ownerId ?? '',
        },
        occurredAt: record.createdAt,
      }, undefined, client);

      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve original transaction error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async upsert(record: TicketRepositoryRecord): Promise<void> {
    await this.executor.query(
      'INSERT INTO tickets (' +
        'id, guild_id, channel_id, ticket_number, status, department_id, tag_id, owner_id, priority, claimed_by_ids, participant_ids, metadata, created_at, updated_at, deleted_at, deletion_reason' +
        ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[], $12::jsonb, $13::timestamptz, $14::timestamptz, $15::timestamptz, $16) ' +
        'ON CONFLICT(channel_id) DO UPDATE SET ' +
        'ticket_number = EXCLUDED.ticket_number, status = EXCLUDED.status, department_id = EXCLUDED.department_id, tag_id = EXCLUDED.tag_id, owner_id = EXCLUDED.owner_id, priority = EXCLUDED.priority, claimed_by_ids = EXCLUDED.claimed_by_ids, participant_ids = EXCLUDED.participant_ids, metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at, deleted_at = EXCLUDED.deleted_at, deletion_reason = EXCLUDED.deletion_reason',
      insertParameters(record),
    );
  }

  public async setStatus(
    channelId: string,
    status: TicketStatus,
    updatedAt: string,
  ): Promise<void> {
    await this.transitionStatus(channelId, status, updatedAt);
  }

  public async transitionStatus(
    channelId: string,
    status: TicketStatus,
    updatedAt: string,
    actor?: EventActor,
  ): Promise<void> {
    const current = await this.getByChannelId(channelId);
    if (!current) {
      throw new Error(
        `Cannot transition SupportForge ticket ${channelId}: ticket does not exist in durable storage.`,
      );
    }

    if (current.status === status) return;

    assertTicketStatusTransition(current.status, status);
    const client = await getPostgresPool().connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        'UPDATE tickets SET status = $1, updated_at = $2::timestamptz WHERE channel_id = $3 AND status = $4',
        [status, updatedAt, channelId, current.status],
      );

      if ((result.rowCount ?? 0) !== 1) {
        throw new Error(
          `Ticket ${channelId} changed concurrently while transitioning from ${current.status} to ${status}.`,
        );
      }

      const resolved = resolveActor(actor);
      await this.events.append({
        id: randomUUID(),
        type: 'ticket.status_changed',
        aggregateType: 'ticket',
        aggregateId: current.id,
        guildId: current.guildId,
        channelId: current.channelId,
        actorId: resolved.id,
        actorAttribution: resolved.attribution,
        actorConfidence: resolved.confidence,
        payload: { from: current.status, to: status },
        occurredAt: updatedAt,
      }, undefined, client);

      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve original transaction error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async updateMetadata(
    channelId: string,
    updates: Partial<
      Pick<
        TicketRepositoryRecord,
        | 'departmentId'
        | 'tagId'
        | 'ownerId'
        | 'priority'
        | 'claimedByIds'
        | 'participantIds'
        | 'metadata'
      >
    >,
    updatedAt: string,
    actor?: EventActor,
  ): Promise<void> {
    const client = await getPostgresPool().connect();

    try {
      await client.query('BEGIN');

      /*
       * Lock the current row inside the transaction. A simple read followed
       * by an update can lose concurrent metadata changes from another bot
       * process. Row-level locking keeps the merged update and its audit event
       * based on one authoritative snapshot.
       */
      const currentResult = await client.query<TicketRow>(
        'SELECT * FROM tickets WHERE channel_id = $1 FOR UPDATE',
        [channelId],
      );
      const current = currentResult.rows[0];

      if (!current) {
        throw new Error(
          `Cannot update SupportForge ticket ${channelId}: durable ticket record does not exist.`,
        );
      }

      const currentRecord = fromRow(current);
      const next: TicketRepositoryRecord = {
        ...currentRecord,
        ...updates,
        claimedByIds: updates.claimedByIds ?? currentRecord.claimedByIds,
        participantIds: updates.participantIds ?? currentRecord.participantIds,
        metadata: updates.metadata ?? currentRecord.metadata,
        updatedAt,
      };

      const result = await client.query(
        'UPDATE tickets SET department_id = $1, tag_id = $2, owner_id = $3, priority = $4, claimed_by_ids = $5::text[], participant_ids = $6::text[], metadata = $7::jsonb, updated_at = $8::timestamptz WHERE channel_id = $9',
        [
          next.departmentId,
          next.tagId,
          next.ownerId,
          next.priority,
          next.claimedByIds,
          next.participantIds,
          JSON.stringify(next.metadata),
          updatedAt,
          channelId,
        ],
      );

      if ((result.rowCount ?? 0) !== 1) {
        throw new Error(
          `SupportForge ticket ${channelId} disappeared during metadata update.`,
        );
      }

      const changedFields = (
        [
          'departmentId',
          'tagId',
          'ownerId',
          'priority',
          'claimedByIds',
          'participantIds',
          'metadata',
        ] as const
      ).filter((key) => updates[key] !== undefined);

      if (changedFields.length > 0) {
        const resolved = resolveActor(actor);
        await this.events.append({
          id: randomUUID(),
          type: 'ticket.metadata_changed',
          aggregateType: 'ticket',
          aggregateId: currentRecord.id,
          guildId: currentRecord.guildId,
          channelId: currentRecord.channelId,
          actorId: resolved.id,
          actorAttribution: resolved.attribution,
          actorConfidence: resolved.confidence,
          payload: { changedFields },
          occurredAt: updatedAt,
        }, undefined, client);
      }

      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve original transaction error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async listEvents(
    channelId: string,
    limit = 500,
  ): Promise<import('../core/events/domainEvents').DomainEvent[]> {
    const current = await this.getByChannelId(channelId);
    return current
      ? this.events.listTicketEvents(current.id, limit)
      : [];
  }

  public async markDeleted(
    channelId: string,
    deletedAt: string,
    reason: string,
    actor?: EventActor,
  ): Promise<void> {
    const current = await this.getByChannelId(channelId);
    if (!current) return;

    const client = await getPostgresPool().connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        'UPDATE tickets SET deleted_at = $1::timestamptz, deletion_reason = $2, updated_at = $1::timestamptz WHERE channel_id = $3 AND deleted_at IS NULL',
        [deletedAt, reason, channelId],
      );

      if ((result.rowCount ?? 0) === 1) {
        const resolved = resolveActor(actor);
        await this.events.append({
          id: randomUUID(),
          type: 'ticket.deleted',
          aggregateType: 'ticket',
          aggregateId: current.id,
          guildId: current.guildId,
          channelId: current.channelId,
          actorId: resolved.id,
          actorAttribution: resolved.attribution,
          actorConfidence: resolved.confidence,
          payload: { reason },
          occurredAt: deletedAt,
        }, undefined, client);
      }

      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve original transaction error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async remove(channelId: string): Promise<void> {
    await this.executor.query(
      'DELETE FROM tickets WHERE channel_id = $1',
      [channelId],
    );
  }

  public async clearAll(): Promise<void> {
    await this.executor.query('DELETE FROM tickets');
  }
}
