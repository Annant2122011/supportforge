import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateWorkflowConditions, previewWorkflowTemplate, validateWorkflowTemplateDefinition } from '../src/core/domain/workflowSafety';

test('workflow template only accepts allowlisted conditions and typed actions', () => {
  const definition = validateWorkflowTemplateDefinition({
    conditions: [{ field: 'priority', equals: 'urgent' }, { field: 'status', equals: 'open' }],
    actions: [{ type: 'assign_department', value: 'billing' }, { type: 'set_priority', value: 'high' }],
  });
  assert.equal(definition.conditions.length, 2);
  assert.equal(definition.actions.length, 2);
  assert.equal(previewWorkflowTemplate(definition).executable, false);
});

test('workflow validator rejects arbitrary JavaScript, SQL, unknown keys and lifecycle bypass actions', () => {
  assert.throws(() => validateWorkflowTemplateDefinition({
    conditions: [], actions: [{ type: 'run_code', value: 'process.exit(1)' }],
  }), /not allowlisted/);
  assert.throws(() => validateWorkflowTemplateDefinition({
    conditions: [{ field: 'status', equals: 'close-anything' }],
    actions: [{ type: 'set_priority', value: 'critical' }],
  }), /unsupported ticket status/);
  assert.throws(() => validateWorkflowTemplateDefinition({
    conditions: [], actions: [{ type: 'set_status', value: 'closed' }],
  }), /not allowlisted/);
  assert.throws(() => validateWorkflowTemplateDefinition({
    conditions: [], actions: [{ type: 'send_quick_reply', value: 'foo' , extra: 'bad' }],
  }), /unsupported keys/);
});

test('workflow caps limit execution blast radius and validate configured references', () => {
  assert.throws(() => validateWorkflowTemplateDefinition({ conditions: Array(6).fill({field:'status',equals:'open'}), actions: [{type:'add_tag',value:'refund'}] }), /at most five/);
  assert.throws(() => validateWorkflowTemplateDefinition({ conditions: [], actions: [] }), /1–10/);
  assert.throws(() => validateWorkflowTemplateDefinition({ conditions: [], actions: [{type:'add_tag',value:'tag with spaces'}] }), /validated configured ID/);
});


test('workflow condition evaluation is deterministic and fails closed on missing ticket metadata', () => {
  const definition = validateWorkflowTemplateDefinition({
    conditions: [
      { field: 'status', equals: 'open' },
      { field: 'priority', equals: 'urgent' },
      { field: 'departmentId', equals: 'billing' },
    ],
    actions: [{ type: 'set_priority', value: 'critical' }],
  });
  const match = evaluateWorkflowConditions(definition, {
    status: 'open',
    priority: 'urgent',
    departmentId: 'billing',
  });
  assert.equal(match.matches, true);
  assert.ok(match.conditions.every((item) => item.matches));

  const mismatch = evaluateWorkflowConditions(definition, {
    status: 'open',
    priority: null,
    departmentId: 'billing',
  });
  assert.equal(mismatch.matches, false);
  assert.equal(mismatch.conditions[1]?.actual, null);
  assert.equal(mismatch.conditions[1]?.matches, false);
});

test('empty workflow conditions match without implicit filters', () => {
  const definition = validateWorkflowTemplateDefinition({
    conditions: [],
    actions: [{ type: 'set_priority', value: 'high' }],
  });
  assert.deepEqual(evaluateWorkflowConditions(definition, {
    status: 'open',
    priority: 'normal',
    departmentId: null,
  }), { matches: true, conditions: [] });
});
