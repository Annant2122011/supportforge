import assert from 'node:assert/strict';
import test from 'node:test';

import { getWorkflowExecutionBlockReason, previewWorkflowTemplate, validateWorkflowTemplateDefinition } from '../src/core/domain/workflowSafety';

test('workflow template only accepts allowlisted conditions and typed actions', () => {
  const definition = validateWorkflowTemplateDefinition({
    conditions: [{ field: 'priority', equals: 'urgent' }, { field: 'status', equals: 'open' }],
    actions: [{ type: 'assign_department', value: 'billing' }, { type: 'set_priority', value: 'high' }],
  });
  assert.equal(definition.conditions.length, 2);
  assert.equal(definition.actions.length, 2);
  assert.equal(previewWorkflowTemplate(definition).executable, false);
  assert.match(getWorkflowExecutionBlockReason(definition) ?? '', /reassignment is blocked/i);
  assert.match(previewWorkflowTemplate(definition).warnings.join(' '), /reassignment is blocked/i);
});

test('manual workflow preview marks supported non-routing actions executable after review', () => {
  const definition = validateWorkflowTemplateDefinition({
    conditions: [{ field: 'status', equals: 'open' }],
    actions: [{ type: 'set_priority', value: 'high' }, { type: 'send_quick_reply', value: 'refund-ready' }],
  });
  assert.equal(previewWorkflowTemplate(definition).executable, true);
  assert.equal(getWorkflowExecutionBlockReason(definition), null);
  assert.match(previewWorkflowTemplate(definition).warnings.join(' '), /never run automatically/i);
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
