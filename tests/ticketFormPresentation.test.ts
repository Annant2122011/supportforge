import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTicketFormHomePresentation,
  formatTicketFormSchemaPageDescription,
} from '../src/services/ticketFormPresentation';

test('forms dashboard summarizes live records and routing at a glance', () => {
  const presentation = buildTicketFormHomePresentation({ totalForms: 12, activeForms: 4, totalTemplates: 3, departmentCount: 2, tagCount: 15 });
  assert.match(presentation.description, /New forms start inactive/);
  assert.match(presentation.description, /conditional fields/);
  assert.deepEqual(presentation.fields, [
    { name: 'FORMS', value: '**12** saved\n4 active', inline: true },
    { name: 'TEMPLATES', value: '**3** reusable schemas', inline: true },
    { name: 'ROUTING', value: '**2** departments\n15 tags', inline: true },
  ]);
});

test('dashboard metrics are clamped to safe non-negative counts', () => {
  const presentation = buildTicketFormHomePresentation({ totalForms: -1, activeForms: 8, totalTemplates: Number.NaN, departmentCount: 2.8, tagCount: 0 });
  assert.deepEqual(presentation.fields.map((field) => field.value), [
    '**0** saved\n0 active',
    '**0** reusable schemas',
    '**2** departments\n0 tags',
  ]);
});

test('schema page puts JSON in a code fence with correct page navigation', () => {
  const description = formatTicketFormSchemaPageDescription({ formName: 'Returns Form', page: 2, pages: 4, chunk: '{\n  "fields": []\n' });
  assert.match(description, /Current schema for Returns Form · Page 2 \/ 4/);
  assert.match(description, /Multi-page schema/);
  const fence = String.fromCharCode(96).repeat(3);
  assert.ok(description.includes(fence + 'json\n'));
  assert.ok(description.endsWith('\n' + fence));
});

test('schema code block remains valid Markdown when user content contains triple backticks', () => {
  const triple = String.fromCharCode(96).repeat(3);
  const description = formatTicketFormSchemaPageDescription({ formName: 'Escapes', page: 1, pages: 1, chunk: '{"label":"' + triple + '"}' });
  const fence = String.fromCharCode(96).repeat(4);
  assert.ok(description.includes(fence + 'json\n'));
  assert.ok(description.endsWith('\n' + fence));
});

test('schema page indices are clamped before rendering', () => {
  const description = formatTicketFormSchemaPageDescription({ formName: 'Clamp', page: 99, pages: 3, chunk: '{}' });
  assert.match(description, /Page 3 \/ 3/);
});
