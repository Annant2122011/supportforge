export const RESTORE_TARGET_CONFIRMATION = 'RESTORE_TO_EMPTY_NON_PRODUCTION_DATABASE';

export interface PostgresBackupManifest {
  format: 'postgres-custom';
  filename: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  databaseHost: string;
  databaseName: string;
}

const LABEL_ALLOW = /(test|testing|staging|sandbox|restore|nonprod)/i;
const LABEL_DENY = /(^|[^a-z])(prod|production|main|live)([^a-z]|$)/i;

interface PostgresDatabaseIdentity {
  host: string;
  port: string;
  database: string;
}

function parsePostgresDatabaseIdentity(value: string): PostgresDatabaseIdentity {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('A configured PostgreSQL URL could not be validated. Restore was not started.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('A configured database URL is not PostgreSQL. Restore was not started.');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).trim();
  if (!parsed.hostname || !database) {
    throw new Error('A configured PostgreSQL URL is missing its host or database name. Restore was not started.');
  }
  return {
    host: parsed.hostname.toLocaleLowerCase('en-US'),
    port: parsed.port || '5432',
    database: database.toLocaleLowerCase('en-US'),
  };
}

/**
 * Fail closed if a restore target is also configured as the bot's active DB.
 * The caller must pass the existing DATABASE_URL values before switching them
 * to the restore target. Credentials are never included in thrown errors.
 */
export function assertRestoreTargetDistinctFromConfiguredDatabase(
  targetUrl: string,
  configuredDatabaseUrls: readonly (string | undefined)[],
): void {
  const target = parsePostgresDatabaseIdentity(targetUrl);
  for (const configuredUrl of configuredDatabaseUrls) {
    if (configuredUrl === undefined || !configuredUrl.trim()) continue;
    const configured = parsePostgresDatabaseIdentity(configuredUrl);
    if (
      target.host === configured.host &&
      target.port === configured.port &&
      target.database === configured.database
    ) {
      throw new Error('Restore target matches a database configured for the running bot. Restore was not started.');
    }
  }
}

export function isAllowedRestoreTargetLabel(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const label = value.trim();
  return label.length >= 3 && label.length <= 80 &&
    /^[a-z0-9](?:[a-z0-9 _.-]*[a-z0-9])$/i.test(label) &&
    !label.includes('..') &&
    LABEL_ALLOW.test(label) && !LABEL_DENY.test(label);
}

export function isSafeBackupFilename(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 180 &&
    value === value.trim() &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..') &&
    value.endsWith('.dump');
}

export function validateBackupManifest(
  manifest: unknown,
  expectedFilename: string,
  actualSha256: string,
  actualSizeBytes: number,
): asserts manifest is PostgresBackupManifest {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Backup manifest is missing or malformed.');
  }
  const value = manifest as Partial<PostgresBackupManifest>;
  if (value.format !== 'postgres-custom') throw new Error('Unsupported backup format.');
  if (!isSafeBackupFilename(value.filename) || value.filename !== expectedFilename) {
    throw new Error('Backup filename does not match the validated manifest.');
  }
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('Backup manifest checksum is invalid.');
  }
  if (value.sha256 !== actualSha256) throw new Error('Backup checksum mismatch. Restore was not started.');
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes !== actualSizeBytes || actualSizeBytes <= 0) {
    throw new Error('Backup size does not match its manifest. Restore was not started.');
  }
  const createdAt = typeof value.createdAt === 'string' ? Date.parse(value.createdAt) : Number.NaN;
  if (!Number.isFinite(createdAt)) throw new Error('Backup timestamp is invalid.');
  if (typeof value.databaseHost !== 'string' || value.databaseHost.length > 255 || !value.databaseHost.trim()) {
    throw new Error('Backup source host metadata is invalid.');
  }
  if (typeof value.databaseName !== 'string' || value.databaseName.length > 128 || !value.databaseName.trim()) {
    throw new Error('Backup source database metadata is invalid.');
  }
}
