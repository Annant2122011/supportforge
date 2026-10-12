import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTicketRoutingComponent } from '../src/core/domain/ticketInteractionRouting';

test('department selection is routed to the department-change handler', () => {
  assert.equal(classifyTicketRoutingComponent('ticket:department:select'), 'department-select');
});

test('department navigation and cancel controls are handled buttons', () => {
  assert.equal(classifyTicketRoutingComponent('ticket:department:page:0'), 'department-navigation');
  assert.equal(classifyTicketRoutingComponent('ticket:department:page:-1'), 'department-navigation');
  assert.equal(classifyTicketRoutingComponent('ticket:department:cancel'), 'department-navigation');
});

test('routing tag selection, paging, and cancel controls are handled', () => {
  assert.equal(classifyTicketRoutingComponent('ticket:routing-tag:select:billing'), 'routing-tag-select');
  assert.equal(classifyTicketRoutingComponent('ticket:routing-tag:page:1:billing'), 'routing-tag-navigation');
  assert.equal(classifyTicketRoutingComponent('ticket:routing-tag:page:-1:billing'), 'routing-tag-navigation');
  assert.equal(classifyTicketRoutingComponent('ticket:routing-tag:cancel'), 'routing-tag-navigation');
});

test('unrelated or malformed component IDs are not treated as routing controls', () => {
  assert.equal(classifyTicketRoutingComponent('ticket:unknown'), 'none');
  assert.equal(classifyTicketRoutingComponent('ticket:routing-tag:page:not-a-number:billing'), 'none');
});
