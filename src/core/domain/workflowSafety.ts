export type WorkflowConditionField = 'status' | 'priority' | 'departmentId';
export type WorkflowActionType = 'assign_department' | 'set_priority' | 'add_tag' | 'send_quick_reply';

export interface WorkflowCondition {
  field: WorkflowConditionField;
  equals: string;
}

export interface WorkflowAction {
  type: WorkflowActionType;
  value: string;
}

export interface WorkflowTemplateDefinition {
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
}

const ALLOWED_STATUSES = new Set(['open','claimed','pending','reopened','closed','archived']);
const ALLOWED_PRIORITIES = new Set(['low','normal','high','urgent','critical']);
const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export function validateWorkflowTemplateDefinition(value: unknown): WorkflowTemplateDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workflow definition must be an object with conditions and actions arrays.');
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'conditions' && key !== 'actions')) {
    throw new Error('Workflow definition contains unsupported keys.');
  }
  if (!Array.isArray(raw.conditions) || raw.conditions.length > 5) {
    throw new Error('Workflow needs a conditions array with at most five conditions.');
  }
  if (!Array.isArray(raw.actions) || raw.actions.length < 1 || raw.actions.length > 10) {
    throw new Error('Workflow needs 1–10 allowed actions.');
  }
  const conditions = raw.conditions.map((item, index): WorkflowCondition => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Condition ' + (index + 1) + ' is malformed.');
    }
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => key !== 'field' && key !== 'equals')) {
      throw new Error('Condition ' + (index + 1) + ' contains unsupported keys.');
    }
    if (!['status','priority','departmentId'].includes(String(row.field))) {
      throw new Error('Condition ' + (index + 1) + ' uses an unsupported field.');
    }
    if (typeof row.equals !== 'string' || !row.equals.trim() || row.equals.length > 80) {
      throw new Error('Condition ' + (index + 1) + ' needs a non-empty text value of at most 80 characters.');
    }
    const field = row.field as WorkflowConditionField;
    const expected = row.equals.trim();
    if (field === 'status' && !ALLOWED_STATUSES.has(expected)) {
      throw new Error('Condition ' + (index + 1) + ' has an unsupported ticket status.');
    }
    if (field === 'priority' && !ALLOWED_PRIORITIES.has(expected)) {
      throw new Error('Condition ' + (index + 1) + ' has an unsupported priority.');
    }
    if (field === 'departmentId' && !SAFE_ID.test(expected)) {
      throw new Error('Condition ' + (index + 1) + ' has an invalid department ID.');
    }
    return { field, equals: expected };
  });
  const actions = raw.actions.map((item, index): WorkflowAction => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Action ' + (index + 1) + ' is malformed.');
    }
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => key !== 'type' && key !== 'value')) {
      throw new Error('Action ' + (index + 1) + ' contains unsupported keys.');
    }
    if (!['assign_department','set_priority','add_tag','send_quick_reply'].includes(String(row.type))) {
      throw new Error('Action ' + (index + 1) + ' is not allowlisted. Arbitrary code and lifecycle bypasses are not supported.');
    }
    if (typeof row.value !== 'string' || !row.value.trim() || row.value.length > 80) {
      throw new Error('Action ' + (index + 1) + ' needs an identifier/value of at most 80 characters.');
    }
    const type = row.type as WorkflowActionType;
    const expected = row.value.trim();
    if (type === 'set_priority' && !ALLOWED_PRIORITIES.has(expected)) {
      throw new Error('Action ' + (index + 1) + ' has an unsupported priority.');
    }
    if ((type === 'assign_department' || type === 'add_tag' || type === 'send_quick_reply') && !SAFE_ID.test(expected)) {
      throw new Error('Action ' + (index + 1) + ' must reference a validated configured ID.');
    }
    return { type, value: expected };
  });
  return { conditions, actions };
}

export function previewWorkflowTemplate(definition: WorkflowTemplateDefinition): {
  executable: false;
  conditionCount: number;
  actionCount: number;
  warnings: string[];
} {
  return {
    executable: false,
    conditionCount: definition.conditions.length,
    actionCount: definition.actions.length,
    warnings: [
      'This template is stored and validated only; it cannot run until a separate authorized execution plan exists.',
      'Execution must use existing domain services, lifecycle transition guards, role checks and durable audit/outbox.',
      'Send actions must suppress unsolicited mentions and must not evaluate raw code or SQL.',
    ],
  };
}
