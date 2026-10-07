import type { EventActor } from '../events/domainEvents';
import {
  getSupportForgeDatabase,
  type SqliteDatabase,
} from './sqliteDatabase';
import { migratePostgres } from './migrationRunner';
import { PostgresTicketRepository, type AsyncTicketRepository } from '../../repositories/postgresTicketRepository';
import { SqliteTicketRepository } from '../../repositories/ticketRepository';

export type PersistenceProvider = 'sqlite' | 'postgres';

export function getPersistenceProvider(): PersistenceProvider {
  const value = process.env.SUPPORTFORGE_DATABASE_PROVIDER?.trim().toLowerCase();

  if (!value || value === 'sqlite') {
    return 'sqlite';
  }

  if (value === 'postgres' || value === 'postgresql' || value === 'neon') {
    return 'postgres';
  }

  throw new Error(
    `Unsupported SUPPORTFORGE_DATABASE_PROVIDER "${value}". Expected "sqlite" or "postgres".`,
  );
}

class SqliteTicketRepositoryAdapter implements AsyncTicketRepository {
  private readonly repository: SqliteTicketRepository;

  public constructor(database: SqliteDatabase = getSupportForgeDatabase()) {
    this.repository = new SqliteTicketRepository(database);
  }

  async getByChannelId(channelId: string) {
    return this.repository.getByChannelId(channelId);
  }

  async listByGuildId(guildId: string) {
    return this.repository.listByGuildId(guildId);
  }

  async findActiveByOwnerAndDepartment(
    guildId: string,
    ownerId: string,
    departmentId: string,
  ) {
    return this.repository.findActiveByOwnerAndDepartment(
      guildId,
      ownerId,
      departmentId,
    );
  }

  async listAll() {
    return this.repository.listAll();
  }

  async upsert(record: Parameters<SqliteTicketRepository['upsert']>[0]) {
    this.repository.upsert(record);
  }

  async create(
    record: Parameters<SqliteTicketRepository['create']>[0],
    actor?: EventActor,
  ) {
    this.repository.create(record, actor);
  }

  async listEvents(channelId: string, limit?: number) {
    return this.repository.listEvents(channelId, limit);
  }

  async setStatus(channelId: string, status: Parameters<SqliteTicketRepository['setStatus']>[1], updatedAt: string) {
    this.repository.setStatus(channelId, status, updatedAt);
  }

  async transitionStatus(
    channelId: string,
    status: Parameters<SqliteTicketRepository['transitionStatus']>[1],
    updatedAt: string,
    actor?: EventActor,
  ) {
    this.repository.transitionStatus(channelId, status, updatedAt, actor);
  }

  async updateMetadata(
    channelId: string,
    updates: Parameters<SqliteTicketRepository['updateMetadata']>[1],
    updatedAt: string,
    _actor?: EventActor,
  ) {
    this.repository.updateMetadata(channelId, updates, updatedAt);
  }

  async markDeleted(
    channelId: string,
    deletedAt: string,
    reason: string,
    _actor?: EventActor,
  ) {
    this.repository.markDeleted(channelId, deletedAt, reason);
  }

  async remove(channelId: string) {
    this.repository.remove(channelId);
  }

  async clearAll() {
    this.repository.clearAll();
  }
}

let repository: AsyncTicketRepository | null = null;
let initialized = false;
let initializationPromise: Promise<void> | null = null;

export async function initializePersistence(): Promise<void> {
  if (initialized) return;

  if (!initializationPromise) {
    initializationPromise = (async () => {
      const provider = getPersistenceProvider();

      if (provider === 'postgres') {
        await migratePostgres();
      } else {
        getSupportForgeDatabase();
      }

      initialized = true;
    })().finally(() => {
      initializationPromise = null;
    });
  }

  await initializationPromise;
}

export function getTicketPersistenceRepository(): AsyncTicketRepository {
  if (!initialized) {
    throw new Error(
      'SupportForge persistence has not been initialized. Call initializePersistence() before accessing repositories.',
    );
  }

  if (!repository) {
    repository =
      getPersistenceProvider() === 'postgres'
        ? new PostgresTicketRepository()
        : new SqliteTicketRepositoryAdapter();
  }

  return repository;
}

export function resetPersistenceRepositoryForTests(): void {
  repository = null;
  initialized = false;
}
