import {
  assertTicketStatusTransition,
  type TicketStatus,
} from '../core/domain/ticketLifecycle';
import { randomUUID } from 'node:crypto';
import { SqliteEventRepository } from './eventRepository';
import type { DomainEventType, EventActor } from '../core/events/domainEvents';
import {
  getSupportForgeDatabase,
  type SqliteDatabase,
} from '../core/persistence/sqliteDatabase';

export interface TicketRepositoryRecord {
  id: string;
  guildId: string;
  channelId: string;
  ticketNumber: string | null;
  status: TicketStatus;
  departmentId: string | null;
  tagId: string | null;
  ownerId: string | null;
  priority: string | null;
  claimedByIds: string[];
  participantIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletionReason: string | null;
}

export interface TicketRepository {
  getByChannelId(channelId: string): TicketRepositoryRecord | undefined;
  getById(ticketId: string): TicketRepositoryRecord | undefined;
  listByGuildId(guildId: string): TicketRepositoryRecord[];
  findActiveByOwnerAndDepartment(
    guildId: string,
    ownerId: string,
    departmentId: string,
  ): TicketRepositoryRecord[];
  listAll(): TicketRepositoryRecord[];
  upsert(record: TicketRepositoryRecord): void;
  create(record: TicketRepositoryRecord, actor?: EventActor): void;
  listEvents(channelId: string, limit?: number): import('../core/events/domainEvents').DomainEvent[];
  setStatus(channelId: string, status: TicketStatus, updatedAt: string): void;
  transitionStatus(
    channelId: string,
    status: TicketStatus,
    updatedAt: string,
    actor?: EventActor,
  ): void;
  transitionStatusAndMetadata(
    channelId: string,
    status: TicketStatus,
    updates: TicketMetadataUpdates,
    updatedAt: string,
    actor?: EventActor,
  ): void;
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
  ): void;
  markDeleted(channelId: string, deletedAt: string, reason: string): void;
  remove(channelId: string): void;
  clearAll(): void;
}

export type TicketMetadataUpdates = Partial<
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
>;

interface TicketRow extends Record<string, unknown> {
  id: string;
  guild_id: string;
  channel_id: string;
  ticket_number: string | null;
  status: TicketStatus;
  department_id: string | null;
  tag_id: string | null;
  owner_id: string | null;
  priority: string | null;
  claimed_by_json: string;
  participant_ids_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deletion_reason: string | null;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function lifecycleEventType(from: TicketStatus, to: TicketStatus): DomainEventType {
  if (to === 'claimed') return 'ticket.claimed';
  if (to === 'pending') return 'ticket.pending';
  if (to === 'closed') return 'ticket.closed';
  if (to === 'reopened') return 'ticket.reopened';
  if (to === 'archived') return 'ticket.archived';
  if (from === 'claimed' && to === 'open') return 'ticket.unclaimed';
  if (from === 'pending' && to === 'open') return 'ticket.resumed';
  return 'ticket.status_changed';
}

function metadataEventType(
  changedFields: string[],
  current: TicketRepositoryRecord,
  updates: Partial<Pick<TicketRepositoryRecord,
    'departmentId' | 'tagId' | 'ownerId' | 'priority' |
    'claimedByIds' | 'participantIds' | 'metadata'>>,
): DomainEventType {
  if (changedFields.length === 1) {
    const field = changedFields[0];
    if (field === 'priority') return 'ticket.priority.changed';
    if (field === 'departmentId') return 'ticket.department.changed';
    if (field === 'tagId') return 'ticket.tag.changed';
    if (field === 'participantIds' && updates.participantIds) {
      const before = new Set(current.participantIds);
      const after = new Set(updates.participantIds);
      const added = [...after].filter((id) => !before.has(id));
      const removed = [...before].filter((id) => !after.has(id));
      if (added.length === 1 && removed.length === 0) return 'ticket.participant.added';
      if (removed.length === 1 && added.length === 0) return 'ticket.participant.removed';
    }
  }
  return 'ticket.metadata_changed';
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
    claimedByIds: parseStringArray(row.claimed_by_json),
    participantIds: parseStringArray(row.participant_ids_json),
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletionReason: row.deletion_reason,
  };
}

export class SqliteTicketRepository implements TicketRepository {
  private readonly database: SqliteDatabase;
  private readonly events: SqliteEventRepository;

  public constructor(database = getSupportForgeDatabase()) {
    this.database = database;
    this.events = new SqliteEventRepository(database);
  }

  public getById(ticketId: string): TicketRepositoryRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM tickets WHERE id = ? LIMIT 1')
      .get(ticketId) as TicketRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  public getByChannelId(channelId: string): TicketRepositoryRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM tickets WHERE channel_id = ? LIMIT 1')
      .get(channelId) as TicketRow | undefined;

    return row ? fromRow(row) : undefined;
  }

  public listByGuildId(guildId: string): TicketRepositoryRecord[] {
    return this.database
      .prepare('SELECT * FROM tickets WHERE guild_id = ? ORDER BY created_at ASC')
      .all(guildId)
      .map((row) => fromRow(row as TicketRow));
  }

  public findActiveByOwnerAndDepartment(
    guildId: string,
    ownerId: string,
    departmentId: string,
  ): TicketRepositoryRecord[] {
    return this.database
      .prepare(
        "SELECT * FROM tickets " +
        "WHERE guild_id = ? " +
        "AND owner_id = ? " +
        "AND department_id = ? " +
        "AND deleted_at IS NULL " +
        "AND status IN ('open', 'claimed', 'pending', 'reopened') " +
        "ORDER BY created_at ASC",
      )
      .all(guildId, ownerId, departmentId)
      .map((row) => fromRow(row as TicketRow));
  }

  public listAll(): TicketRepositoryRecord[] {
    return this.database
      .prepare('SELECT * FROM tickets ORDER BY created_at ASC')
      .all()
      .map((row) => fromRow(row as TicketRow));
  }

  public create(
    record: TicketRepositoryRecord,
    actor: EventActor = {
      id: 'supportforge-system',
      attribution: 'actorKnown',
      confidence: 'high',
    },
  ): void {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      this.database.prepare(
        'INSERT INTO tickets (' +
        'id, guild_id, channel_id, ticket_number, status, department_id, tag_id, owner_id, priority, ' +
        'claimed_by_json, participant_ids_json, metadata_json, created_at, updated_at, deleted_at, deletion_reason' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        record.id,
        record.guildId,
        record.channelId,
        record.ticketNumber,
        record.status,
        record.departmentId,
        record.tagId,
        record.ownerId,
        record.priority,
        JSON.stringify(record.claimedByIds),
        JSON.stringify(record.participantIds),
        JSON.stringify(record.metadata),
        record.createdAt,
        record.updatedAt,
        record.deletedAt,
        record.deletionReason,
      );

      this.events.append({
        id: randomUUID(),
        type: 'ticket.created',
        aggregateType: 'ticket',
        aggregateId: record.id,
        guildId: record.guildId,
        channelId: record.channelId,
        actorId: actor.id,
        actorAttribution: actor.attribution ?? 'actorUnknown',
        actorConfidence: actor.confidence ?? 'none',
        payload: {
          status: record.status,
          ticketNumber: record.ticketNumber ?? '',
          departmentId: record.departmentId ?? '',
          ownerId: record.ownerId ?? '',
        },
        occurredAt: record.createdAt,
      });

      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  public listEvents(
    channelId: string,
    limit = 500,
  ): import('../core/events/domainEvents').DomainEvent[] {
    const record = this.getByChannelId(channelId);
    return record ? this.events.listTicketEvents(record.id, limit) : [];
  }

  public upsert(record: TicketRepositoryRecord): void {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      this.database.prepare(
        'INSERT INTO tickets (' +
        'id, guild_id, channel_id, ticket_number, status, department_id, tag_id, owner_id, priority, ' +
        'claimed_by_json, participant_ids_json, metadata_json, created_at, updated_at, deleted_at, deletion_reason' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(channel_id) DO UPDATE SET ' +
        'ticket_number = excluded.ticket_number, status = excluded.status, department_id = excluded.department_id, ' +
        'tag_id = excluded.tag_id, owner_id = excluded.owner_id, priority = excluded.priority, ' +
        'claimed_by_json = excluded.claimed_by_json, participant_ids_json = excluded.participant_ids_json, ' +
        'metadata_json = excluded.metadata_json, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, ' +
        'deletion_reason = excluded.deletion_reason',
      ).run(
        record.id,
        record.guildId,
        record.channelId,
        record.ticketNumber,
        record.status,
        record.departmentId,
        record.tagId,
        record.ownerId,
        record.priority,
        JSON.stringify(record.claimedByIds),
        JSON.stringify(record.participantIds),
        JSON.stringify(record.metadata),
        record.createdAt,
        record.updatedAt,
        record.deletedAt,
        record.deletionReason,
      );

      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original persistence error.
      }
      throw error;
    }
  }

  public setStatus(
    channelId: string,
    status: TicketStatus,
    updatedAt: string,
  ): void {
    this.transitionStatus(channelId, status, updatedAt);
  }

  public transitionStatus(
    channelId: string,
    status: TicketStatus,
    updatedAt: string,
    actor: EventActor = {
      id: 'supportforge-system',
      attribution: 'actorKnown',
      confidence: 'high',
    },
  ): void {
    const current = this.getByChannelId(channelId);
    if (!current) {
      throw new Error(
        `Cannot transition SupportForge ticket ${channelId}: ticket does not exist in durable storage.`,
      );
    }

    if (current.status === status) {
      return;
    }

    assertTicketStatusTransition(current.status, status);

    this.database.exec('BEGIN IMMEDIATE');

    try {
      const result = this.database.prepare(
        'UPDATE tickets SET status = ?, updated_at = ? WHERE channel_id = ? AND status = ?',
      ).run(status, updatedAt, channelId, current.status);

      if (Number(result.changes) !== 1) {
        throw new Error(
          `Ticket ${channelId} changed concurrently while transitioning from ${current.status} to ${status}.`,
        );
      }

      this.events.append({
        id: randomUUID(),
        type: lifecycleEventType(current.status, status),
        aggregateType: 'ticket',
        aggregateId: current.id,
        guildId: current.guildId,
        channelId: current.channelId,
        actorId: actor.id,
        actorAttribution: actor.attribution ?? 'actorUnknown',
        actorConfidence: actor.confidence ?? 'none',
        payload: {
          from: current.status,
          to: status,
        },
        occurredAt: updatedAt,
      });

      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  /**
   * Commits lifecycle state and associated metadata in one SQLite transaction.
   * Event history and outbox intents are included in that same transaction.
   */
  public transitionStatusAndMetadata(
    channelId: string,
    status: TicketStatus,
    updates: TicketMetadataUpdates,
    updatedAt: string,
    actor: EventActor = {
      id: 'supportforge-system',
      attribution: 'actorKnown',
      confidence: 'high',
    },
  ): void {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      const current = this.getByChannelId(channelId);
      if (!current) {
        throw new Error(
          `Cannot transition SupportForge ticket ${channelId}: ticket does not exist in durable storage.`,
        );
      }

      const statusChanged = current.status !== status;
      if (statusChanged) assertTicketStatusTransition(current.status, status);

      const changedFields = Object.keys(updates).filter(
        (key) => updates[key as keyof TicketMetadataUpdates] !== undefined,
      );
      if (!statusChanged && changedFields.length === 0) {
        this.database.exec('COMMIT');
        return;
      }

      const assignments: string[] = [];
      const parameters: unknown[] = [];
      const add = (column: string, value: unknown): void => {
        assignments.push(column + ' = ?');
        parameters.push(value);
      };

      if (statusChanged) add('status', status);
      if (updates.departmentId !== undefined) add('department_id', updates.departmentId);
      if (updates.tagId !== undefined) add('tag_id', updates.tagId);
      if (updates.ownerId !== undefined) add('owner_id', updates.ownerId);
      if (updates.priority !== undefined) add('priority', updates.priority);
      if (updates.claimedByIds !== undefined) add('claimed_by_json', JSON.stringify(updates.claimedByIds));
      if (updates.participantIds !== undefined) add('participant_ids_json', JSON.stringify(updates.participantIds));
      if (updates.metadata !== undefined) add('metadata_json', JSON.stringify({ ...current.metadata, ...updates.metadata }));

      add('updated_at', updatedAt);
      parameters.push(channelId, current.status);

      const result = this.database.prepare(
        'UPDATE tickets SET ' + assignments.join(', ') +
        ' WHERE channel_id = ? AND status = ?',
      ).run(...parameters);

      if (Number(result.changes) !== 1) {
        throw new Error(
          `Ticket ${channelId} changed concurrently while applying a lifecycle and metadata transaction.`,
        );
      }

      if (statusChanged) {
        this.events.append({
          id: randomUUID(),
          type: lifecycleEventType(current.status, status),
          aggregateType: 'ticket',
          aggregateId: current.id,
          guildId: current.guildId,
          channelId: current.channelId,
          actorId: actor.id,
          actorAttribution: actor.attribution ?? 'actorUnknown',
          actorConfidence: actor.confidence ?? 'none',
          payload: { from: current.status, to: status, changedFields },
          occurredAt: updatedAt,
        });
      }

      if (changedFields.length > 0) {
        this.events.append({
          id: randomUUID(),
          type: metadataEventType(changedFields, current, updates),
          aggregateType: 'ticket',
          aggregateId: current.id,
          guildId: current.guildId,
          channelId: current.channelId,
          actorId: actor.id,
          actorAttribution: actor.attribution ?? 'actorUnknown',
          actorConfidence: actor.confidence ?? 'none',
          payload: { changedFields },
          occurredAt: updatedAt,
        });
      }

      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  public updateMetadata(
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
    actor: EventActor = {
      id: 'supportforge-system',
      attribution: 'actorKnown',
      confidence: 'high',
    },
  ): void {
    const current = this.getByChannelId(channelId);
    if (!current) {
      throw new Error(
        `Cannot update SupportForge ticket ${channelId}: durable ticket record does not exist.`,
      );
    }

    const assignments: string[] = [];
    const parameters: unknown[] = [];

    const add = (column: string, value: unknown): void => {
      assignments.push(column + ' = ?');
      parameters.push(value);
    };

    if (updates.departmentId !== undefined) add('department_id', updates.departmentId);
    if (updates.tagId !== undefined) add('tag_id', updates.tagId);
    if (updates.ownerId !== undefined) add('owner_id', updates.ownerId);
    if (updates.priority !== undefined) add('priority', updates.priority);
    if (updates.claimedByIds !== undefined) add(
      'claimed_by_json',
      JSON.stringify(updates.claimedByIds),
    );
    if (updates.participantIds !== undefined) add(
      'participant_ids_json',
      JSON.stringify(updates.participantIds),
    );
    if (updates.metadata !== undefined) add(
      'metadata_json',
      JSON.stringify(updates.metadata),
    );

    if (assignments.length === 0) return;

    assignments.push('updated_at = ?');
    parameters.push(updatedAt);
    parameters.push(channelId);

    this.database.exec('BEGIN IMMEDIATE');

    try {
      const result = this.database
        .prepare(
          'UPDATE tickets SET ' +
          assignments.join(', ') +
          ' WHERE channel_id = ?',
        )
        .run(...parameters);

      if (Number(result.changes) !== 1) {
        throw new Error(
          `SupportForge ticket ${channelId} disappeared during metadata update.`,
        );
      }

      this.events.append({
        id: randomUUID(),
        type: metadataEventType(Object.keys(updates), current, updates),
        aggregateType: 'ticket',
        aggregateId: current.id,
        guildId: current.guildId,
        channelId: current.channelId,
        actorId: actor.id,
        actorAttribution: actor.attribution ?? 'actorUnknown',
        actorConfidence: actor.confidence ?? 'none',
        payload: {
          changedFields: Object.keys(updates),
        },
        occurredAt: updatedAt,
      });

      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve original persistence error.
      }
      throw error;
    }
  }

  public markDeleted(
    channelId: string,
    deletedAt: string,
    reason: string,
    actor: EventActor = {
      id: 'supportforge-system',
      attribution: 'actorKnown',
      confidence: 'high',
    },
  ): void {
    const current = this.getByChannelId(channelId);
    if (!current) return;

    this.database.exec('BEGIN IMMEDIATE');

    try {
      const result = this.database
        .prepare(
          'UPDATE tickets SET deleted_at = ?, deletion_reason = ?, updated_at = ? WHERE channel_id = ? AND deleted_at IS NULL',
        )
        .run(deletedAt, reason, deletedAt, channelId);

      if (Number(result.changes) === 1) {
        this.events.append({
          id: randomUUID(),
          type: 'ticket.deleted',
          aggregateType: 'ticket',
          aggregateId: current.id,
          guildId: current.guildId,
          channelId: current.channelId,
          actorId: actor.id,
          actorAttribution: actor.attribution ?? 'actorUnknown',
          actorConfidence: actor.confidence ?? 'none',
          payload: { reason },
          occurredAt: deletedAt,
        });
      }

      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve original persistence error.
      }
      throw error;
    }
  }

  public remove(channelId: string): void {
    const current = this.getByChannelId(channelId);
    if (!current) return;

    this.database.exec('BEGIN IMMEDIATE');

    try {
      this.database
        .prepare(
          "DELETE FROM outbox_events WHERE aggregate_type = 'ticket' AND aggregate_id = ?",
        )
        .run(current.id);

      this.database
        .prepare('DELETE FROM ticket_events WHERE ticket_id = ?')
        .run(current.id);

      this.database
        .prepare('DELETE FROM tickets WHERE channel_id = ?')
        .run(channelId);

      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original deletion error.
      }
      throw error;
    }
  }

  public clearAll(): void {
    this.database.prepare('DELETE FROM tickets').run();
  }
}
