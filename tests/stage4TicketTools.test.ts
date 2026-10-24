import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateTicketToolsAuthorization, isStage4TicketToolsCustomId } from '../src/core/domain/stage4TicketTools';

test('ticket owners can search public knowledge but do not receive staff controls', () => {
  assert.deepEqual(evaluateTicketToolsAuthorization({
    isAdmin: false, isAnyDepartmentStaff: false, isCurrentDepartmentStaff: false,
    ticketIsActive: true, ticketIsDeleted: false,
  }), {
    canSearchPublicKnowledge: true, canSearchStaffKnowledge: false, canUseQuickReplies: false,
    canManageRelatedTickets: false, canInspectWorkflowHistory: false,
  });
});

test('staff from another department can access staff knowledge but cannot reply in this ticket', () => {
  const access = evaluateTicketToolsAuthorization({
    isAdmin: false, isAnyDepartmentStaff: true, isCurrentDepartmentStaff: false,
    ticketIsActive: true, ticketIsDeleted: false,
  });
  assert.equal(access.canSearchStaffKnowledge, true);
  assert.equal(access.canUseQuickReplies, false);
  assert.equal(access.canManageRelatedTickets, false);
});

test('current department staff can use scoped quick replies but not admin-only cross-ticket tools', () => {
  const access = evaluateTicketToolsAuthorization({
    isAdmin: false, isAnyDepartmentStaff: true, isCurrentDepartmentStaff: true,
    ticketIsActive: true, ticketIsDeleted: false,
  });
  assert.equal(access.canUseQuickReplies, true);
  assert.equal(access.canManageRelatedTickets, false);
  assert.equal(access.canInspectWorkflowHistory, false);
});

test('administrators may use all tools only while the ticket remains active', () => {
  const active = evaluateTicketToolsAuthorization({
    isAdmin: true, isAnyDepartmentStaff: false, isCurrentDepartmentStaff: false,
    ticketIsActive: true, ticketIsDeleted: false,
  });
  assert.ok(Object.values(active).every(Boolean));
  for (const input of [
    { isAdmin: true, isAnyDepartmentStaff: true, isCurrentDepartmentStaff: true, ticketIsActive: false, ticketIsDeleted: false },
    { isAdmin: true, isAnyDepartmentStaff: true, isCurrentDepartmentStaff: true, ticketIsActive: true, ticketIsDeleted: true },
  ]) {
    assert.ok(Object.values(evaluateTicketToolsAuthorization(input)).every((value) => !value));
  }
});

test('tool routing matches only its own custom ID prefix', () => {
  assert.equal(isStage4TicketToolsCustomId('ticket:stage4:tools'), true);
  assert.equal(isStage4TicketToolsCustomId('ticket:stage4:tools:quickreply'), true);
  assert.equal(isStage4TicketToolsCustomId('ticket:stage4:toolsmith'), false);
  assert.equal(isStage4TicketToolsCustomId('sf:settings:stage4:tools'), false);
});
