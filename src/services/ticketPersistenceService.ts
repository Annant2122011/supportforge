import { randomUUID } from 'node:crypto';

import type { TicketPriority } from './advancedSettingsService';
import type { TicketStatus } from './ticketStateService';
import {
  SqliteTicketRepository,
  type TicketRepositoryRecord,
} from '../repositories/ticketRepository';

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
}

let repository: SqliteTicketRepository | null = null;

function getRepository(): SqliteTicketRepository {
  return (repository ??= new SqliteTicketRepository());
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
  return getRepository().getByChannelId(channelId)?.status;
}

export async function getPersistedTicketPriority(
  channelId: string,
): Promise<TicketPriority | undefined> {
  return getRepository().getByChannelId(channelId)?.priority as
    | TicketPriority
    | undefined;
}

export async function registerTicket(
  channelId: string,
  registration: TicketRegistration,
): Promise<void> {
  const current = getRepository().getByChannelId(channelId);
  const createdAt = current?.createdAt ?? registration.createdAt;

  getRepository().upsert({
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
    claimedByIds: current?.claimedByIds ?? [],
    participantIds: current?.participantIds ?? [],
    metadata: current?.metadata ?? {},
    deletedAt: current?.deletedAt ?? null,
    deletionReason: current?.deletionReason ?? null,
  });
}

export async function setPersistedTicketStatus(
  channelId: string,
  status: TicketStatus,
): Promise<void> {
  const current = getRepository().getByChannelId(channelId);
  const now = new Date().toISOString();

  if (!current) {
    getRepository().upsert({
      id: randomUUID(),
      guildId: 'unknown',
      channelId,
      ticketNumber: null,
      status,
      departmentId: null,
      tagId: null,
      ownerId: null,
      priority: null,
      claimedByIds: [],
      participantIds: [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletionReason: null,
    });
    return;
  }

  getRepository().setStatus(channelId, status, now);
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
): Promise<void> {
  const current = getRepository().getByChannelId(channelId);
  const now = new Date().toISOString();

  if (!current) {
    getRepository().upsert({
      id: randomUUID(),
      guildId: 'unknown',
      channelId,
      ticketNumber: null,
      status: 'open',
      departmentId: updates.departmentId ?? null,
      tagId: updates.tagId ?? null,
      ownerId: updates.ownerId ?? null,
      priority:
        updates.priority === undefined
          ? null
          : String(updates.priority),
      claimedByIds: updates.claimedByIds ?? [],
      participantIds: updates.participantIds ?? [],
      metadata: updates.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletionReason: null,
    });
    return;
  }

  getRepository().updateMetadata(channelId, updates, now);
}

export async function getPersistedTicketRecords(
  guildId?: string,
): Promise<PersistedTicket[]> {
  if (!guildId) {
    return [];
  }

  return getRepository()
    .listByGuildId(guildId)
    .map(toPersistedTicket);
}

export async function markPersistedTicketDeleted(
  channelId: string,
  reason: string,
): Promise<void> {
  const current = getRepository().getByChannelId(channelId);
  if (!current) return;

  const now = new Date().toISOString();
  getRepository().markDeleted(channelId, now, reason);
}

export async function removePersistedTicket(
  channelId: string,
): Promise<void> {
  getRepository().remove(channelId);
}

export async function resetTicketPersistenceState(): Promise<void> {
  getRepository().clearAll();
}
