import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { previewWorkflowTemplate, validateWorkflowTemplateDefinition, type WorkflowTemplateDefinition } from '../core/domain/workflowSafety';
import { getGuildConfig } from './configService';
import { listQuickReplies } from './quickReplyService';

export interface WorkflowTemplate {
  id: string;
  guildId: string;
  name: string;
  definition: WorkflowTemplateDefinition;
  enabled: boolean;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTemplateRevision {
  version: number;
  name: string;
  enabled: boolean;
  deleted: boolean;
  operation: 'created' | 'updated' | 'enabled' | 'disabled' | 'deleted' | 'baseline' | 'restored';
  changedBy: string;
  createdAt: string;
}

interface WorkflowRow extends QueryResultRow {
  id: string;
  guild_id: string;
  name: string;
  definition: Record<string, unknown>;
  enabled: boolean;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS = 'id,guild_id,name,definition,enabled,version,created_by,updated_by,created_at,updated_at';

function iso(value: Date | string): string {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date(0).toISOString();
}

function fromRow(row: WorkflowRow): WorkflowTemplate {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    definition: validateWorkflowTemplateDefinition(row.definition),
    enabled: Boolean(row.enabled),
    version: Number(row.version),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function insertWorkflowRevision(
  client: PoolClient,
  template: WorkflowTemplate,
  actorId: string,
  operation: WorkflowTemplateRevision['operation'],
  deleted = false,
): Promise<void> {
  await client.query(
    'INSERT INTO workflow_template_revisions ' +
      '(id,guild_id,template_id,version,name,definition,enabled,deleted,operation,changed_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)',
    [
      randomUUID(), template.guildId, template.id, template.version, template.name,
      JSON.stringify(template.definition), template.enabled, deleted, operation, actorId,
    ],
  );
}

async function assertWorkflowReferencesExist(
  guildId: string,
  definition: WorkflowTemplateDefinition,
): Promise<void> {
  const config = await getGuildConfig(guildId);
  const departmentIds = new Set(
    Object.entries(config.departments).flatMap(([key, department]) => [key, department.id]),
  );
  const tagIds = new Set(
    Object.values(config.departments).flatMap((department) =>
      Object.values(department.tags).map((tag) => tag.id),
    ),
  );
  for (const condition of definition.conditions) {
    if (condition.field === 'departmentId' && !departmentIds.has(condition.equals)) {
      throw new Error('Workflow condition references a department that does not exist in this server: ' + condition.equals);
    }
  }
  const replies = await listQuickReplies(guildId, { isAdmin: true, roleIds: [] });
  const replyById = new Map(replies.map((reply) => [reply.id, reply]));
  for (const action of definition.actions) {
    if (action.type === 'assign_department' && !departmentIds.has(action.value)) {
      throw new Error('Workflow references a department that does not exist in this server: ' + action.value);
    }
    if (action.type === 'add_tag' && !tagIds.has(action.value)) {
      throw new Error('Workflow references a tag that does not exist in this server: ' + action.value);
    }
    if (action.type === 'send_quick_reply' && !replyById.get(action.value)?.enabled) {
      throw new Error('Workflow must reference an enabled quick reply in this server: ' + action.value);
    }
  }
}

function validName(name: string): string {
  const value = name.trim().replace(/\s+/g, ' ');
  if (value.length < 2 || value.length > 80) {
    throw new Error('Workflow names must be 2–80 characters.');
  }
  return value;
}

export async function listWorkflowTemplates(guildId: string): Promise<WorkflowTemplate[]> {
  const result = await getPostgresPool().query<WorkflowRow>(
    'SELECT ' + COLUMNS + ' FROM workflow_templates WHERE guild_id=$1 AND deleted_at IS NULL ORDER BY name LIMIT 100',
    [guildId],
  );
  return result.rows.map(fromRow);
}

export async function listWorkflowTemplateRevisions(
  guildId: string,
  templateId: string,
): Promise<WorkflowTemplateRevision[]> {
  const exists = await getPostgresPool().query<QueryResultRow & { id: string }>(
    'SELECT id FROM workflow_templates WHERE guild_id=$1 AND id=$2 LIMIT 1',
    [guildId, templateId],
  );
  if (!exists.rows[0]) throw new Error('Workflow template was not found in this server.');
  const result = await getPostgresPool().query<QueryResultRow & {
    version: number; name: string; enabled: boolean; deleted: boolean;
    operation: WorkflowTemplateRevision['operation']; changed_by: string; created_at: Date | string;
  }>(
    'SELECT version,name,enabled,deleted,operation,changed_by,created_at FROM workflow_template_revisions ' +
      'WHERE guild_id=$1 AND template_id=$2 ORDER BY version DESC LIMIT 50',
    [guildId, templateId],
  );
  return result.rows.map((row) => ({
    version: Number(row.version),
    name: row.name,
    enabled: Boolean(row.enabled),
    deleted: Boolean(row.deleted),
    operation: row.operation,
    changedBy: row.changed_by,
    createdAt: iso(row.created_at),
  }));
}

export async function saveWorkflowTemplate(
  guildId: string,
  actorId: string,
  name: string,
  definition: unknown,
  expectedVersion?: number,
): Promise<WorkflowTemplate> {
  const safeName = validName(name);
  const safeDefinition = validateWorkflowTemplateDefinition(definition);
  if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
    throw new Error('Expected version must be a positive integer when updating a workflow template.');
  }
  await assertWorkflowReferencesExist(guildId, safeDefinition);

  const pool = getPostgresPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query<WorkflowRow>(
      'SELECT ' + COLUMNS + ' FROM workflow_templates WHERE guild_id=$1 AND LOWER(name)=LOWER($2) ' +
        'AND deleted_at IS NULL FOR UPDATE',
      [guildId, safeName],
    );
    const current = currentResult.rows[0];

    if (current) {
      if (expectedVersion === undefined) {
        throw new Error(
          'A workflow template with this name already exists at version ' + current.version +
          '. Pass the current expected-version from /supportforge workflow list to update it.',
        );
      }
      if (Number(current.version) !== expectedVersion) {
        throw new Error('This workflow template changed since you opened it. Refresh the list and retry.');
      }
      const updated = await client.query<WorkflowRow>(
        'UPDATE workflow_templates SET definition=$4::jsonb,enabled=FALSE,version=version+1,' +
          'updated_by=$5,updated_at=NOW() WHERE guild_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL RETURNING ' + COLUMNS,
        [guildId, current.id, expectedVersion, JSON.stringify(safeDefinition), actorId],
      );
      if (!updated.rows[0]) throw new Error('This workflow template changed during the save. Refresh and retry.');
      const saved = fromRow(updated.rows[0]);
      await insertWorkflowRevision(client, saved, actorId, 'updated');
      await client.query('COMMIT');
      return saved;
    }

    if (expectedVersion !== undefined) {
      throw new Error('No active workflow template exists at that version. Omit expected-version to create a new template.');
    }
    const inserted = await client.query<WorkflowRow>(
      'INSERT INTO workflow_templates (id,guild_id,name,definition,enabled,version,created_by,updated_by) ' +
        'VALUES ($1,$2,$3,$4::jsonb,FALSE,1,$5,$5) RETURNING ' + COLUMNS,
      [randomUUID(), guildId, safeName, JSON.stringify(safeDefinition), actorId],
    );
    const saved = fromRow(inserted.rows[0]);
    await insertWorkflowRevision(client, saved, actorId, 'created');
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505') {
      throw new Error('Another administrator created a workflow template with this name concurrently. Refresh the list before retrying.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function setWorkflowTemplateEnabled(
  guildId: string,
  templateId: string,
  expectedVersion: number,
  enabled: boolean,
  actorId: string,
): Promise<WorkflowTemplate> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('Expected version must be a positive integer.');
  }
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<WorkflowRow>(
      'SELECT ' + COLUMNS + ' FROM workflow_templates WHERE guild_id=$1 AND id=$2 ' +
        'AND version=$3 AND deleted_at IS NULL FOR UPDATE',
      [guildId, templateId, expectedVersion],
    );
    if (!current.rows[0]) {
      throw new Error('Workflow template was not found or its version changed. Refresh the list before retrying.');
    }
    const templateBefore = fromRow(current.rows[0]);
    if (templateBefore.enabled === enabled) {
      throw new Error('Workflow template is already ' + (enabled ? 'enabled' : 'disabled') + '.');
    }
    if (enabled) await assertWorkflowReferencesExist(guildId, templateBefore.definition);
    const result = await client.query<WorkflowRow>(
      'UPDATE workflow_templates SET enabled=$4,version=version+1,updated_by=$5,updated_at=NOW() ' +
        'WHERE guild_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL RETURNING ' + COLUMNS,
      [guildId, templateId, expectedVersion, enabled, actorId],
    );
    if (!result.rows[0]) throw new Error('Workflow template changed while being updated. Refresh the list before retrying.');
    const saved = fromRow(result.rows[0]);
    await insertWorkflowRevision(client, saved, actorId, enabled ? 'enabled' : 'disabled');
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Restore a retained workflow definition into a new disabled revision. */
export async function restoreWorkflowTemplateRevision(
  guildId: string,
  templateId: string,
  revisionNumber: number,
  expectedVersion: number,
  actorId: string,
): Promise<WorkflowTemplate> {
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1 ||
      !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('Revision and expected current version must be positive integers.');
  }
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query<WorkflowRow & {
      deleted_at: Date | string | null;
    }>(
      'SELECT ' + COLUMNS + ',deleted_at FROM workflow_templates ' +
        'WHERE guild_id=$1 AND id=$2 FOR UPDATE',
      [guildId, templateId],
    );
    const current = currentResult.rows[0];
    if (!current) throw new Error('Workflow template was not found in this server.');
    if (Number(current.version) !== expectedVersion) {
      throw new Error('This workflow template changed since it was opened. Refresh its current version before restoring history.');
    }

    const history = await client.query<QueryResultRow & {
      name: string;
      definition: unknown;
    }>(
      'SELECT name,definition FROM workflow_template_revisions ' +
        'WHERE guild_id=$1 AND template_id=$2 AND version=$3 LIMIT 1',
      [guildId, templateId, revisionNumber],
    );
    const revision = history.rows[0];
    if (!revision) throw new Error('That workflow revision does not exist in this server.');

    const safeName = validName(revision.name);
    const safeDefinition = validateWorkflowTemplateDefinition(revision.definition);
    await assertWorkflowReferencesExist(guildId, safeDefinition);

    const updated = await client.query<WorkflowRow>(
      'UPDATE workflow_templates SET name=$4,definition=$5::jsonb,enabled=FALSE,deleted_at=NULL,' +
        'version=version+1,updated_by=$6,updated_at=NOW() ' +
        'WHERE guild_id=$1 AND id=$2 AND version=$3 RETURNING ' + COLUMNS,
      [guildId, templateId, expectedVersion, safeName, JSON.stringify(safeDefinition), actorId],
    );
    if (!updated.rows[0]) throw new Error('This workflow template changed during history restoration. Refresh and retry.');
    const saved = fromRow(updated.rows[0]);
    await insertWorkflowRevision(client, saved, actorId, 'restored');
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505') {
      throw new Error('An active workflow template already uses that name. Resolve the name conflict before restoring.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function previewWorkflowTemplateById(
  guildId: string,
  templateId: string,
): Promise<ReturnType<typeof previewWorkflowTemplate>> {
  const result = await getPostgresPool().query<WorkflowRow>(
    'SELECT ' + COLUMNS + ' FROM workflow_templates WHERE guild_id=$1 AND id=$2 AND deleted_at IS NULL LIMIT 1',
    [guildId, templateId],
  );
  if (!result.rows[0]) throw new Error('Workflow template was not found in this server.');
  return previewWorkflowTemplate(fromRow(result.rows[0]).definition);
}

export async function deleteWorkflowTemplate(
  guildId: string,
  templateId: string,
  expectedVersion: number,
  actorId: string,
): Promise<boolean> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('Expected version must be a positive integer.');
  }
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<WorkflowRow>(
      'SELECT ' + COLUMNS + ' FROM workflow_templates WHERE guild_id=$1 AND id=$2 ' +
        'AND version=$3 AND deleted_at IS NULL FOR UPDATE',
      [guildId, templateId, expectedVersion],
    );
    if (!current.rows[0]) {
      throw new Error('Workflow template was not found or its version changed. Refresh the list before retrying.');
    }
    const result = await client.query<WorkflowRow>(
      'UPDATE workflow_templates SET enabled=FALSE,deleted_at=NOW(),version=version+1,updated_by=$4,updated_at=NOW() ' +
        'WHERE guild_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL RETURNING ' + COLUMNS,
      [guildId, templateId, expectedVersion, actorId],
    );
    if (!result.rows[0]) throw new Error('Workflow template changed during deletion. Refresh and retry.');
    const saved = fromRow(result.rows[0]);
    await insertWorkflowRevision(client, saved, actorId, 'deleted', true);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
