import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

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

interface WorkflowRow extends QueryResultRow {
  id:string;guild_id:string;name:string;definition:Record<string,unknown>;enabled:boolean;version:number;
  created_by:string;updated_by:string;created_at:Date|string;updated_at:Date|string;
}
const COLUMNS='id,guild_id,name,definition,enabled,version,created_by,updated_by,created_at,updated_at';
function iso(value:Date|string):string { const n=value instanceof Date?value.getTime():Date.parse(value);return Number.isFinite(n)?new Date(n).toISOString():new Date(0).toISOString(); }
function fromRow(row:WorkflowRow):WorkflowTemplate {
 return {id:row.id,guildId:row.guild_id,name:row.name,definition:validateWorkflowTemplateDefinition(row.definition),
  enabled:Boolean(row.enabled),version:Number(row.version),createdBy:row.created_by,updatedBy:row.updated_by,
  createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};
}
async function assertWorkflowReferencesExist(guildId: string, definition: WorkflowTemplateDefinition): Promise<void> {
  const config = await getGuildConfig(guildId);
  const departmentIds = new Set(Object.entries(config.departments).flatMap(([key, department]) => [key, department.id]));
  const tagIds = new Set(Object.values(config.departments).flatMap((department) => Object.values(department.tags).map((tag) => tag.id)));
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

function validName(name:string):string {
 const value=name.trim().replace(/\s+/g,' ');
 if(value.length<2||value.length>80) throw new Error('Workflow names must be 2–80 characters.');
 return value;
}
export async function listWorkflowTemplates(guildId:string):Promise<WorkflowTemplate[]> {
 const result=await getPostgresPool().query<WorkflowRow>('SELECT '+COLUMNS+' FROM workflow_templates WHERE guild_id=$1 ORDER BY name LIMIT 100',[guildId]);
 return result.rows.map(fromRow);
}
export async function saveWorkflowTemplate(guildId:string,actorId:string,name:string,definition:unknown):Promise<WorkflowTemplate> {
 const safeName=validName(name),safeDefinition=validateWorkflowTemplateDefinition(definition);
 await assertWorkflowReferencesExist(guildId, safeDefinition);
 const result=await getPostgresPool().query<WorkflowRow>(
  'INSERT INTO workflow_templates (id,guild_id,name,definition,enabled,version,created_by,updated_by) VALUES ($1,$2,$3,$4::jsonb,FALSE,1,$5,$5) '+
  'ON CONFLICT (guild_id,name) DO UPDATE SET definition=EXCLUDED.definition,enabled=FALSE,version=workflow_templates.version+1,updated_by=EXCLUDED.updated_by,updated_at=NOW() RETURNING '+COLUMNS,
  [randomUUID(),guildId,safeName,JSON.stringify(safeDefinition),actorId]);
 return fromRow(result.rows[0]);
}
export async function setWorkflowTemplateEnabled(guildId:string,templateId:string,expectedVersion:number,enabled:boolean,actorId:string):Promise<WorkflowTemplate> {
 if(!Number.isInteger(expectedVersion)||expectedVersion<1) throw new Error('Expected version must be a positive integer.');
 const pool = getPostgresPool();
 const current = await pool.query<WorkflowRow>(
  'SELECT '+COLUMNS+' FROM workflow_templates WHERE guild_id=$1 AND id=$2 AND version=$3 LIMIT 1',
  [guildId,templateId,expectedVersion]);
 if(!current.rows[0]) throw new Error('Workflow template was not found or its version changed. Refresh the list before retrying.');
 const templateBefore = fromRow(current.rows[0]);
 if(enabled) await assertWorkflowReferencesExist(guildId, templateBefore.definition);
 const result=await pool.query<WorkflowRow>(
  'UPDATE workflow_templates SET enabled=$4,version=version+1,updated_by=$5,updated_at=NOW() WHERE guild_id=$1 AND id=$2 AND version=$3 RETURNING '+COLUMNS,
  [guildId,templateId,expectedVersion,enabled,actorId]);
 if(!result.rows[0]) throw new Error('Workflow template changed while being updated. Refresh the list before retrying.');
 return fromRow(result.rows[0]);
}
export async function previewWorkflowTemplateById(guildId:string,templateId:string):Promise<ReturnType<typeof previewWorkflowTemplate>> {
 const result=await getPostgresPool().query<WorkflowRow>('SELECT '+COLUMNS+' FROM workflow_templates WHERE guild_id=$1 AND id=$2 LIMIT 1',[guildId,templateId]);
 if(!result.rows[0]) throw new Error('Workflow template was not found in this server.');
 return previewWorkflowTemplate(fromRow(result.rows[0]).definition);
}
export async function deleteWorkflowTemplate(guildId:string,templateId:string,expectedVersion:number):Promise<boolean> {
 const result=await getPostgresPool().query('DELETE FROM workflow_templates WHERE guild_id=$1 AND id=$2 AND version=$3',[guildId,templateId,expectedVersion]);
 return (result.rowCount??0)>0;
}
