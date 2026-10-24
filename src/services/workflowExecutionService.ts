import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { TextChannel, ThreadChannel } from 'discord.js';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { recoverySegmentMarker } from '../core/domain/recoveryReplayMarkers';
import { evaluateWorkflowConditions, validateWorkflowTemplateDefinition, type WorkflowAction, type WorkflowTemplateDefinition } from '../core/domain/workflowSafety';
import { getGuildConfig } from './configService';
import { getPersistedTicket, updatePersistedTicketMetadata } from './ticketPersistenceService';
import { getQuickReply, listQuickReplies, renderQuickReply } from './quickReplyService';
import type { TicketPriority } from './advancedSettingsService';

type TicketChannel = TextChannel | ThreadChannel;
type RunStatus = 'running' | 'completed' | 'failed' | 'needs_review' | 'not_matched';
type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'needs_review';
type ResolveDecision = 'complete' | 'retry';

interface RunRow extends QueryResultRow {
  id: string; guild_id: string; ticket_id: string; channel_id: string; template_id: string;
  template_version: number; template_name: string; requested_by: string; interaction_id: string;
  status: RunStatus; definition: unknown; condition_evaluation: unknown; current_step_index: number | null;
  result: unknown; started_at: Date | string; finished_at: Date | string | null;
  created_at: Date | string; updated_at: Date | string;
}
interface StepRow extends QueryResultRow {
  id: string; guild_id: string; run_id: string; step_index: number;
  action_type: WorkflowAction['type']; action_value: string; status: StepStatus; attempts: number;
  marker: string | null; destination_message_id: string | null; result: unknown; error_code: string | null;
  started_at: Date | string | null; completed_at: Date | string | null;
}

export interface WorkflowExecutionStepSummary {
  index: number; actionType: WorkflowAction['type']; status: StepStatus; attempts: number;
  errorCode: string | null; destinationMessageId: string | null; result: Record<string, unknown>;
}
export interface WorkflowExecutionSummary {
  id: string; guildId: string; ticketId: string; channelId: string; templateId: string;
  templateVersion: number; templateName: string; requestedBy: string; status: RunStatus;
  currentStepIndex: number | null; conditionEvaluation: Record<string, unknown>;
  result: Record<string, unknown>; createdAt: string; updatedAt: string; finishedAt: string | null;
  steps: WorkflowExecutionStepSummary[];
}

function asIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { /* fail closed */ }
  }
  return {};
}
function fromStep(row: StepRow): WorkflowExecutionStepSummary {
  return { index:Number(row.step_index), actionType:row.action_type, status:row.status, attempts:Number(row.attempts),
    errorCode:row.error_code, destinationMessageId:row.destination_message_id, result:jsonObject(row.result) };
}
function fromRun(row: RunRow, steps: WorkflowExecutionStepSummary[] = []): WorkflowExecutionSummary {
  return { id:row.id, guildId:row.guild_id, ticketId:row.ticket_id, channelId:row.channel_id,
    templateId:row.template_id, templateVersion:Number(row.template_version), templateName:row.template_name,
    requestedBy:row.requested_by, status:row.status, currentStepIndex:row.current_step_index,
    conditionEvaluation:jsonObject(row.condition_evaluation), result:jsonObject(row.result),
    createdAt:asIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt:asIso(row.updated_at) ?? new Date(0).toISOString(), finishedAt:asIso(row.finished_at), steps };
}
async function fetchRun(client: PoolClient, guildId: string, runId: string): Promise<RunRow> {
  const result = await client.query<RunRow>('SELECT * FROM workflow_execution_runs WHERE guild_id=$1 AND id=$2 LIMIT 1',[guildId,runId]);
  if (!result.rows[0]) throw new Error('Workflow run was not found in this server.');
  return result.rows[0];
}
async function fetchSteps(client: PoolClient, runId: string): Promise<StepRow[]> {
  return (await client.query<StepRow>('SELECT * FROM workflow_execution_steps WHERE run_id=$1 ORDER BY step_index',[runId])).rows;
}
async function summaryWithClient(client: PoolClient, guildId: string, runId: string): Promise<WorkflowExecutionSummary> {
  const run=await fetchRun(client,guildId,runId);
  return fromRun(run,(await fetchSteps(client,runId)).map(fromStep));
}
async function withTicketLock<T>(client: PoolClient,guildId:string,ticketId:string,action:()=>Promise<T>):Promise<T>{
  const result=await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked',[guildId,ticketId]);
  if(!result.rows[0]?.locked) throw new Error('Another workflow operation is active for this ticket. Inspect the existing run instead of starting a duplicate.');
  try{return await action();}finally{await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',[guildId,ticketId]).catch(()=>undefined);}
}
async function getActiveTicket(channelId:string,guildId:string){
  const ticket=await getPersistedTicket(channelId);
  if(!ticket||ticket.guildId!==guildId||ticket.deletedAt)throw new Error('Workflow execution requires a durable ticket record in this server.');
  if(!['open','claimed','pending','reopened'].includes(ticket.status))throw new Error('Workflow execution is limited to active tickets.');
  return ticket;
}
async function validateActionReferences(guildId:string,definition:WorkflowTemplateDefinition):Promise<void>{
  const config=await getGuildConfig(guildId);
  const departments=new Map(Object.entries(config.departments).flatMap(([key,department])=>[[key,department],[department.id,department]]));
  const replies=await listQuickReplies(guildId,{isAdmin:true,roleIds:[]});
  const replyMap=new Map(replies.map(reply=>[reply.id,reply]));
  for(const condition of definition.conditions)if(condition.field==='departmentId'&&!departments.has(condition.equals))throw new Error('A workflow condition references a department that no longer exists. No actions were executed.');
  for(const action of definition.actions){
    if(action.type==='assign_department'&&!departments.has(action.value))throw new Error('A workflow references a department that no longer exists. No actions were executed.');
    if(action.type==='add_tag'&&!Object.values(config.departments).some(dept=>Object.entries(dept.tags).some(([key,tag])=>key===action.value||tag.id===action.value)))throw new Error('A workflow references a tag that no longer exists. No actions were executed.');
    if(action.type==='send_quick_reply'&&!replyMap.get(action.value)?.enabled)throw new Error('A workflow references a disabled or unavailable quick reply. No actions were executed.');
  }
}
function findTagId(department:{tags:Record<string,{id:string}>},value:string):string|null{
  return Object.entries(department.tags).find(([key,tag])=>key===value||tag.id===value)?.[1].id??null;
}

interface WorkflowMutationSnapshot {
  before: Record<string, string | null>;
  target: Record<string, string | null>;
}

function currentMutationState(
  ticket: NonNullable<Awaited<ReturnType<typeof getPersistedTicket>>>,
  config: Awaited<ReturnType<typeof getGuildConfig>>,
  action: WorkflowAction,
): Record<string, string | null> {
  const metadata = jsonObject(ticket.metadata);
  const currentDepartment = ticket.departmentId
    ? config.departments[ticket.departmentId] ?? Object.values(config.departments).find((department) => department.id === ticket.departmentId)
    : undefined;
  if (action.type === 'set_priority') return { priority: ticket.priority };
  if (action.type === 'add_tag') return { departmentId: currentDepartment?.id ?? ticket.departmentId, tagId: ticket.tagId };
  return {
    departmentId: currentDepartment?.id ?? ticket.departmentId,
    tagId: ticket.tagId,
    staffRoleId: typeof metadata.staffRoleId === 'string' ? metadata.staffRoleId : null,
  };
}

async function captureMutationSnapshot(
  guildId: string,
  channelId: string,
  action: WorkflowAction,
): Promise<WorkflowMutationSnapshot> {
  const ticket = await getActiveTicket(channelId, guildId);
  const config = await getGuildConfig(guildId);
  const before = currentMutationState(ticket, config, action);

  if (action.type === 'set_priority') {
    return { before, target: { priority: action.value } };
  }

  if (action.type === 'add_tag') {
    const currentDepartment = ticket.departmentId
      ? config.departments[ticket.departmentId] ?? Object.values(config.departments).find((department) => department.id === ticket.departmentId)
      : undefined;
    if (!currentDepartment) throw new Error('The current ticket department no longer exists.');
    const targetTagId = findTagId(currentDepartment, action.value);
    if (!targetTagId) throw new Error('The workflow target tag no longer exists in the current department.');
    return { before, target: { departmentId: currentDepartment.id, tagId: targetTagId } };
  }

  const targetDepartment = config.departments[action.value] ??
    Object.values(config.departments).find((department) => department.id === action.value);
  if (!targetDepartment) throw new Error('The workflow target department no longer exists.');
  const currentDepartment = ticket.departmentId
    ? config.departments[ticket.departmentId] ?? Object.values(config.departments).find((department) => department.id === ticket.departmentId)
    : undefined;
  const currentTagValid = Boolean(
    currentDepartment?.id === targetDepartment.id &&
    ticket.tagId &&
    Object.values(targetDepartment.tags).some((tag) => tag.id === ticket.tagId),
  );
  const targetTagId = currentTagValid ? ticket.tagId! : Object.values(targetDepartment.tags)[0]?.id;
  if (!targetTagId) throw new Error('The workflow target department has no configured tags.');
  return {
    before,
    target: {
      departmentId: targetDepartment.id,
      tagId: targetTagId,
      staffRoleId: targetDepartment.staffRoleId ?? 'none',
    },
  };
}

function parseMutationSnapshot(value: unknown): WorkflowMutationSnapshot | null {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!raw || !raw.before || !raw.target ||
      typeof raw.before !== 'object' || Array.isArray(raw.before) ||
      typeof raw.target !== 'object' || Array.isArray(raw.target)) return null;
  const validState = (state: unknown): state is Record<string, string | null> =>
    Boolean(state && typeof state === 'object' && !Array.isArray(state) &&
      Object.values(state as Record<string, unknown>).every((item) => item === null || typeof item === 'string'));
  if (!validState(raw.before) || !validState(raw.target)) return null;
  return { before: raw.before, target: raw.target };
}

function mutationStateMatches(
  actual: Record<string, string | null>,
  expected: Record<string, string | null>,
): boolean {
  return Object.keys(actual).length === Object.keys(expected).length &&
    Object.keys(expected).every((key) => actual[key] === expected[key]);
}
async function markStep(client:PoolClient,step:StepRow,status:StepStatus,opts:{
  result?:Record<string,unknown>; destinationMessageId?:string|null; errorCode?:string|null; startAttempt?:boolean; completed?:boolean;
}={}):Promise<void>{
  await client.query(
    'UPDATE workflow_execution_steps SET status=$3,attempts=attempts+CASE WHEN $4::boolean THEN 1 ELSE 0 END,'+
    'started_at=CASE WHEN $4::boolean THEN COALESCE(started_at,NOW()) ELSE started_at END,'+
    'completed_at=CASE WHEN $5::boolean THEN NOW() ELSE NULL END,'+
    'destination_message_id=COALESCE($6,destination_message_id),result=result || $7::jsonb,error_code=$8,updated_at=NOW() WHERE id=$1 AND run_id=$2',
    [step.id,step.run_id,status,opts.startAttempt??false,opts.completed??false,opts.destinationMessageId??null,JSON.stringify(opts.result??{}),opts.errorCode??null],
  );
}
async function setRunStatus(client:PoolClient,runId:string,status:RunStatus,currentStep:number|null,result:Record<string,unknown>={}):Promise<void>{
  await client.query(
    'UPDATE workflow_execution_runs SET status=$2,current_step_index=$3,result=result || $4::jsonb,'+
    'finished_at=CASE WHEN $2 IN (\'completed\',\'failed\',\'not_matched\') THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$1',
    [runId,status,currentStep,JSON.stringify(result)],
  );
}
function workflowDeliveryMarker(runId: string, stepIndex: number): string {
  return recoverySegmentMarker(runId, 'workflow-step-' + stepIndex, 'quick-reply-delivery');
}

async function findDeliveryMarker(channel:TicketChannel,marker:string,startedAt:Date|string|null):Promise<{messageId:string|null;historyCovered:boolean}>{
  if (!marker) return { messageId: null, historyCovered: false };
  const startMs=startedAt===null?Date.now():new Date(startedAt).getTime();
  let before:string|undefined;
  for(let index=0;index<25;index+=1){
    const page=await channel.messages.fetch({limit:100,...(before?{before}:{})});
    const messages=[...page.values()];
    const match=messages.find(message=>message.content.includes(marker));
    if(match)return {messageId:match.id,historyCovered:true};
    if(!messages.length||messages.length<100)return {messageId:null,historyCovered:true};
    const oldest=messages.reduce((a,b)=>a.createdTimestamp<=b.createdTimestamp?a:b);
    if(oldest.createdTimestamp<=startMs)return {messageId:null,historyCovered:true};
    before=oldest.id;
  }
  return {messageId:null,historyCovered:false};
}
async function applyMutation(guildId:string,channelId:string,actorId:string,action:WorkflowAction):Promise<Record<string,unknown>>{
  const ticket=await getActiveTicket(channelId,guildId);
  const config=await getGuildConfig(guildId);
  const actor={id:actorId,attribution:'actorKnown' as const,confidence:'high' as const};
  const now=new Date().toISOString();
  if(action.type==='set_priority'){
    if(ticket.priority===action.value)return {alreadyApplied:true,priority:action.value};
    await updatePersistedTicketMetadata(channelId,{priority:action.value as TicketPriority,metadata:{lastActivityAt:now,lastStaffActivityAt:now}},actor);
    return {priority:action.value};
  }
  if(action.type==='assign_department'){
    const dept=config.departments[action.value]??Object.values(config.departments).find(item=>item.id===action.value);
    if(!dept)throw new Error('The target department no longer exists.');
    const currentDept=ticket.departmentId?(config.departments[ticket.departmentId]??Object.values(config.departments).find(item=>item.id===ticket.departmentId)):undefined;
    const currentTagValid=Boolean(currentDept?.id===dept.id&&ticket.tagId&&Object.values(dept.tags).some(tag=>tag.id===ticket.tagId));
    const tagId=currentTagValid?ticket.tagId!:Object.values(dept.tags)[0]?.id;
    if(!tagId)throw new Error('The target department has no configured tags; workflow assignment was not applied.');
    const staffRoleId=dept.staffRoleId??'none';
    if(ticket.departmentId===dept.id&&ticket.tagId===tagId&&jsonObject(ticket.metadata).staffRoleId===staffRoleId)return {alreadyApplied:true,departmentId:dept.id,tagId};
    await updatePersistedTicketMetadata(channelId,{departmentId:dept.id,tagId,metadata:{staffRoleId,lastActivityAt:now,lastStaffActivityAt:now}},actor);
    return {departmentId:dept.id,tagId};
  }
  if(action.type==='add_tag'){
    if(!ticket.departmentId)throw new Error('The current ticket has no department; the tag action was not applied.');
    const dept=config.departments[ticket.departmentId]??Object.values(config.departments).find(item=>item.id===ticket.departmentId);
    if(!dept)throw new Error('The current ticket department no longer exists.');
    const tagId=findTagId(dept,action.value);
    if(!tagId)throw new Error('Cross-department tag changes are blocked; choose a tag in the current department.');
    if(ticket.tagId===tagId)return {alreadyApplied:true,tagId};
    await updatePersistedTicketMetadata(channelId,{tagId,metadata:{lastActivityAt:now,lastStaffActivityAt:now}},actor);
    return {tagId};
  }
  throw new Error('This workflow action requires the message delivery path.');
}
async function sendQuickReply(guildId:string,channel:TicketChannel,actorName:string,run:RunRow,step:StepRow):Promise<string>{
  const ticket=await getActiveTicket(channel.id,guildId);
  const config=await getGuildConfig(guildId);
  const reply=await getQuickReply(guildId,step.action_value,{isAdmin:true,roleIds:[]});
  if(!reply?.enabled)throw new Error('The configured quick reply is disabled or unavailable.');
  const department=ticket.departmentId?(config.departments[ticket.departmentId]??Object.values(config.departments).find(item=>item.id===ticket.departmentId)):undefined;
  const content=renderQuickReply(reply,{
    user:ticket.ownerId?'<@'+ticket.ownerId+'>':'customer',
    username:ticket.ownerId??'customer',
    ticketId:ticket.id,
    ticketNumber:ticket.ticketNumber??ticket.id.slice(0,8),
    department:department?.name??'Support',
    priority:ticket.priority??'normal',
    staff:actorName,
  });
  const marker=step.marker??workflowDeliveryMarker(run.id,step.step_index);
  const message=await channel.send({content:content+'\n'+marker,allowedMentions:{parse:[]}});
  return message.id;
}
async function executeSteps(client:PoolClient,guildId:string,channel:TicketChannel,actorId:string,actorName:string,runId:string):Promise<WorkflowExecutionSummary>{
  const run=await fetchRun(client,guildId,runId);
  const definition=validateWorkflowTemplateDefinition(run.definition);
  const initialSteps=await fetchSteps(client,runId);
  if(run.status==='completed'||run.status==='not_matched')return summaryWithClient(client,guildId,runId);
  await client.query("UPDATE workflow_execution_runs SET status='running',finished_at=NULL,updated_at=NOW() WHERE id=$1",[runId]);
  for(const initial of initialSteps){
    let step=(await client.query<StepRow>('SELECT * FROM workflow_execution_steps WHERE id=$1 LIMIT 1',[initial.id])).rows[0]??initial;
    if(step.status==='completed')continue;
    if(step.status==='needs_review'){
      if(step.action_type!=='send_quick_reply'){
        await setRunStatus(client,runId,'needs_review',step.step_index,{stopReason:'manual_review_required'});
        return summaryWithClient(client,guildId,runId);
      }
      try{
        const delivery=await findDeliveryMarker(channel,step.marker??'',step.started_at);
        if(delivery.messageId){
          await markStep(client,step,'completed',{destinationMessageId:delivery.messageId,result:{recoveredByMarker:true},completed:true});
          continue;
        }
        if(!delivery.historyCovered){
          await setRunStatus(client,runId,'needs_review',step.step_index,{stopReason:'send_history_incomplete'});
          return summaryWithClient(client,guildId,runId);
        }
        // History fully covers the send window and no marker exists, so retry is safe.
        await markStep(client,step,'pending',{result:{historyVerifiedNoDelivery:true},errorCode:null});
        step=(await client.query<StepRow>('SELECT * FROM workflow_execution_steps WHERE id=$1 LIMIT 1',[step.id])).rows[0]??step;
      }catch{
        await setRunStatus(client,runId,'needs_review',step.step_index,{stopReason:'send_history_unavailable'});
        return summaryWithClient(client,guildId,runId);
      }
    }else if(step.status==='running'||step.status==='failed'){
      if(step.action_type==='send_quick_reply'){
        try{
          const delivery=await findDeliveryMarker(channel,step.marker??'',step.started_at);
          if(delivery.messageId){
            await markStep(client,step,'completed',{destinationMessageId:delivery.messageId,result:{recoveredByMarker:true},completed:true});
            continue;
          }
          if(!delivery.historyCovered){
            await markStep(client,step,'needs_review',{errorCode:'delivery_ambiguous_history_incomplete',result:{manualReviewRequired:true}});
            await setRunStatus(client,runId,'needs_review',step.step_index,{stopReason:'send_history_incomplete'});
            return summaryWithClient(client,guildId,runId);
          }
        }catch{
          await markStep(client,step,'needs_review',{errorCode:'delivery_history_unavailable',result:{manualReviewRequired:true}});
          await setRunStatus(client,runId,'needs_review',step.step_index,{stopReason:'send_history_unavailable'});
          return summaryWithClient(client,guildId,runId);
        }
      }else{
        const action = definition.actions[step.step_index];
        const persistedResult = jsonObject(step.result);
        const snapshot = parseMutationSnapshot(persistedResult.mutationSnapshot);
        if (!action || action.type === 'send_quick_reply' || !snapshot) {
          await markStep(client,step,'needs_review',{
            errorCode:'mutation_recovery_snapshot_missing',
            result:{manualReviewRequired:true,reason:'The pre-action state was not recorded; automatic retry is unsafe.'},
          });
          await setRunStatus(client,runId,'needs_review',step.step_index,{stopReason:'mutation_recovery_snapshot_missing'});
          return summaryWithClient(client,guildId,runId);
        }
        const ticket = await getActiveTicket(channel.id,guildId);
        const config = await getGuildConfig(guildId);
        const current = currentMutationState(ticket,config,action);
        if (mutationStateMatches(current,snapshot.target)) {
          await markStep(client,step,'completed',{result:{recoveredByTargetState:true},completed:true});
          continue;
        }
        if (!mutationStateMatches(current,snapshot.before)) {
          await markStep(client,step,'needs_review',{
            errorCode:'mutation_state_diverged',
            result:{manualReviewRequired:true,reason:'The ticket changed after this step began. No overwrite was attempted.'},
          });
          await setRunStatus(client,runId,'needs_review',step.step_index,{stopReason:'mutation_state_diverged'});
          return summaryWithClient(client,guildId,runId);
        }
        // The ticket still matches the recorded pre-action state, so retrying this mutation is safe.
      }
    }
    const action=definition.actions[step.step_index];
    if(!action){
      await markStep(client,step,'failed',{errorCode:'stored_action_missing',result:{manualReviewRequired:true}});
      await setRunStatus(client,runId,'failed',step.step_index,{stopReason:'stored_action_missing'});
      return summaryWithClient(client,guildId,runId);
    }
    let startResult:Record<string,unknown>={};
    if(step.status==='pending'&&action.type!=='send_quick_reply'){
      try{
        startResult={mutationSnapshot:await captureMutationSnapshot(guildId,channel.id,action)};
      }catch{
        await markStep(client,step,'failed',{errorCode:'mutation_preflight_failed',result:{manualReviewRequired:true}});
        await setRunStatus(client,runId,'failed',step.step_index,{stopReason:'mutation_preflight_failed'});
        return summaryWithClient(client,guildId,runId);
      }
    }
    step=(await client.query<StepRow>(
      "UPDATE workflow_execution_steps SET status='running',attempts=attempts+1,started_at=COALESCE(started_at,NOW()),error_code=NULL,result=result || $2::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *",
      [step.id,JSON.stringify(startResult)],
    )).rows[0]??step;
    await client.query('UPDATE workflow_execution_runs SET current_step_index=$2,updated_at=NOW() WHERE id=$1',[runId,step.step_index]);
    try{
      if(action.type==='send_quick_reply'){
        const messageId=await sendQuickReply(guildId,channel,actorName,run,step);
        await markStep(client,step,'completed',{destinationMessageId:messageId,result:{destinationMessageId:messageId},completed:true});
      }else{
        const result=await applyMutation(guildId,channel.id,actorId,action);
        await markStep(client,step,'completed',{result,completed:true});
      }
    }catch(error){
      const isSend=step.action_type==='send_quick_reply';
      await markStep(client,step,isSend?'needs_review':'failed',{
        errorCode:isSend?'delivery_ambiguous_or_failed':'action_failed',
        result:{manualReviewRequired:isSend},
      });
      await setRunStatus(client,runId,isSend?'needs_review':'failed',step.step_index,{stopReason:isSend?'send_requires_review':'action_failed'});
      return summaryWithClient(client,guildId,runId);
    }
  }
  await setRunStatus(client,runId,'completed',null,{completedSteps:initialSteps.length});
  return summaryWithClient(client,guildId,runId);
}

/** Start a manual, admin-authorized run. No event or background worker invokes this service. */
export async function executeWorkflowTemplateForTicket(input:{
  guildId:string;channel:TicketChannel;actorId:string;actorName:string;interactionId:string;
  templateId:string;expectedVersion:number;confirmation:string;
}):Promise<WorkflowExecutionSummary>{
  const {guildId,channel,actorId,actorName,interactionId,templateId,expectedVersion,confirmation}=input;
  const ticket=await getActiveTicket(channel.id,guildId);
  const client=await getPostgresPool().connect();
  try{return await withTicketLock(client,guildId,ticket.id,async()=>{
    const existing=(await client.query<RunRow>('SELECT * FROM workflow_execution_runs WHERE guild_id=$1 AND interaction_id=$2 LIMIT 1',[guildId,interactionId])).rows[0];
    if(existing)return summaryWithClient(client,guildId,existing.id);
    const found=await client.query<QueryResultRow&{id:string;name:string;definition:unknown;version:number;enabled:boolean}>(
      'SELECT id,name,definition,version,enabled FROM workflow_templates WHERE guild_id=$1 AND id=$2 AND deleted_at IS NULL LIMIT 1',[guildId,templateId]);
    const template=found.rows[0];
    if(!template)throw new Error('Workflow template was not found or has been deleted.');
    if(!template.enabled)throw new Error('Enable this template in the catalogue before manual execution.');
    if(Number(template.version)!==expectedVersion)throw new Error('Workflow template version changed. Refresh the list and retry with the current version.');
    if(confirmation!=='RUN '+templateId+' v'+expectedVersion)throw new Error('Type exactly: RUN '+templateId+' v'+expectedVersion);
    const definition=validateWorkflowTemplateDefinition(template.definition);
    await validateActionReferences(guildId,definition);
    const result=evaluateWorkflowConditions(definition,{status:ticket.status,priority:ticket.priority,departmentId:ticket.departmentId});
    const runId=randomUUID();
    const status:RunStatus=result.matches?'running':'not_matched';
    await client.query('BEGIN');
    try{
      await client.query(
        'INSERT INTO workflow_execution_runs (id,guild_id,ticket_id,channel_id,template_id,template_version,template_name,requested_by,interaction_id,status,definition,condition_evaluation,finished_at,result) '+
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,CASE WHEN $10=\'not_matched\' THEN NOW() ELSE NULL END,$13::jsonb)',
        [runId,guildId,ticket.id,channel.id,templateId,expectedVersion,template.name,actorId,interactionId,status,JSON.stringify(definition),JSON.stringify(result),JSON.stringify(result.matches?{}:{stopReason:'conditions_not_matched'})]);
      if(result.matches)for(let index=0;index<definition.actions.length;index+=1){
        const action=definition.actions[index]!;
        await client.query(
          'INSERT INTO workflow_execution_steps (id,guild_id,run_id,step_index,action_type,action_value,status,marker) VALUES ($1,$2,$3,$4,$5,$6,\'pending\',$7)',
          [randomUUID(),guildId,runId,index,action.type,action.value,workflowDeliveryMarker(runId,index)]);
      }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
    if(!result.matches)return summaryWithClient(client,guildId,runId);
    return executeSteps(client,guildId,channel,actorId,actorName,runId);
  });}finally{client.release();}
}

export async function resumeWorkflowExecutionForTicket(input:{
  guildId:string;channel:TicketChannel;actorId:string;actorName:string;runId:string;confirmation:string;
}):Promise<WorkflowExecutionSummary>{
  const {guildId,channel,actorId,actorName,runId,confirmation}=input;
  const ticket=await getActiveTicket(channel.id,guildId);
  if(confirmation!=='RESUME '+runId)throw new Error('Type exactly: RESUME '+runId);
  const client=await getPostgresPool().connect();
  try{return await withTicketLock(client,guildId,ticket.id,async()=>{
    const run=await fetchRun(client,guildId,runId);
    if(run.ticket_id!==ticket.id)throw new Error('This workflow run belongs to another ticket. Open the correct ticket before resuming.');
    if(run.status==='completed'||run.status==='not_matched')return summaryWithClient(client,guildId,runId);
    return executeSteps(client,guildId,channel,actorId,actorName,runId);
  });}finally{client.release();}
}

export async function resolveWorkflowExecutionStep(input:{
  guildId:string;channel:TicketChannel;actorId:string;runId:string;stepIndex:number;decision:ResolveDecision;confirmation:string;
}):Promise<WorkflowExecutionSummary>{
  const {guildId,channel,actorId,runId,stepIndex,decision,confirmation}=input;
  const ticket=await getActiveTicket(channel.id,guildId);
  const expected='RESOLVE '+runId+' STEP '+stepIndex+' '+decision.toUpperCase();
  if(confirmation!==expected)throw new Error('Type exactly: '+expected);
  const client=await getPostgresPool().connect();
  try{return await withTicketLock(client,guildId,ticket.id,async()=>{
    const run=await fetchRun(client,guildId,runId);
    if(run.ticket_id!==ticket.id)throw new Error('This workflow run belongs to another ticket.');
    const step=(await client.query<StepRow>('SELECT * FROM workflow_execution_steps WHERE run_id=$1 AND step_index=$2 LIMIT 1',[runId,stepIndex])).rows[0];
    if(!step||step.action_type!=='send_quick_reply'||step.status!=='needs_review')throw new Error('Only a send step awaiting manual review can be resolved this way.');
    if(decision==='complete'){
      await markStep(client,step,'completed',{result:{manualResolution:'complete',resolvedBy:actorId,warning:'Administrator confirmed the message was delivered.'},completed:true});
      await setRunStatus(client,runId,'running',stepIndex,{manualResolution:'complete'});
    }else{
      await markStep(client,step,'pending',{result:{manualResolution:'retry',duplicateRiskAcknowledged:true},errorCode:null});
      await setRunStatus(client,runId,'running',stepIndex,{manualResolution:'retry',duplicateRiskAcknowledged:true});
    }
    return summaryWithClient(client,guildId,runId);
  });}finally{client.release();}
}

export async function listWorkflowExecutionRunsForTicket(guildId:string,ticketId:string,limit=10):Promise<WorkflowExecutionSummary[]>{
  const safeLimit=Math.min(25,Math.max(1,Math.floor(limit)));
  const pool=getPostgresPool();
  const rows=(await pool.query<RunRow>('SELECT * FROM workflow_execution_runs WHERE guild_id=$1 AND ticket_id=$2 ORDER BY created_at DESC LIMIT $3',[guildId,ticketId,safeLimit])).rows;
  const result:WorkflowExecutionSummary[]=[];
  for(const row of rows){
    const steps=(await pool.query<StepRow>('SELECT * FROM workflow_execution_steps WHERE run_id=$1 ORDER BY step_index',[row.id])).rows;
    result.push(fromRun(row,steps.map(fromStep)));
  }
  return result;
}
