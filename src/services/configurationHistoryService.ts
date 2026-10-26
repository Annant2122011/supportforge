import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import { initializePersistence } from '../core/persistence/provider';
import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { getJsonDocument, setJsonDocument } from './jsonDocumentPersistenceService';
import { getGuildConfig, resetConfigState, updateGuildConfig } from './configService';
import { getAdvancedSettings, resetAdvancedSettingsState, updateAdvancedSettings } from './advancedSettingsService';
import { getSupportHoursPolicies, resetSupportHoursStateForReload } from './supportHoursService';

export const CONFIGURATION_HISTORY_DOCUMENT_KEY = 'configuration-history' as const;
export const MAX_CONFIGURATION_SNAPSHOTS_PER_GUILD = 10;

export interface ConfigurationSnapshotPayload {
  guildConfig: Record<string, unknown>;
  advancedSettings: Record<string, unknown>;
  supportHours: unknown[];
  ticketForms: unknown[];
}

export interface ConfigurationSnapshot {
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
  fingerprint: string;
  payload: ConfigurationSnapshotPayload;
}

export interface ConfigurationHistoryDocument {
  version: 1;
  guilds: Record<string, ConfigurationSnapshot[]>;
}

export interface ConfigurationHistoryActor {
  id: string;
  name: string;
}

interface FormVersionRow extends QueryResultRow {
  id: string;
  name: string;
  department_id: string;
  tag_id: string | null;
  current_version: number;
  active: boolean;
  schema: unknown;
  snapshot: unknown;
}

interface DocumentRow extends QueryResultRow {
  document_key: string;
  payload: unknown;
}

const REQUIRED_PAYLOAD_KEYS = ['guildConfig', 'advancedSettings', 'supportHours', 'ticketForms'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ':' + canonicalJson(record[key]),
  ).join(',') + '}';
}

export function configurationFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex').slice(0, 16);
}

function malformedHistory(reason: string): Error {
  return new Error('Configuration history document is malformed (' + reason + '). Existing history was not overwritten.');
}

function validateSnapshot(value: unknown, guildId: string): ConfigurationSnapshot {
  if (!isRecord(value)) throw malformedHistory('malformed snapshot');
  const raw = value;

  if (
    !nonBlank(raw.id) || !/^cfg_[A-Za-z0-9_-]{1,80}$/.test(raw.id) ||
    raw.guildId !== guildId ||
    !nonBlank(raw.createdAt) || !Number.isFinite(Date.parse(raw.createdAt)) ||
    !nonBlank(raw.createdById) || typeof raw.createdByName !== 'string' ||
    typeof raw.reason !== 'string' ||
    !Number.isInteger(raw.departmentCount) || (raw.departmentCount as number) < 0 ||
    !Number.isInteger(raw.panelCount) || (raw.panelCount as number) < 0 ||
    !Number.isInteger(raw.tagCount) || (raw.tagCount as number) < 0 ||
    !Number.isInteger(raw.formCount) || (raw.formCount as number) < 0 ||
    !Number.isInteger(raw.supportHoursPolicyCount) || (raw.supportHoursPolicyCount as number) < 0 ||
    !isRecord(raw.payload)
  ) throw malformedHistory('malformed snapshot metadata');

  for (const key of REQUIRED_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw.payload, key)) throw malformedHistory('malformed snapshot payload');
  }
  if (
    !isRecord(raw.payload.guildConfig) ||
    !isRecord(raw.payload.advancedSettings) ||
    !Array.isArray(raw.payload.supportHours) ||
    !Array.isArray(raw.payload.ticketForms)
  ) throw malformedHistory('malformed snapshot payload');
  if (raw.fingerprint !== undefined && (
    typeof raw.fingerprint !== 'string' || !/^[a-f0-9]{16}$/i.test(raw.fingerprint)
  )) throw malformedHistory('malformed snapshot fingerprint');

  const payload: ConfigurationSnapshotPayload = {
    guildConfig: raw.payload.guildConfig,
    advancedSettings: raw.payload.advancedSettings,
    supportHours: raw.payload.supportHours,
    ticketForms: raw.payload.ticketForms,
  };
  const computedFingerprint = configurationFingerprint(payload);
  if (typeof raw.fingerprint === 'string' && raw.fingerprint.toLowerCase() !== computedFingerprint) {
    throw malformedHistory('snapshot fingerprint does not match its payload');
  }
  return {
    id: raw.id,
    guildId,
    createdAt: raw.createdAt,
    createdById: raw.createdById,
    createdByName: raw.createdByName,
    reason: raw.reason,
    departmentCount: raw.departmentCount as number,
    panelCount: raw.panelCount as number,
    tagCount: raw.tagCount as number,
    formCount: raw.formCount as number,
    supportHoursPolicyCount: raw.supportHoursPolicyCount as number,
    fingerprint: computedFingerprint,
    payload,
  };
}

/** Corrupt data is rejected; it is never silently dropped during a history write. */
export function normalizeConfigurationHistoryDocument(value: unknown): ConfigurationHistoryDocument {
  if (value === undefined) return { version: 1, guilds: {} };
  if (value === null || !isRecord(value)) throw new Error('Configuration history document is malformed.');
  if (value.version !== 1) throw new Error('Configuration history document version is unsupported.');
  if (!isRecord(value.guilds)) throw new Error('Configuration history document is malformed.');

  const guilds: Record<string, ConfigurationSnapshot[]> = {};
  for (const [guildId, rawSnapshots] of Object.entries(value.guilds)) {
    if (!guildId.trim() || !Array.isArray(rawSnapshots)) {
      throw new Error('Configuration history contains a malformed guild entry. Existing history was not overwritten.');
    }
    const seenIds = new Set<string>();
    const normalized: ConfigurationSnapshot[] = [];
    for (const raw of rawSnapshots) {
      const snapshot = validateSnapshot(raw, guildId);
      if (seenIds.has(snapshot.id)) throw malformedHistory('duplicate snapshot ID');
      seenIds.add(snapshot.id);
      normalized.push(snapshot);
    }
    guilds[guildId] = normalized.slice(0, MAX_CONFIGURATION_SNAPSHOTS_PER_GUILD);
  }
  return { version: 1, guilds };
}

function requireFingerprint(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{16}$/i.test(value)) {
    throw new Error(label + ' is malformed. Nothing was restored.');
  }
  return value.toLowerCase();
}

export function assertConfigurationSnapshotUnchanged(before: unknown, current: unknown, snapshotId: string): void {
  if (configurationFingerprint(before) !== configurationFingerprint(current)) {
    throw new Error('Configuration changed after restore preview for ' + snapshotId + '. No restore was applied; preview the snapshot again.');
  }
}

export function assertCurrentConfigurationFingerprint(expectedFingerprint: string, currentFingerprint: string): void {
  const expected = requireFingerprint(expectedFingerprint, 'Restore preview fingerprint');
  const current = requireFingerprint(currentFingerprint, 'Current configuration fingerprint');
  if (expected !== current) throw new Error('Current configuration differs from the restore preview. Nothing was restored.');
}

export function arrangeConfigurationSnapshotHistory<T extends { id: string }>(
  history: readonly T[],
  preRestoreSnapshot: T,
  targetSnapshotId: string,
  maximum = MAX_CONFIGURATION_SNAPSHOTS_PER_GUILD,
): T[] {
  if (!Number.isInteger(maximum) || maximum < 2 || maximum > 100) {
    throw new Error('Configuration-history retention must be between 2 and 100 snapshots.');
  }
  const selected = history.find((snapshot) => snapshot.id === targetSnapshotId);
  if (!selected) throw new Error('The requested restore checkpoint disappeared from history. No restore was applied.');
  if (preRestoreSnapshot.id === targetSnapshotId) {
    throw new Error('The pre-restore checkpoint must have a new unique ID. No restore was applied.');
  }
  return [
    preRestoreSnapshot,
    selected,
    ...history.filter((snapshot) => snapshot.id !== selected.id && snapshot.id !== preRestoreSnapshot.id),
  ].slice(0, maximum);
}

function extractGuildValue(document: unknown, guildId: string): Record<string, unknown> {
  if (!isRecord(document) || !isRecord(document.guilds)) return {};
  const value = document.guilds[guildId];
  return isRecord(value) ? value : {};
}

function supportHoursFromDocument(document: unknown, guildId: string): unknown[] {
  const values = Object.values(extractGuildValue(document, guildId)).filter(isRecord);
  return values.sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
}

function toFormPayload(row: FormVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    departmentId: row.department_id,
    tagId: row.tag_id,
    currentVersion: Number(row.current_version),
    active: row.active,
    schema: row.schema,
    snapshot: row.snapshot,
  };
}

async function queryFormPayload(
  executor: { query: <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }> },
  guildId: string,
): Promise<Record<string, unknown>[]> {
  const result = await executor.query<FormVersionRow>(
    `SELECT f.id, f.name, f.department_id, f.tag_id, f.current_version, f.active,
            v.schema, v.snapshot
       FROM ticket_forms AS f
       JOIN ticket_form_versions AS v ON v.form_id = f.id AND v.version = f.current_version
      WHERE f.guild_id = $1
      ORDER BY f.id`,
    [guildId],
  );
  return result.rows.map(toFormPayload);
}

function makeSnapshot(
  guildId: string,
  payload: ConfigurationSnapshotPayload,
  actor: ConfigurationHistoryActor,
  reason: string,
): ConfigurationSnapshot {
  const config = payload.guildConfig;
  const departments = isRecord(config.departments) ? config.departments : {};
  let tagCount = 0;
  for (const department of Object.values(departments)) {
    if (isRecord(department) && isRecord(department.tags)) tagCount += Object.keys(department.tags).length;
  }
  const customPanels = isRecord(config.customPanels) ? config.customPanels : {};
  const id = 'cfg_' + randomUUID().replace(/-/g, '').slice(0, 20);
  return {
    id,
    guildId,
    createdAt: new Date().toISOString(),
    createdById: actor.id,
    createdByName: actor.name.trim().slice(0, 100),
    reason: reason.trim().slice(0, 500),
    departmentCount: Object.keys(departments).length,
    panelCount: Object.keys(customPanels).length,
    tagCount,
    formCount: payload.ticketForms.length,
    supportHoursPolicyCount: payload.supportHours.length,
    fingerprint: configurationFingerprint(payload),
    payload,
  };
}

async function ensureConfigurationServices(guildId: string): Promise<void> {
  await initializePersistence();
  await getGuildConfig(guildId);
  await updateGuildConfig(guildId, () => undefined);
  await getAdvancedSettings(guildId);
  await updateAdvancedSettings(guildId, () => undefined);
  await getSupportHoursPolicies(guildId);
}

export async function getCurrentConfigurationPayload(guildId: string): Promise<ConfigurationSnapshotPayload> {
  if (!nonBlank(guildId)) throw new Error('A guild ID is required.');
  await ensureConfigurationServices(guildId);
  const [configDocument, advancedDocument, hoursDocument] = await Promise.all([
    getJsonDocument<unknown>('guild-config'),
    getJsonDocument<unknown>('advanced-settings'),
    getJsonDocument<unknown>('support-hours'),
  ]);
  const ticketForms = await queryFormPayload(getPostgresPool(), guildId);
  return {
    guildConfig: extractGuildValue(configDocument, guildId),
    advancedSettings: extractGuildValue(advancedDocument, guildId),
    supportHours: supportHoursFromDocument(hoursDocument, guildId),
    ticketForms,
  };
}

async function loadHistory(): Promise<ConfigurationHistoryDocument> {
  return normalizeConfigurationHistoryDocument(await getJsonDocument<unknown>(CONFIGURATION_HISTORY_DOCUMENT_KEY));
}

async function saveHistory(document: ConfigurationHistoryDocument): Promise<void> {
  await setJsonDocument(CONFIGURATION_HISTORY_DOCUMENT_KEY, document);
}

export async function createConfigurationSnapshot(
  guildId: string,
  actor: ConfigurationHistoryActor,
  reason: string,
): Promise<ConfigurationSnapshot> {
  if (!nonBlank(guildId)) throw new Error('A guild ID is required.');
  if (!actor || !nonBlank(actor.id) || typeof actor.name !== 'string' || !actor.name.trim()) {
    throw new Error('A valid administrator identity is required to create a configuration checkpoint.');
  }
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('Enter a reason for the configuration checkpoint.');

  const snapshot = makeSnapshot(guildId, await getCurrentConfigurationPayload(guildId), actor, reason);
  const history = await loadHistory();
  const existing = history.guilds[guildId] ?? [];
  if (existing.some((item) => item.id === snapshot.id)) throw new Error('A duplicate configuration checkpoint ID was generated. Retry the operation.');
  history.guilds[guildId] = [snapshot, ...existing].slice(0, MAX_CONFIGURATION_SNAPSHOTS_PER_GUILD);
  await saveHistory(history);
  return snapshot;
}

export async function listConfigurationSnapshots(guildId: string): Promise<ConfigurationSnapshot[]> {
  if (!nonBlank(guildId)) throw new Error('A guild ID is required.');
  return [...((await loadHistory()).guilds[guildId] ?? [])];
}

export async function getConfigurationSnapshot(guildId: string, snapshotId: string): Promise<ConfigurationSnapshot | undefined> {
  if (!nonBlank(guildId) || !nonBlank(snapshotId)) return undefined;
  return (await listConfigurationSnapshots(guildId)).find((snapshot) => snapshot.id === snapshotId);
}

export async function restoreConfigurationSnapshot(
  guildId: string,
  snapshotId: string,
  confirmation: string,
  actor: ConfigurationHistoryActor,
  expectedCurrentFingerprint: string,
): Promise<{ restoredSnapshotId: string; preRestoreSnapshotId: string; fingerprint: string }> {
  // This guard deliberately precedes all persistence reads and connection setup.
  if (confirmation !== 'RESTORE ' + snapshotId) throw new Error('Restore confirmation did not match. Nothing was changed.');
  if (!nonBlank(guildId) || !nonBlank(snapshotId)) throw new Error('A guild ID and snapshot ID are required. Nothing was restored.');
  if (!actor || !nonBlank(actor.id) || typeof actor.name !== 'string' || !actor.name.trim()) {
    throw new Error('A valid administrator identity is required. Nothing was restored.');
  }
  requireFingerprint(expectedCurrentFingerprint, 'Restore preview fingerprint');

  await ensureConfigurationServices(guildId);
  const pool = getPostgresPool();
  const client = await pool.connect();
  let preRestoreSnapshot: ConfigurationSnapshot | null = null;
  let restoredFingerprint = '';

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO app_documents (document_key, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (document_key) DO NOTHING`,
      [CONFIGURATION_HISTORY_DOCUMENT_KEY, JSON.stringify({ version: 1, guilds: {} })],
    );
    const docsResult = await client.query<DocumentRow>(
      `SELECT document_key, payload
         FROM app_documents
        WHERE document_key = ANY($1::text[])
        FOR UPDATE`,
      [['guild-config', 'advanced-settings', 'support-hours', CONFIGURATION_HISTORY_DOCUMENT_KEY]],
    );
    const docs = new Map(docsResult.rows.map((row) => [row.document_key, row.payload]));
    const history = normalizeConfigurationHistoryDocument(docs.get(CONFIGURATION_HISTORY_DOCUMENT_KEY));
    const target = (history.guilds[guildId] ?? []).find((item) => item.id === snapshotId);
    if (!target) throw new Error('Configuration checkpoint was not found for this server. Nothing was restored.');

    const currentPayload: ConfigurationSnapshotPayload = {
      guildConfig: extractGuildValue(docs.get('guild-config'), guildId),
      advancedSettings: extractGuildValue(docs.get('advanced-settings'), guildId),
      supportHours: supportHoursFromDocument(docs.get('support-hours'), guildId),
      ticketForms: await queryFormPayload(client, guildId),
    };
    assertCurrentConfigurationFingerprint(expectedCurrentFingerprint, configurationFingerprint(currentPayload));

    preRestoreSnapshot = makeSnapshot(
      guildId,
      currentPayload,
      actor,
      'Automatic checkpoint before restoring ' + snapshotId,
    );
    history.guilds[guildId] = arrangeConfigurationSnapshotHistory(
      history.guilds[guildId] ?? [],
      preRestoreSnapshot,
      snapshotId,
      MAX_CONFIGURATION_SNAPSHOTS_PER_GUILD,
    ) as ConfigurationSnapshot[];
    restoredFingerprint = target.fingerprint;

    const configDoc = isRecord(docs.get('guild-config')) ? docs.get('guild-config') as Record<string, unknown> : { version: 1, guilds: {} };
    const advancedDoc = isRecord(docs.get('advanced-settings')) ? docs.get('advanced-settings') as Record<string, unknown> : { version: 5, guilds: {} };
    const hoursDoc = isRecord(docs.get('support-hours')) ? docs.get('support-hours') as Record<string, unknown> : { version: 1, guilds: {} };
    const configGuilds = isRecord(configDoc.guilds) ? configDoc.guilds : {};
    const advancedGuilds = isRecord(advancedDoc.guilds) ? advancedDoc.guilds : {};
    const hoursGuilds = isRecord(hoursDoc.guilds) ? hoursDoc.guilds : {};
    const restoredHours = Object.fromEntries(
      target.payload.supportHours.filter(isRecord).map((policy) => [String(policy.id), policy]),
    );

    const replacements: Array<[string, Record<string, unknown>]> = [
      ['guild-config', { ...configDoc, guilds: { ...configGuilds, [guildId]: target.payload.guildConfig } }],
      ['advanced-settings', { ...advancedDoc, guilds: { ...advancedGuilds, [guildId]: target.payload.advancedSettings } }],
      ['support-hours', { ...hoursDoc, guilds: { ...hoursGuilds, [guildId]: restoredHours } }],
      [CONFIGURATION_HISTORY_DOCUMENT_KEY, history as unknown as Record<string, unknown>],
    ];
    for (const [key, payload] of replacements) {
      await client.query(
        `INSERT INTO app_documents (document_key, payload, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (document_key)
         DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [key, JSON.stringify(payload)],
      );
    }

    // Forms are versioned and submissions reference those versions. Preserve all
    // historical rows, deactivate post-checkpoint mappings, and reactivate only
    // versions that still exist exactly as saved in the snapshot.
    await client.query('UPDATE ticket_forms SET active = FALSE, updated_at = NOW() WHERE guild_id = $1', [guildId]);
    for (const rawForm of target.payload.ticketForms) {
      if (!isRecord(rawForm)) throw new Error('Saved ticket-form state is malformed. Nothing was restored.');
      const formId = rawForm.id;
      const name = rawForm.name;
      const departmentId = rawForm.departmentId;
      const tagId = rawForm.tagId ?? null;
      const currentVersion = rawForm.currentVersion;
      const active = rawForm.active;
      if (
        !nonBlank(formId) || typeof name !== 'string' || !nonBlank(departmentId) ||
        (tagId !== null && typeof tagId !== 'string') ||
        !Number.isInteger(currentVersion) || (currentVersion as number) < 1 ||
        typeof active !== 'boolean'
      ) throw new Error('Saved ticket-form state is malformed. Nothing was restored.');

      const updated = await client.query(
        `UPDATE ticket_forms AS form
            SET name = $3, department_id = $4, tag_id = $5,
                current_version = $6, active = $7, updated_at = NOW()
          WHERE form.id = $1 AND form.guild_id = $2
            AND EXISTS (
              SELECT 1 FROM ticket_form_versions AS version
               WHERE version.form_id = form.id AND version.version = $6
            )`,
        [formId, guildId, name, departmentId, tagId, currentVersion, active],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new Error('A saved form or its version is no longer available (' + formId + '). Nothing was restored.');
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  await Promise.all([resetConfigState(), resetAdvancedSettingsState(), resetSupportHoursStateForReload()]);
  return {
    restoredSnapshotId: snapshotId,
    preRestoreSnapshotId: preRestoreSnapshot?.id ?? '',
    fingerprint: restoredFingerprint,
  };
}
