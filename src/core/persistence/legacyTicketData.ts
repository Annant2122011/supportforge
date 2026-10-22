import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';

import type { TicketStatus } from '../domain/ticketLifecycle';
import type { TicketRepositoryRecord } from '../../repositories/ticketRepository';

export type LegacyTicketImportRecord = TicketRepositoryRecord;

interface LegacyTicketShape {
  guildId?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  ticketNumber?: unknown;
  departmentId?: unknown;
  tagId?: unknown;
  ownerId?: unknown;
  priority?: unknown;
  claimedByIds?: unknown;
  participantIds?: unknown;
  metadata?: unknown;
  deletedAt?: unknown;
  deletionReason?: unknown;
}

function optionalString(value: unknown, field: string, channelId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error(
      'Legacy ticket ' + channelId + ' has a non-string ' + field + '. No data was imported.',
    );
  }
  return value;
}

function requiredTimestamp(value: unknown, field: string, channelId: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Number.isNaN(new Date(value).getTime())
  ) {
    throw new Error(
      'Legacy ticket ' + channelId + ' has a missing or invalid ' + field + '. No data was imported.',
    );
  }
  return value;
}

function stringArray(value: unknown, field: string, channelId: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(
      'Legacy ticket ' + channelId + ' has a malformed ' + field + '. No data was imported.',
    );
  }
  return value as string[];
}

function metadataObject(value: unknown, channelId: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'Legacy ticket ' + channelId + ' has malformed metadata. No data was imported.',
    );
  }
  return value as Record<string, unknown>;
}

/**
 * Read and fully validate the legacy ticket snapshot before any destination
 * records are written. A uniquely named backup is created before parsing, so
 * invalid JSON and invalid individual records remain recoverable.
 */
export function readLegacyTicketJson(
  path: string,
): LegacyTicketImportRecord[] | undefined {
  if (!existsSync(path)) return undefined;

  const backupPath = path + '.pre-database-' + Date.now() + '-' + randomUUID() + '.backup';
  copyFileSync(path, backupPath);

  let source: unknown;
  try {
    source = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      'QueryFixr could not import data/tickets.json because the file is invalid JSON. The original file and its backup were preserved.',
      { cause: error },
    );
  }

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(
      'QueryFixr could not import data/tickets.json because the root must be a JSON object.',
    );
  }

  const root = source as { version?: unknown; tickets?: unknown };
  if (root.version !== undefined && root.version !== 1) {
    throw new Error(
      'QueryFixr cannot import data/tickets.json version ' +
        String(root.version) +
        '. Only legacy version 1 is supported.',
    );
  }
  if (
    !root.tickets ||
    typeof root.tickets !== 'object' ||
    Array.isArray(root.tickets)
  ) {
    throw new Error(
      'QueryFixr could not import data/tickets.json because its tickets collection is malformed.',
    );
  }

  const supportedStatuses = new Set<TicketStatus>([
    'open',
    'claimed',
    'pending',
    'reopened',
    'closed',
    'archived',
  ]);

  const records: LegacyTicketImportRecord[] = [];
  for (const [channelId, rawTicket] of Object.entries(root.tickets)) {
    if (!channelId.trim()) {
      throw new Error('Legacy ticket collection contains an empty channel ID.');
    }
    if (!rawTicket || typeof rawTicket !== 'object' || Array.isArray(rawTicket)) {
      throw new Error(
        'Legacy ticket ' + channelId + ' is not a JSON object. No data was imported.',
      );
    }

    const ticket = rawTicket as LegacyTicketShape;
    const guildId = optionalString(ticket.guildId, 'guildId', channelId);
    if (!guildId) {
      throw new Error(
        'Legacy ticket ' + channelId + ' is missing guildId. No data was imported.',
      );
    }
    if (typeof ticket.status !== 'string' || !supportedStatuses.has(ticket.status as TicketStatus)) {
      throw new Error(
        'Legacy ticket ' + channelId + ' has unsupported or missing status: ' +
          String(ticket.status) + '. No data was imported.',
      );
    }

    const deletedAt = optionalString(ticket.deletedAt, 'deletedAt', channelId);
    if (deletedAt !== null && Number.isNaN(new Date(deletedAt).getTime())) {
      throw new Error(
        'Legacy ticket ' + channelId + ' has an invalid deletedAt. No data was imported.',
      );
    }

    records.push({
      id: 'legacy:' + channelId,
      guildId,
      channelId,
      ticketNumber: optionalString(ticket.ticketNumber, 'ticketNumber', channelId),
      status: ticket.status as TicketStatus,
      departmentId: optionalString(ticket.departmentId, 'departmentId', channelId),
      tagId: optionalString(ticket.tagId, 'tagId', channelId),
      ownerId: optionalString(ticket.ownerId, 'ownerId', channelId),
      priority: optionalString(ticket.priority, 'priority', channelId),
      claimedByIds: stringArray(ticket.claimedByIds, 'claimedByIds', channelId),
      participantIds: stringArray(ticket.participantIds, 'participantIds', channelId),
      metadata: metadataObject(ticket.metadata, channelId),
      createdAt: requiredTimestamp(ticket.createdAt, 'createdAt', channelId),
      updatedAt: requiredTimestamp(ticket.updatedAt, 'updatedAt', channelId),
      deletedAt,
      deletionReason: optionalString(ticket.deletionReason, 'deletionReason', channelId),
    });
  }

  return records;
}
