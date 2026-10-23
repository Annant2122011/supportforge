import { randomUUID } from 'node:crypto';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { initializePersistence } from '../core/persistence/provider';
import {
  getGuildConfig,
  updateGuildConfig,
  type GuildConfig,
} from './configService';
import {
  getAdvancedSettings,
  updateAdvancedSettings,
  type AdvancedGuildSettings,
} from './advancedSettingsService';
import { getSupportHoursPolicies, replaceSupportHoursPolicies, type SupportHoursPolicy } from './supportHoursService';
import { listTicketForms, restoreTicketFormCatalogSnapshot, type TicketFormVersion } from './ticketFormService';

const DOCUMENT_KEY = 'configuration-history';
const HISTORY_VERSION = 1;
const MAX_SNAPSHOTS_PER_GUILD = 10;

export interface ConfigurationSnapshotMetadata {
  id: string;
  guildId: string;
  createdAt: string;
  createdById: string;
  createdByName: string;
  reason: string;
  departmentCount: number;
  panelCount: number;
  tagCount: number;
  formCount: number;
  supportHoursPolicyCount: number;
}

interface ConfigurationSnapshot extends ConfigurationSnapshotMetadata {
  payload: {
    guildConfig: GuildConfig;
    advancedSettings: AdvancedGuildSettings;
    supportHours?: SupportHoursPolicy[];
    ticketForms?: TicketFormVersion[];
  };
}

interface ConfigurationHistoryDocument {
  version: 1;
  guilds: Record<string, ConfigurationSnapshot[]>;
}

let writeQueue: Promise<void> = Promise.resolve();

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeReason(reason: string): string {
  return reason.trim().replace(/\s+/g, ' ').slice(0, 180) || 'Manual configuration checkpoint';
}

export function normalizeConfigurationHistoryDocument(stored: unknown): ConfigurationHistoryDocument {
  if (stored === undefined) return { version: HISTORY_VERSION, guilds: {} };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !('guilds' in stored)) {
    throw new Error('Configuration history document is malformed. Existing history was not overwritten.');
  }
  const raw = stored as Partial<ConfigurationHistoryDocument>;
  if (raw.version !== HISTORY_VERSION) {
    throw new Error('Configuration history version is unsupported. Existing history was not overwritten.');
  }
  if (!raw.guilds || typeof raw.guilds !== 'object' || Array.isArray(raw.guilds)) {
    throw new Error('Configuration history guild index is malformed. Existing history was not overwritten.');
  }
  const guilds: Record<string, ConfigurationSnapshot[]> = {};
  for (const [guildId, snapshots] of Object.entries(raw.guilds)) {
    if (!guildId.trim() || !Array.isArray(snapshots)) {
      throw new Error('Configuration history contains a malformed guild entry. Existing history was not overwritten.');
    }
    for (const item of snapshots) {
      const validSnapshot = Boolean(
        item && typeof item === 'object' &&
        typeof item.id === 'string' && item.id.startsWith('cfg_') &&
        item.guildId === guildId &&
        typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) &&
        typeof item.createdById === 'string' &&
        typeof item.createdByName === 'string' &&
        typeof item.reason === 'string' &&
        Number.isInteger(item.departmentCount) && item.departmentCount >= 0 &&
        Number.isInteger(item.panelCount) && item.panelCount >= 0 &&
        Number.isInteger(item.tagCount) && item.tagCount >= 0 &&
        item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload) &&
        item.payload.guildConfig && typeof item.payload.guildConfig === 'object' && !Array.isArray(item.payload.guildConfig) &&
        item.payload.advancedSettings && typeof item.payload.advancedSettings === 'object' && !Array.isArray(item.payload.advancedSettings) &&
        (item.payload.supportHours === undefined || Array.isArray(item.payload.supportHours)) &&
        (item.payload.ticketForms === undefined || Array.isArray(item.payload.ticketForms))
      );
      if (!validSnapshot) {
        throw new Error('Configuration history contains a malformed snapshot for guild ' + guildId + '. Existing history was not overwritten.');
      }
    }
    guilds[guildId] = snapshots.slice(0, MAX_SNAPSHOTS_PER_GUILD) as ConfigurationSnapshot[];
  }
  return { version: HISTORY_VERSION, guilds };
}

async function readDocument(): Promise<ConfigurationHistoryDocument> {
  await initializePersistence();
  const result = await getPostgresPool().query<{ payload: unknown }>(
    'SELECT payload FROM app_documents WHERE document_key = $1',
    [DOCUMENT_KEY],
  );
  return normalizeConfigurationHistoryDocument(result.rows[0]?.payload);
}

/**
 * PostgreSQL advisory transaction locking makes history updates safe across
 * multiple bot processes. The document is read, modified and upserted in one
 * transaction, so simultaneous snapshots for different guilds cannot clobber
 * each other inside the shared JSON document.
 */
async function mutateDocument<T>(
  mutate: (document: ConfigurationHistoryDocument) => T | Promise<T>,
): Promise<T> {
  let result!: T;
  const operation = writeQueue.catch(() => undefined).then(async () => {
    await initializePersistence();
    const client = await getPostgresPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [1836027238, 1]);
      const stored = await client.query<{ payload: unknown }>(
        'SELECT payload FROM app_documents WHERE document_key = $1 FOR UPDATE',
        [DOCUMENT_KEY],
      );
      const document = normalizeConfigurationHistoryDocument(stored.rows[0]?.payload);
      result = await mutate(document);
      await client.query(
        'INSERT INTO app_documents (document_key, payload, updated_at) VALUES ($1, $2::jsonb, NOW()) ' +
        'ON CONFLICT(document_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()',
        [DOCUMENT_KEY, JSON.stringify(document)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
  writeQueue = operation;
  await operation;
  return result;
}

function metadata(snapshot: ConfigurationSnapshot): ConfigurationSnapshotMetadata {
  const { payload: _payload, ...meta } = snapshot;
  return meta;
}

function countTags(config: GuildConfig): number {
  return Object.values(config.departments ?? {}).reduce(
    (total, department) => total + Object.keys(department.tags ?? {}).length,
    0,
  );
}

async function capturePayload(guildId: string): Promise<ConfigurationSnapshot['payload']> {
  const [guildConfig, advancedSettings, supportHours, ticketForms] = await Promise.all([
    getGuildConfig(guildId),
    getAdvancedSettings(guildId),
    getSupportHoursPolicies(guildId),
    listTicketForms(guildId),
  ]);
  return cloneJson({ guildConfig, advancedSettings, supportHours, ticketForms });
}

async function savePayloadSnapshot(
  guildId: string,
  actor: { id: string; name: string },
  reason: string,
  payload: ConfigurationSnapshot['payload'],
): Promise<ConfigurationSnapshotMetadata> {
  const entry: ConfigurationSnapshot = {
    id: 'cfg_' + randomUUID().replace(/-/g, '').slice(0, 16),
    guildId,
    createdAt: new Date().toISOString(),
    createdById: actor.id,
    createdByName: actor.name.slice(0, 100),
    reason: normalizeReason(reason),
    departmentCount: Object.keys(payload.guildConfig.departments ?? {}).length,
    panelCount: Object.keys(payload.guildConfig.customPanels ?? {}).length,
    tagCount: countTags(payload.guildConfig),
    formCount: payload.ticketForms?.length ?? 0,
    supportHoursPolicyCount: payload.supportHours?.length ?? 0,
    payload: cloneJson(payload),
  };

  return mutateDocument((document) => {
    const snapshots = document.guilds[guildId] ?? [];
    snapshots.unshift(entry);
    document.guilds[guildId] = snapshots.slice(0, MAX_SNAPSHOTS_PER_GUILD);
    return metadata(entry);
  });
}

/** Save a bounded, per-server checkpoint of guild, advanced, support-hours and form configuration. */
export async function createConfigurationSnapshot(
  guildId: string,
  actor: { id: string; name: string },
  reason = 'Manual configuration checkpoint',
): Promise<ConfigurationSnapshotMetadata> {
  const payload = await capturePayload(guildId);
  return savePayloadSnapshot(guildId, actor, reason, payload);
}

/** List metadata only; callers must explicitly select a snapshot to restore it. */
export async function listConfigurationSnapshots(
  guildId: string,
): Promise<ConfigurationSnapshotMetadata[]> {
  await writeQueue.catch(() => undefined);
  const document = await readDocument();
  return (document.guilds[guildId] ?? []).map(metadata);
}

export async function getConfigurationSnapshot(
  guildId: string,
  snapshotId: string,
): Promise<ConfigurationSnapshotMetadata | null> {
  await writeQueue.catch(() => undefined);
  const document = await readDocument();
  const snapshot = (document.guilds[guildId] ?? []).find((item) => item.id === snapshotId);
  return snapshot ? metadata(snapshot) : null;
}
export interface ConfigurationSnapshotReview {
  snapshot: ConfigurationSnapshotMetadata;
  currentCounts: {
    departmentCount: number;
    panelCount: number;
    tagCount: number;
    formCount: number;
    supportHoursPolicyCount: number;
  };
  /** Names of configuration areas whose current values differ from the saved checkpoint. */
  changedSections: string[];
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ':' + stableSerialize(record[key]),
  ).join(',') + '}';
}

function withoutKeys(value: Record<string, unknown>, excluded: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.includes(key)));
}

/**
 * Read-only preview for rollback. It reports changed areas and counts without
 * exposing message content or mutating settings. Call again immediately before
 * restore because another administrator may have changed configuration since
 * the preview was generated.
 */
export async function reviewConfigurationSnapshot(
  guildId: string,
  snapshotId: string,
): Promise<ConfigurationSnapshotReview | null> {
  await writeQueue.catch(() => undefined);
  const document = await readDocument();
  const target = (document.guilds[guildId] ?? []).find((item) => item.id === snapshotId);
  if (!target) return null;

  const current = await capturePayload(guildId);
  const savedConfig = target.payload.guildConfig as unknown as Record<string, unknown>;
  const currentConfig = current.guildConfig as unknown as Record<string, unknown>;
  const sections: Array<{ label: string; saved: unknown; current: unknown }> = [
    {
      label: 'Departments and tags',
      saved: target.payload.guildConfig.departments ?? {},
      current: current.guildConfig.departments ?? {},
    },
    {
      label: 'Custom panels and published panel pointers',
      saved: {
        panels: target.payload.guildConfig.customPanels ?? {},
        channelId: target.payload.guildConfig.panelChannelId ?? null,
        messageId: target.payload.guildConfig.panelMessageId ?? null,
      },
      current: {
        panels: current.guildConfig.customPanels ?? {},
        channelId: current.guildConfig.panelChannelId ?? null,
        messageId: current.guildConfig.panelMessageId ?? null,
      },
    },
    {
      label: 'General guild settings and managed destinations',
      saved: withoutKeys(savedConfig, ['departments', 'customPanels', 'panelChannelId', 'panelMessageId']),
      current: withoutKeys(currentConfig, ['departments', 'customPanels', 'panelChannelId', 'panelMessageId']),
    },
    {
      label: 'Advanced settings and dashboard layout',
      saved: target.payload.advancedSettings,
      current: current.advancedSettings,
    },
    {
      label: 'Support-hours policies',
      saved: target.payload.supportHours ?? [],
      current: current.supportHours ?? [],
    },
    {
      label: 'Form definitions and routing',
      saved: target.payload.ticketForms ?? [],
      current: current.ticketForms ?? [],
    },
  ];

  return {
    snapshot: metadata(target),
    currentCounts: {
      departmentCount: Object.keys(current.guildConfig.departments ?? {}).length,
      panelCount: Object.keys(current.guildConfig.customPanels ?? {}).length,
      tagCount: countTags(current.guildConfig),
      formCount: current.ticketForms?.length ?? 0,
      supportHoursPolicyCount: current.supportHours?.length ?? 0,
    },
    changedSections: sections
      .filter((section) => stableSerialize(section.saved) !== stableSerialize(section.current))
      .map((section) => section.label),
  };
}


/**
 * Restore only the requesting guild's configuration documents, support-hours policies and existing form schemas. Tickets,
 * transcripts, audit events, message archives and other guilds are not changed.
 * A pre-restore checkpoint is saved first; partial failures attempt compensation.
 */
export async function restoreConfigurationSnapshot(
  guildId: string,
  snapshotId: string,
  confirmation: string,
  actor: { id: string; name: string },
): Promise<{
  restored: ConfigurationSnapshotMetadata;
  checkpoint: ConfigurationSnapshotMetadata;
}> {
  if (confirmation !== 'RESTORE ' + snapshotId) {
    throw new Error('Restore confirmation did not match. Type RESTORE ' + snapshotId + ' exactly.');
  }

  await writeQueue.catch(() => undefined);
  const document = await readDocument();
  const target = (document.guilds[guildId] ?? []).find((item) => item.id === snapshotId);
  if (!target) throw new Error('That configuration snapshot does not exist for this server.');

  const before = await capturePayload(guildId);
  const checkpoint = await savePayloadSnapshot(
    guildId,
    actor,
    'Automatic checkpoint before restoring ' + snapshotId,
    before,
  );

  const apply = async (payload: ConfigurationSnapshot['payload']): Promise<void> => {
    await updateGuildConfig(guildId, (current) => {
      const target = current as unknown as Record<string, unknown>;
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, cloneJson(payload.guildConfig));
    });
    await updateAdvancedSettings(guildId, (current) => {
      const target = current as unknown as Record<string, unknown>;
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, cloneJson(payload.advancedSettings));
    });
    if (payload.supportHours !== undefined) {
      await replaceSupportHoursPolicies(guildId, cloneJson(payload.supportHours), actor.id);
    }
    if (payload.ticketForms !== undefined) {
      await restoreTicketFormCatalogSnapshot(guildId, cloneJson(payload.ticketForms), actor.id);
    }
  };

  try {
    await apply(target.payload);
  } catch (error) {
    try {
      await apply(before);
    } catch {
      throw new Error(
        'Configuration restore failed and automatic compensation also failed. Do not retry blindly; inspect the saved checkpoint ' +
        checkpoint.id + ' and database document health first.',
      );
    }
    throw new Error(
      'Configuration restore failed. The previous configuration was reapplied from the pre-restore checkpoint ' +
      checkpoint.id + '.',
    );
  }

  return { restored: metadata(target), checkpoint };
}
