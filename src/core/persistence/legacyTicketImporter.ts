import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { DomainEvent, EventActor } from '../events/domainEvents';
import type { PersistenceProvider } from './provider';
import { getSupportForgeDatabase } from './sqliteDatabase';
import { getPostgresPool } from './postgresDatabase';
import { SqliteTicketRepository } from '../../repositories/ticketRepository';
import { PostgresTicketRepository } from '../../repositories/postgresTicketRepository';
import { SqliteEventRepository } from '../../repositories/eventRepository';
import { PostgresEventRepository } from '../../repositories/postgresEventRepository';
import {
  PostgresJsonDocumentRepository,
  SqliteJsonDocumentRepository,
} from '../../repositories/jsonDocumentRepository';
import { readLegacyTicketJson } from './legacyTicketData';

const IMPORT_STATUS_KEY = 'legacy-tickets-import-status' as const;
const LEGACY_TICKETS_PATH = join(process.cwd(), 'data', 'tickets.json');

const MIGRATION_ACTOR: EventActor = {
  id: 'supportforge-legacy-migration',
  attribution: 'actorUnknown',
  confidence: 'none',
};

function isUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code ?? '');
  const message = error instanceof Error ? error.message : String(error);
  return code === '23505' || /UNIQUE constraint failed/i.test(message);
}

function creationEvent(
  ticket: {
    id: string;
    guildId: string;
    channelId: string;
    ticketNumber: string | null;
    status: string;
    departmentId: string | null;
    ownerId: string | null;
    createdAt: string;
  },
): DomainEvent {
  return {
    id: randomUUID(),
    type: 'ticket.created',
    aggregateType: 'ticket',
    aggregateId: ticket.id,
    guildId: ticket.guildId,
    channelId: ticket.channelId,
    actorId: MIGRATION_ACTOR.id,
    actorAttribution: 'actorUnknown',
    actorConfidence: 'none',
    payload: {
      status: ticket.status,
      ticketNumber: ticket.ticketNumber ?? '',
      departmentId: ticket.departmentId ?? '',
      ownerId: ticket.ownerId ?? '',
      migratedFromLegacyJson: true,
    },
    occurredAt: ticket.createdAt,
  };
}

/**
 * Imports data/tickets.json into the selected database. Each ticket creation
 * is transactional and keyed by the durable channel ID, so a crash halfway
 * through is safe to resume. The completion marker is written only after the
 * entire validated source has been processed.
 */
export async function importLegacyJsonTickets(
  provider: PersistenceProvider,
): Promise<void> {
  const documents = provider === 'postgres'
    ? new PostgresJsonDocumentRepository()
    : new SqliteJsonDocumentRepository();

  if (await documents.get(IMPORT_STATUS_KEY) !== undefined) return;

  const records = readLegacyTicketJson(LEGACY_TICKETS_PATH);
  if (!records) return;

  const sqlite = provider === 'sqlite' ? getSupportForgeDatabase() : undefined;
  const sqliteTickets = sqlite ? new SqliteTicketRepository(sqlite) : undefined;
  const sqliteEvents = sqlite ? new SqliteEventRepository(sqlite) : undefined;
  const postgresTickets = provider === 'postgres'
    ? new PostgresTicketRepository()
    : undefined;
  const postgresEvents = provider === 'postgres'
    ? new PostgresEventRepository()
    : undefined;

  let imported = 0;
  let recoveredCreationEvents = 0;
  let skippedCurrentRecords = 0;

  for (const record of records) {
    const repository = provider === 'postgres' ? postgresTickets! : sqliteTickets!;
    let current = await repository.getByChannelId(record.channelId);

    if (!current) {
      try {
        await repository.create(record, MIGRATION_ACTOR);
        imported += 1;
        continue;
      } catch (error) {
        // Another process may have imported the same channel between the
        // existence check and insert. Only a confirmed unique conflict is
        // recoverable; unrelated database errors must stop startup.
        if (!isUniqueConflict(error)) throw error;
        current = await repository.getByChannelId(record.channelId);
        if (!current) throw error;
      }
    }

    // The older SQLite migration inserted the ticket row before the event
    // store existed. Backfill only the missing creation event for records
    // bearing that migration's deterministic ID. Never rewrite newer DB state.
    if (current.id === 'legacy:' + record.channelId) {
      const existingEvents = await repository.listEvents(record.channelId, 1);
      if (existingEvents.length === 0) {
        const event = creationEvent(current);
        if (provider === 'sqlite') {
          sqlite!.exec('BEGIN IMMEDIATE');
          try {
            sqliteEvents!.append(event);
            sqlite!.exec('COMMIT');
          } catch (error) {
            try {
              sqlite!.exec('ROLLBACK');
            } catch {
              // Preserve the original persistence error.
            }
            throw error;
          }
        } else {
          const client = await getPostgresPool().connect();
          try {
            await client.query('BEGIN');
            await new PostgresEventRepository(client).append(event, event.payload, client);
            await client.query('COMMIT');
          } catch (error) {
            try {
              await client.query('ROLLBACK');
            } catch {
              // Preserve the original persistence error.
            }
            throw error;
          } finally {
            client.release();
          }
        }
        recoveredCreationEvents += 1;
      }
    }

    skippedCurrentRecords += 1;
  }

  await documents.putIfAbsent(IMPORT_STATUS_KEY, {
    version: 1,
    status: 'complete',
    source: 'data/tickets.json',
    completedAt: new Date().toISOString(),
    imported,
    recoveredCreationEvents,
    skippedCurrentRecords,
  });

  console.info(
    '✅ Legacy SupportForge tickets processed: imported=' + imported +
    ', restoredCreationEvents=' + recoveredCreationEvents +
    ', existingDatabaseRecordsPreserved=' + skippedCurrentRecords + '.',
  );
}
