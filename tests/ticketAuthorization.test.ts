import assert from 'node:assert/strict';
import test from 'node:test';

import { canPerformTicketAction, isTicketManager, type TicketAuthorizationContext } from '../src/core/domain/ticketAuthorization';

const owner: TicketAuthorizationContext = {
  actorId: 'owner', ownerId: 'owner', isConfiguredStaff: false, isAdministrator: false,
};
const staff: TicketAuthorizationContext = {
  actorId: 'staff-member', ownerId: 'owner', isConfiguredStaff: true, isAdministrator: false,
};

test('only configured staff or elevated managers count as ticket managers', () => {
  assert.equal(isTicketManager(staff), true);
  assert.equal(isTicketManager({ ...staff, isConfiguredStaff: false, canManageGuild: true }), true);
  assert.equal(isTicketManager(owner), false);
});

test('ticket owners may close their own ticket but cannot manage other lifecycle actions', () => {
  assert.equal(canPerformTicketAction(owner, 'close', 'open'), true);
  assert.equal(canPerformTicketAction(owner, 'close', 'claimed'), true);
  assert.equal(canPerformTicketAction({ ...owner, actorId: 'another-user' }, 'close', 'open'), false);
  assert.equal(canPerformTicketAction(owner, 'claim', 'open'), false);
  assert.equal(canPerformTicketAction(owner, 'reopen', 'closed'), false);
  assert.equal(canPerformTicketAction(owner, 'archive', 'closed'), false);
});

test('ticket owners may resume only their own pending ticket', () => {
  assert.equal(canPerformTicketAction(owner, 'resume', 'pending'), true);
  assert.equal(canPerformTicketAction(owner, 'resume', 'claimed'), false);
  assert.equal(canPerformTicketAction(owner, 'resume', 'closed'), false);
  assert.equal(canPerformTicketAction(staff, 'resume', 'pending'), true);
});

test('delete requires configured staff or elevated channel-management permissions', () => {
  assert.equal(canPerformTicketAction(owner, 'delete', 'closed'), false);
  assert.equal(canPerformTicketAction({ ...owner, canManageChannels: true }, 'delete', 'closed'), true);
  assert.equal(canPerformTicketAction(staff, 'delete', 'closed'), true);
});
