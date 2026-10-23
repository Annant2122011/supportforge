import { randomUUID } from 'node:crypto';

import { getJsonDocument, setJsonDocument } from './jsonDocumentPersistenceService';
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
}

interface ConfigurationSnapshot extends ConfigurationSnapshotMetadata {
  payload: {
    guildConfig: GuildConfig;
    advancedSettings: AdvancedGuildSettings;
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

async function readDocument(): Promise<ConfigurationHistoryDocument> {
  const stored = await getJsonDocument<Partial<ConfigurationHistoryDocument>>(DOCUMENT_KEY);
  if (stored === undefined) return { version: HISTORY_VERSION, guilds: {} };
  if (!stored || typeof stored !== 'object' || !stored.guilds ||
      typeof stored.guilds !== 'object' || Array.isArray(stored.guilds)) {
    throw new Error('Configuration history document is malformed. Existing history was not overwritten.');
  }
  const guilds: Record<string, ConfigurationSnapshot[]> = {};
  for (const [guildId, snapshots] of Object.entries(stored.guilds)) {
    if (Array.isArray(snapshots)) {
      guilds[guildId] = snapshots.filter((item): item is ConfigurationSnapshot =>
        Boolean(item && typeof item === 'object' &&
          typeof item.id === 'string' &&
          item.guildId === guildId &&
          item.payload && typeof item.payload === 'object' &&
          item.payload.guildConfig && item.payload.advancedSettings),
      ).slice(0, MAX_SNAPSHOTS_PER_GUILD);
    }
  }
  return { version: HISTORY_VERSION, guilds };
}

async function mutateDocument<T>(
  mutate: (document: ConfigurationHistoryDocument) => T | Promise<T>,
): Promise<T> {
  let result!: T;
  const operation = writeQueue.catch(() => undefined).then(async () => {
    const document = await readDocument();
    result = await mutate(document);
    await setJsonDocument(DOCUMENT_KEY, document);
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
  const [guildConfig, advancedSettings] = await Promise.all([
    getGuildConfig(guildId),
    getAdvancedSettings(guildId),
  ]);
  return cloneJson({ guildConfig, advancedSettings });
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
    payload: cloneJson(payload),
  };

  return mutateDocument((document) => {
    const snapshots = document.guilds[guildId] ?? [];
    snapshots.unshift(entry);
    document.guilds[guildId] = snapshots.slice(0, MAX_SNAPSHOTS_PER_GUILD);
    return metadata(entry);
  });
}

/** Save a bounded, per-server checkpoint of the two existing configuration documents. */
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

/**
 * Restore only the requesting guild's two configuration records. Tickets,
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
      Object.assign(current, cloneJson(payload.guildConfig));
    });
    await updateAdvancedSettings(guildId, (current) => {
      Object.assign(current, cloneJson(payload.advancedSettings));
    });
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
