import { randomUUID } from 'node:crypto';
import type { Guild, TextChannel, ThreadChannel } from 'discord.js';
import type { QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { withPostgresAdvisoryLock } from '../core/persistence/operationLock';
import { recoverySegmentMarker, extractRecoverySegmentMarkers } from '../core/domain/recoveryReplayMarkers';
import { evaluateWorkflowConditions, validateWorkflowTemplateDefinition, type WorkflowAction } from '../core/domain/workflowSafety';
import type { EventActor } from '../core/events/domainEvents';
import type { TicketPriority } from './advancedSettingsService';
import { getGuildConfig } from './configService';
import { logTicketEvent } from './auditLogService';
import { getPersistedTicket, updatePersistedTicketMetadata, type PersistedTicket } from './ticketPersistenceService';
import { getQuickReply, renderQuickReply } from './quickReplyService';
import { getWorkflowTemplateById } from './workflowTemplateService';
import { getThemeColor } from './uiThemeService';

type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'needs_review' | 'not_matched';
type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'needs_review';

interface WorkflowRunRow extends QueryResultRow {
  id: string;
  guild_id: string;
  ticket_id: string;
  channel_id: string;
  template_id: string;
  template_version: number;
  template_name: string;
  requested_by: string;
  interaction_id: string;
  status: WorkflowRunStatus;
  definition: unknown;
  condition_evaluation: unknown;
  current_step_index: number | null;
  result: unknown;
  started_at: Date | string;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WorkflowStepRow extends QueryResultRow {
  id: string;
  run_id: string;
  step_index: number;
  action_type: WorkflowAction['type'];
  action_value: string;
  status: WorkflowStepStatus;
  attempts: number;
  marker: string | null;
  destination_message_id: string | null;
  result: unknown;
  error_code: string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

export interface WorkflowExecutionSummary {
  id: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  ticketId: string;
  status: WorkflowRunStatus;
  currentStepIndex: number | null;
  stepCount: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowExecutionStepSummary {
  stepIndex: number;
  actionType: string;
  status: WorkflowStepStatus;
  attempts: number;
  errorCode: string | null;
  destinationMessageId: string | null;
}

export interface WorkflowExecutionDetails {
  run: WorkflowExecutionSummary;
  steps: WorkflowExecutionStepSummary[];
}

const ACTOR = (actorId: string): EventActor => ({
  id: actorId,
  attribution: 'actorKnown',
  confidence: 'high',
});

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Corrupt JSON should be treated as an empty result summary, never code.
    }
  }
  return {};
}

function summaryFromRow(row: WorkflowRunRow, stepCount: number): WorkflowExecutionSummary {
  return {
    id: row.id,
    templateId: row.template_id,
    templateName: row.template_name,
    templateVersion: Number(row.template_version),
    ticketId: row.ticket_id,
    status: row.status,
    currentStepIndex: row.current_step_index === null ? null : Number(row.current_step_index),
    stepCount,
    startedAt: iso(row.started_at) ?? new Date(0).toISOString(),
    finishedAt: iso(row.finished_at),
  };
}

async function getRunById(guildId: string, runId: string): Promise<WorkflowRunRow | null> {
  const result = await getPostgresPool().query<WorkflowRunRow>(
    'SELECT id,guild_id,ticket_id,channel_id,template_id,template_version,template_name,requested_by,interaction_id,status,definition,condition_evaluation,current_step_index,result,started_at,finished_at,created_at,updated_at ' +
      'FROM workflow_execution_runs WHERE guild_id=$1 AND id=$2 LIMIT 1',
    [guildId, runId],
  );
  return result.rows[0] ?? null;
}

async function getSteps(runId: string): Promise<WorkflowStepRow[]> {
  const result = await getPostgresPool().query<WorkflowStepRow>(
    'SELECT id,run_id,step_index,action_type,action_value,status,attempts,marker,destination_message_id,result,error_code,started_at,completed_at ' +
      'FROM workflow_execution_steps WHERE run_id=$1 ORDER BY step_index',
    [runId],
  );
  return result.rows;
}

async function readDetails(row: WorkflowRunRow): Promise<WorkflowExecutionDetails> {
  const steps = await getSteps(row.id);
  return {
    run: summaryFromRow(row, steps.length),
    steps: steps.map((step) => ({
      stepIndex: Number(step.step_index),
      actionType: step.action_type,
      status: step.status,
      attempts: Number(step.attempts),
      errorCode: step.error_code,
      destinationMessageId: step.destination_message_id,
    })),
  };
}

async function ensureRun(
  guildId: string,
  ticket: PersistedTicket,
  templateId: string,
  templateName: string,
  templateVersion: number,
  actorId: string,
  interactionId: string,
  definition: unknown,
  conditions: unknown,
): Promise<WorkflowRunRow> {
  const id = randomUUID();
  await getPostgresPool().query(
    'INSERT INTO workflow_execution_runs ' +
      '(id,guild_id,ticket_id,channel_id,template_id,template_version,template_name,requested_by,interaction_id,status,definition,condition_evaluation,current_step_index,result,started_at,created_at,updated_at) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10::jsonb,$11::jsonb,0,'{}'::jsonb,NOW(),NOW(),NOW()) " +
      'ON CONFLICT (guild_id,interaction_id) DO NOTHING',
    [id,guildId,ticket.id,ticket.channelId,templateId,templateVersion,templateName,actorId,interactionId,JSON.stringify(definition),JSON.stringify(conditions)],
  );
  const found = await getPostgresPool().query<WorkflowRunRow>(
    'SELECT id,guild_id,ticket_id,channel_id,template_id,template_version,template_name,requested_by,interaction_id,status,definition,condition_evaluation,current_step_index,result,started_at,finished_at,created_at,updated_at ' +
      'FROM workflow_execution_runs WHERE guild_id=$1 AND interaction_id=$2 LIMIT 1',
    [guildId, interactionId],
  );
  if (!found.rows[0]) throw new Error('Workflow execution intent could not be read back from PostgreSQL.');
  if (found.rows[0].ticket_id !== ticket.id || found.rows[0].template_id !== templateId) {
    throw new Error('This Discord interaction ID is already bound to a different workflow execution.');
  }
  return found.rows[0];
}

async function finishRun(
  guildId: string,
  runId: string,
  status: WorkflowRunStatus,
  result: Record<string, unknown>,
): Promise<WorkflowRunRow> {
  const updated = await getPostgresPool().query<WorkflowRunRow>(
    'UPDATE workflow_execution_runs SET status=$3,result=$4::jsonb,finished_at=CASE WHEN $3 IN (\'completed\',\'failed\',\'needs_review\',\'not_matched\') THEN NOW() ELSE NULL END,updated_at=NOW() ' +
      'WHERE guild_id=$1 AND id=$2 RETURNING id,guild_id,ticket_id,channel_id,template_id,template_version,template_name,requested_by,interaction_id,status,definition,condition_evaluation,current_step_index,result,started_at,finished_at,created_at,updated_at',
    [guildId,runId,status,JSON.stringify(result)],
  );
  if (!updated.rows[0]) throw new Error('Workflow execution record disappeared while saving its result.');
  return updated.rows[0];
}

function channelMatchesMarker(value: string, marker: string): boolean {
  return extractRecoverySegmentMarkers([value]).includes(marker);
}

async function findMarkerInHistory(
  channel: TextChannel | ThreadChannel,
  marker: string,
  startAt: Date,
): Promise<string | null> {
  let before: string | undefined;
  const minimum = startAt.getTime();
  while (true) {
    const options: { limit: number; before?: string } = { limit: 100 };
    if (before) options.before = before;
    const page = await channel.messages.fetch(options);
    if (!page.size) return null;
    for (const message of page.values()) {
      if (message.createdTimestamp < minimum) continue;
      const contents = [message.content, ...message.embeds.map((embed) => embed.footer?.text ?? '')];
      if (contents.some((value) => channelMatchesMarker(value, marker))) return message.id;
    }
    const oldest = Array.from(page.values()).reduce((current, item) =>
      BigInt(item.id) < BigInt(current.id) ? item : current,
    );
    if (oldest.createdTimestamp < minimum || page.size < 100) return null;
    before = oldest.id;
  }
}

async function saveStepFailure(
  step: WorkflowStepRow,
  status: 'failed' | 'needs_review',
  error: unknown,
): Promise<void> {
  const errorCode = error instanceof Error ? error.name.slice(0, 80) : 'UnknownError';
  await getPostgresPool().query(
    'UPDATE workflow_execution_steps SET status=$3,error_code=$4,completed_at=NOW(),updated_at=NOW() WHERE run_id=$1 AND step_index=$2',
    [step.run_id,step.step_index,status,errorCode],
  );
}

async function executeAction(
  guild: Guild,
  channel: TextChannel | ThreadChannel,
  run: WorkflowRunRow,
  step: WorkflowStepRow,
  ticket: PersistedTicket,
  actorId: string,
): Promise<void> {
  const pool = getPostgresPool();
  const action: WorkflowAction = { type: step.action_type, value: step.action_value };
  const config = await getGuildConfig(guild.id);
  const current = await getPersistedTicket(channel.id);
  if (!current || current.guildId !== guild.id || current.deletedAt || !['open','claimed','pending','reopened'].includes(current.status)) {
    throw new Error('Ticket is no longer active. Workflow execution stopped safely.');
  }

  if (action.type === 'assign_department') {
    const departmentEntry = Object.entries(config.departments).find(([key, department]) => key === action.value || department.id === action.value);
    if (!departmentEntry) throw new Error('Workflow department no longer exists. The remaining steps were not run.');
    const [departmentKey, department] = departmentEntry;
    if (current.departmentId === departmentKey && current.metadata.staffRoleId === department.staffRoleId) return;
    await updatePersistedTicketMetadata(
      current.channelId,
      {
        departmentId: departmentKey,
        tagId: null,
        metadata: { ...current.metadata, staffRoleId: department.staffRoleId, workflowLastAssignedBy: actorId },
      },
      ACTOR(actorId),
    );
    return;
  }

  if (action.type === 'set_priority') {
    if (current.priority === action.value) return;
    await updatePersistedTicketMetadata(current.channelId, { priority: action.value as TicketPriority }, ACTOR(actorId));
    return;
  }

  if (action.type === 'add_tag') {
    const departmentEntry = Object.entries(config.departments).find(([key, department]) => key === (current.departmentId ?? '') || department.id === (current.departmentId ?? ''));
    const tag = departmentEntry
      ? Object.values(departmentEntry[1].tags).find((candidate) => candidate.id === action.value || candidate.id === action.value)
      : undefined;
    if (!tag || tag.id !== action.value) {
      throw new Error('Workflow tag is not configured for the ticket department. The remaining steps were not run.');
    }
    if (current.tagId === tag.id) return;
    await updatePersistedTicketMetadata(current.channelId, { tagId: tag.id }, ACTOR(actorId));
    return;
  }

  if (action.type === 'send_quick_reply') {
    const marker = step.marker;
    if (!marker) throw new Error('Workflow send step has no durable retry marker.');
    const stepStart = iso(step.started_at) ?? new Date(0).toISOString();
    const recovered = await findMarkerInHistory(channel, marker, new Date(stepStart));
    if (recovered) {
      await pool.query(
        "UPDATE workflow_execution_steps SET status='completed',destination_message_id=$3,error_code=NULL,result=$4::jsonb,completed_at=NOW(),updated_at=NOW() WHERE run_id=$1 AND step_index=$2",
        [run.id,step.step_index,recovered,JSON.stringify({ reconciledByMarker:true })],
      );
      return;
    }

    const reply = await getQuickReply(guild.id, action.value, { isAdmin:true, roleIds:[] });
    if (!reply || !reply.enabled) throw new Error('Workflow quick reply is missing or disabled. Review this workflow before retrying.');
    const owner = current.ownerId ? await guild.members.fetch(current.ownerId).catch(() => null) : null;
    const staff = await guild.members.fetch(actorId).catch(() => null);
    const departmentEntry = Object.entries(config.departments).find(([key, department]) => key === (current.departmentId ?? '') || department.id === (current.departmentId ?? ''));
    const rendered = renderQuickReply(reply, {
      user: owner?.displayName ?? 'customer',
      username: owner?.user.username ?? 'customer',
      ticketId: current.id,
      ticketNumber: current.ticketNumber ?? current.id.slice(0, 8),
      department: departmentEntry?.[1].name ?? 'Support',
      priority: current.priority ?? 'normal',
      staff: staff?.displayName ?? 'Support staff',
    });
    await channel.send({
      content: rendered.slice(0, 1800) + marker,
      allowedMentions: { parse:[] },
    });
    return;
  }
}

async function ensureSteps(run: WorkflowRunRow): Promise<void> {
  const definition = validateWorkflowTemplateDefinition(run.definition);
  const pool = getPostgresPool();
  for (let index=0; index<definition.actions.length; index+=1) {
    const action = definition.actions[index]!;
    const marker = recoverySegmentMarker(run.id,run.ticket_id,'workflow-step:'+index);
    await pool.query(
      'INSERT INTO workflow_execution_steps (id,guild_id,run_id,step_index,action_type,action_value,status,attempts,marker,created_at,updated_at) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,'pending',0,$7,NOW(),NOW()) ON CONFLICT (run_id,step_index) DO NOTHING",
      [randomUUID(),run.guild_id,run.id,index,action.type,action.value,marker],
    );
  }
}

async function resumeRunUnlocked(
  guild: Guild,
  channel: TextChannel | ThreadChannel,
  run: WorkflowRunRow,
  actorId: string,
): Promise<WorkflowExecutionDetails> {
  if (run.guild_id !== guild.id || run.channel_id !== channel.id) {
    throw new Error('This workflow run belongs to a different server or ticket channel.');
  }
  if (['completed','not_matched'].includes(run.status)) return readDetails(run);
  await ensureSteps(run);
  const definition = validateWorkflowTemplateDefinition(run.definition);
  const pool = getPostgresPool();
  try {
    for (let index=0; index<definition.actions.length; index+=1) {
      const stepResult = await pool.query<WorkflowStepRow>(
        'SELECT id,run_id,step_index,action_type,action_value,status,attempts,marker,destination_message_id,result,error_code,started_at,completed_at ' +
          'FROM workflow_execution_steps WHERE run_id=$1 AND step_index=$2 LIMIT 1',
        [run.id,index],
      );
      const step = stepResult.rows[0];
      if (!step) throw new Error('Workflow step intent is missing from PostgreSQL.');
      if (step.status === 'completed') continue;

      await pool.query(
        "UPDATE workflow_execution_steps SET status='running',attempts=attempts+1,started_at=COALESCE(started_at,NOW()),error_code=NULL,updated_at=NOW() WHERE run_id=$1 AND step_index=$2",
        [run.id,index],
      );
      const runningStep = { ...step, status:'running' as const, attempts:Number(step.attempts)+1, started_at:step.started_at ?? new Date() };
      try {
        const ticket = await getPersistedTicket(channel.id);
        if (!ticket) throw new Error('Ticket record is no longer available.');
        await executeAction(guild,channel,run,runningStep,ticket,actorId);
        const refreshedStep = await pool.query<WorkflowStepRow>(
          'SELECT id,run_id,step_index,action_type,action_value,status,attempts,marker,destination_message_id,result,error_code,started_at,completed_at ' +
            'FROM workflow_execution_steps WHERE run_id=$1 AND step_index=$2 LIMIT 1',
          [run.id,index],
        );
        if (refreshedStep.rows[0]?.status !== 'completed') {
          await pool.query(
            "UPDATE workflow_execution_steps SET status='completed',result='{}'::jsonb,error_code=NULL,completed_at=NOW(),updated_at=NOW() WHERE run_id=$1 AND step_index=$2",
            [run.id,index],
          );
        }
        await pool.query(
          'UPDATE workflow_execution_runs SET current_step_index=$3,updated_at=NOW() WHERE guild_id=$1 AND id=$2',
          [guild.id,run.id,index],
        );
      } catch (error) {
        const needsReview = step.action_type === 'send_quick_reply';
        await saveStepFailure(runningStep,needsReview ? 'needs_review' : 'failed',error).catch(() => undefined);
        const updated = await finishRun(guild.id,run.id,needsReview ? 'needs_review' : 'failed',{ failedStep:index, errorCode:error instanceof Error ? error.name : 'UnknownError' });
        throw new WorkflowExecutionFailure(await readDetails(updated),error);
      }
    }

    const completed = await finishRun(guild.id, run.id, 'completed', {
      stepCount: definition.actions.length,
      completedBy: actorId,
    });
    try {
      const config = await getGuildConfig(guild.id);
      if (config.supportCategoryId) {
        const ticket = await getPersistedTicket(channel.id);
        const actor = await guild.members.fetch(actorId).catch(() => null);
        await logTicketEvent(guild, config.supportCategoryId, {
          ticketNumber: ticket?.ticketNumber ?? run.ticket_id,
          ticketChannelId: channel.id,
          event: 'WORKFLOW_MANUALLY_EXECUTED',
          actorId,
          actor: actor?.user.tag ?? actorId,
          actorName: actorId,
          detail: 'Ran workflow template ' + run.template_id + ' version ' + run.template_version +
            '; completed ' + definition.actions.length + ' allowlisted step(s).',
        });
      }
    } catch {
      // The PostgreSQL run/step ledger is authoritative. A failed channel notification
      // must not turn actions that already completed into a retryable failed run.
      console.warn('[workflow-execution] Workflow completed but audit-channel notification failed.', {
        guildId: guild.id,
        runId: run.id,
      });
      await pool.query(
        "UPDATE workflow_execution_runs SET result = result || $3::jsonb, updated_at=NOW() WHERE guild_id=$1 AND id=$2 AND status='completed'",
        [guild.id, run.id, JSON.stringify({ auditChannelNotificationFailed: true })],
      ).catch(() => undefined);
    }
    return readDetails(completed);
  } catch (error) {
    if (error instanceof WorkflowExecutionFailure) throw error;
    const updated=await finishRun(guild.id,run.id,'failed',{errorCode:error instanceof Error?error.name:'UnknownError'}).catch(()=>run);
    throw new WorkflowExecutionFailure(await readDetails(updated),error);
  }
}

export class WorkflowExecutionFailure extends Error {
  public readonly details: WorkflowExecutionDetails;
  public constructor(details: WorkflowExecutionDetails,cause: unknown) {
    super('Workflow execution stopped at a failed step. Review the saved execution record before resuming.',{cause});
    this.name='WorkflowExecutionFailure';
    this.details=details;
  }
}

export async function runWorkflowForTicket(args:{
  guild: Guild;
  channel: TextChannel|ThreadChannel;
  ticketId:string;
  templateId:string;
  actorId:string;
  interactionId:string;
  confirmation:boolean;
}):Promise<WorkflowExecutionDetails>{
  if(!args.confirmation) throw new Error('Explicit confirmation is required. No workflow action was executed.');
  const {guild,channel}=args;
  const lockKey='workflow-execution:'+guild.id+':'+args.ticketId;
  return withPostgresAdvisoryLock(lockKey,'Another workflow run is already active for this ticket. Review its run record before retrying.',async()=>{
    const ticket=await getPersistedTicket(channel.id);
    if(!ticket||ticket.guildId!==guild.id||ticket.id!==args.ticketId||ticket.deletedAt||!['open','claimed','pending','reopened'].includes(ticket.status)) {
      throw new Error('Workflow execution requires the same active managed ticket channel.');
    }
    const pool=getPostgresPool();
    const existing=await pool.query<WorkflowRunRow>(
      'SELECT id,guild_id,ticket_id,channel_id,template_id,template_version,template_name,requested_by,interaction_id,status,definition,condition_evaluation,current_step_index,result,started_at,finished_at,created_at,updated_at '+
      'FROM workflow_execution_runs WHERE guild_id=$1 AND interaction_id=$2 LIMIT 1',
      [guild.id,args.interactionId],
    );
    let run=existing.rows[0];
    if(!run) {
      const template=await getWorkflowTemplateById(guild.id,args.templateId);
      if(!template||!template.enabled) throw new Error('Workflow template was not found or is disabled. Enable it and verify its current revision first.');
      const definition=validateWorkflowTemplateDefinition(template.definition);
      const evaluated=evaluateWorkflowConditions(definition,{status:ticket.status,priority:ticket.priority,departmentId:ticket.departmentId});
      run=await ensureRun(guild.id,ticket,template.id,template.name,template.version,args.actorId,args.interactionId,definition,evaluated);
      if(!evaluated.matches) {
        const finished=await finishRun(guild.id,run.id,'not_matched',{conditionEvaluation:evaluated.conditions});
        return readDetails(finished);
      }
      await pool.query(
        'UPDATE workflow_execution_runs SET condition_evaluation=$3::jsonb,updated_at=NOW() WHERE guild_id=$1 AND id=$2',
        [guild.id,run.id,JSON.stringify(evaluated)],
      );
      run=(await getRunById(guild.id,run.id))!;
    }
    if(run.status==='completed'||run.status==='not_matched') return readDetails(run);
    return resumeRunUnlocked(guild,channel,run,args.actorId);
  });
}

export async function resumeWorkflowRun(args:{
  guild:Guild;
  channel:TextChannel|ThreadChannel;
  ticketId:string;
  runId:string;
  actorId:string;
  confirmation:boolean;
}):Promise<WorkflowExecutionDetails>{
  if(!args.confirmation) throw new Error('Explicit confirmation is required. No workflow action was executed.');
  return withPostgresAdvisoryLock('workflow-execution:'+args.guild.id+':'+args.ticketId,'Another workflow run is active for this ticket.',async()=>{
    const run=await getRunById(args.guild.id,args.runId);
    if(!run) throw new Error('Workflow run was not found in this server.');
    if(run.ticket_id!==args.ticketId||run.channel_id!==args.channel.id||args.guild.id!==run.guild_id) {
      throw new Error('Resume this workflow only from the same active ticket and server.');
    }
    if(!['failed','needs_review','running'].includes(run.status)) {
      throw new Error('Only failed, needs-review or interrupted workflow runs can be resumed.');
    }
    const ticket=await getPersistedTicket(args.channel.id);
    if(!ticket||ticket.deletedAt||!['open','claimed','pending','reopened'].includes(ticket.status)) {
      throw new Error('Workflow resume requires an active managed ticket channel.');
    }
    return resumeRunUnlocked(args.guild,args.channel,run,args.actorId);
  });
}

export async function listWorkflowRunsForTicket(guildId:string,ticketId:string,limit=10):Promise<WorkflowExecutionSummary[]>{
  const bounded=Math.max(1,Math.min(25,Math.floor(limit)));
  const result=await getPostgresPool().query<WorkflowRunRow>(
    'SELECT id,guild_id,ticket_id,channel_id,template_id,template_version,template_name,requested_by,interaction_id,status,definition,condition_evaluation,current_step_index,result,started_at,finished_at,created_at,updated_at '+
    'FROM workflow_execution_runs WHERE guild_id=$1 AND ticket_id=$2 ORDER BY created_at DESC LIMIT $3',
    [guildId,ticketId,bounded],
  );
  return Promise.all(result.rows.map(async row=>summaryFromRow(row,await getSteps(row.id).then(steps=>steps.length))));
}

export async function getWorkflowRunDetails(guildId:string,ticketId:string,runId:string):Promise<WorkflowExecutionDetails>{
  const run=await getRunById(guildId,runId);
  if(!run||run.ticket_id!==ticketId) throw new Error('Workflow run was not found for this ticket.');
  return readDetails(run);
}
