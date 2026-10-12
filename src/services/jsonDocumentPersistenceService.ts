import {
  getPersistenceProvider,
  initializePersistence,
} from '../core/persistence/provider';
import {
  PostgresJsonDocumentRepository,
  SqliteJsonDocumentRepository,
  type JsonDocumentKey,
} from '../repositories/jsonDocumentRepository';

function repository() {
  return getPersistenceProvider() === 'postgres'
    ? new PostgresJsonDocumentRepository()
    : new SqliteJsonDocumentRepository();
}

/** Read a JSON-shaped application document from durable persistence. */
export async function getJsonDocument<T>(
  key: JsonDocumentKey,
): Promise<T | undefined> {
  await initializePersistence();
  return await repository().get(key) as T | undefined;
}

/** Persist the full normalized document as one atomic database upsert. */
export async function setJsonDocument(
  key: JsonDocumentKey,
  value: unknown,
): Promise<void> {
  await initializePersistence();
  await repository().put(key, value);
}
