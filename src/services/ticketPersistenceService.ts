import { randomUUID } from 'node:crypto';
import type { EventActor } from '../core/events/domainEvents';

import type { TicketPriority } from './advancedSettingsService';
import type { TicketStatus } from './ticketStateService';
import {
  getTicketPersistenceRepository,
  initializePersistence,
} from '../core/persistence/provider';
import type { TicketRepositoryRecord } from '../repositories/ticketRepository';

export interface PersistedTicket {
  id: string;
  channelId: string;
  guildId: string | null;
  status: TicketStatus;
  updatedAt: string;
  createdAt: string;
  ticketNumber: string | null;
  departmentId: string | null;
  tagId: string | null;
  ownerId: string | null;
  priority: TicketPriority | null;
  claimedByIds: string[];
  participantIds: string[];
  metadata: Record<string, unknown>;
  deletedAt: string | null;
  deletionReason: string | null;
}

export interface TicketRegistration {
  guildId: string;
  ticketNumber: string;
  departmentId: string;
  tagId: string;
  ownerId: string;
  priority: TicketPriority;
  createdAt: string;
  claimedByIds?: string[];
  participantIds?: string[];
}

async function getRepository() {
  await initializePersistence();
  return getTicketPersistenceRepository();
}

function toPersistedTicket(record: TicketRepositoryRecord): PersistedTicket {
  return {
    id: record.id,
    channelId: record.channelId,
    guildId: record.guildId,
    status: record.status,
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
    ticketNumber: record.ticketNumber,
    departmentId: record.departmentId,
    tagId: record.tagId,
    ownerId: record.ownerId,
    priority: record.priority as TicketPriority | null,
    claimedByIds: [...record.claimedByIds],
    participantIds: [...record.participantIds],
    metadata: { ...record.metadata },
    deletedAt: record.deletedAt,
    deletionReason: record.deletionReason,
  };
}

export async function getPersistedTicketStatus(
  channelId: string,
): Promise<TicketStatus | undefined> {
  const repository = await getRepository();
  return (await repository.getByChannelId(channelId))?.status;
}

export async function getPersistedTicketPriority(
  channelId: string,
): Promise<TicketPriority | undefined> {
  const repository = await getRepository();
  return (await repository.getByChannelId(channelId))?.priority as
    | TicketPriority
    | undefined;
}

export async function findActivePersistedTickets(
  guildId: string,
  ownerId: string,
  departmentId: string,
): Promise<PersistedTicket[]> {
  const repository = await getRepository();
  return (await repository.findActiveByOwnerAndDepartment(
    guildId,
    ownerId,
    departmentId,
  )).map(toPersistedTicket);
}

export async function registerTicket(
  channelId: string,
  registration: TicketRegistration,
  actor?: EventActor,
): Promise<void> {
  const repository = await getRepository();
  const current = await repository.getByChannelId(channelId);
  const createdAt = current?.createdAt ?? registration.createdAt;

  const record: TicketRepositoryRecord = {
    id: current?.id ?? randomUUID(),
    guildId: current?.guildId ?? registration.guildId,
    channelId,
    status: current?.status ?? 'open',
    updatedAt: registration.createdAt,
    createdAt,
    ticketNumber: current?.ticketNumber ?? registration.ticketNumber,
    departmentId: current?.departmentId ?? registration.departmentId,
    tagId: current?.tagId ?? registration.tagId,
    ownerId: current?.ownerId ?? registration.ownerId,
    priority: current?.priority ?? registration.priority,
    claimedByIds: current?.claimedByIds ?? registration.claimedByIds ?? [],
    participantIds: current?.participantIds ?? registration.participantIds ?? [],
    metadata: current?.metadata ?? {},
    deletedAt: current?.deletedAt ?? null,
    deletionReason: current?.deletionReason ?? null,
  };

  if (current) {
    await repository.upsert(record);
  } else {
    await repository.create(record, actor);
  }
}

export async function setPersistedTicketStatus(
  channelId: string,
  status: TicketStatus,
  actor?: EventActor,
): Promise<void> {
  const repository = await getRepository();
  const current = await repository.getByChannelId(channelId);
  const now = new Date().toISOString();

  if (!current) {
    throw new Error(
      `Cannot transition SupportForge ticket ${channelId}: durable ticket record does not exist.`,
    );
  }

  await repository.transitionStatus(channelId, status, now, actor);
}

export async function updatePersistedTicketMetadata(
  channelId: string,
  updates: Partial<
    Pick<
      PersistedTicket,
      | 'departmentId'
      | 'tagId'
      | 'ownerId'
      | 'priority'
      | 'claimedByIds'
      | 'participantIds'
      | 'metadata'
    >
  >,
  actor?: EventActor,
): Promise<void> {
  const repository = await getRepository();
  const current = await repository.getByChannelId(channelId);
  const now = new Date().toISOString();

  if (!current) {
    throw new Error(
      `Cannot update SupportForge ticket ${channelId}: durable ticket record does not exist.`,
    );
  }

  await repository.updateMetadata(channelId, updates, now, actor);
}

export async function getPersistedTicketRecords(
  guildId?: string,
): Promise<PersistedTicket[]> {
  const repository = await getRepository();
  return (guildId
    ? await repository.listByGuildId(guildId)
    : await repository.listAll()
  ).map(toPersistedTicket);
}

export async function markPersistedTicketDeleted(
  channelId: string,
  reason: string,
  actor?: EventActor,
): Promise<void> {
  const repository = await getRepository();
  await repository.markDeleted(
    channelId,
    new Date().toISOString(),
    reason,
    actor,
  );
}

export async function removePersistedTicket(
  channelId: string,
): Promise<void> {
  const repository = await getRepository();
  await repository.remove(channelId);
}

export async function resetTicketPersistenceState(): Promise<void> {
  const repository = await getRepository();
  await repository.clearAll();
}

export async function getPersistedTicketEventHistory(
  channelId: string,
  limit = 500,
): Promise<import('../core/events/domainEvents').DomainEvent[]> {
  const repository = await getRepository();
  return repository.listEvents(channelId, limit);
}
