import assert from 'node:assert/strict';
import test from 'node:test';

import { PermissionFlagsBits } from 'discord.js';
import { buildTicketVisibilityPlan, type TicketPermissionSnapshot } from '../src/core/domain/ticketPermissionPlan';

const textAllow = String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory);
const memberAllow = String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks);
const botAllow = String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageMessages | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks);
const base: TicketPermissionSnapshot[] = [
  { id: 'everyone-role', kind: 'role', allow: '0', deny: String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory) },
  { id: 'staff-role', kind: 'role', allow: textAllow, deny: '0' },
  { id: 'owner', kind: 'member', allow: memberAllow, deny: '0' },
  { id: 'former-moderator', kind: 'member', allow: memberAllow, deny: '0' },
  { id: 'unrelated-role', kind: 'role', allow: String(PermissionFlagsBits.SendMessages), deny: '0' },
  { id: 'bot', kind: 'member', allow: botAllow, deny: '0' },
];
const roles = new Set(['everyone-role', 'staff-role', 'unrelated-role']);

test('claimed visibility batches staff denial and current participant grants', () => {
  const plan = buildTicketVisibilityPlan({
    existing: base, roleIds: roles, staffRoleId: 'staff-role',
    everyoneRoleId: 'everyone-role', botId: 'bot',
    ownerId: 'owner', userIds: [], claimedModeratorIds: ['moderator'], mode: 'claimed',
  });
  assert.equal(plan.changed, true);
  const staff = plan.overwrites.find((entry) => entry.id === 'staff-role')!;
  assert.equal(staff.deny, String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory));
  assert.ok(plan.overwrites.some((entry) => entry.id === 'moderator'));
  assert.ok(plan.overwrites.some((entry) => entry.id === 'unrelated-role' && entry.allow === String(PermissionFlagsBits.SendMessages)));
});

test('unclaim removes former claimant override and restores department staff', () => {
  const plan = buildTicketVisibilityPlan({
    existing: base, roleIds: roles, staffRoleId: 'staff-role',
    everyoneRoleId: 'everyone-role', botId: 'bot',
    ownerId: 'owner', userIds: [], claimedModeratorIds: [],
    formerClaimantIds: ['former-moderator'], mode: 'unclaimed',
  });
  assert.equal(plan.changed, true);
  assert.equal(plan.overwrites.some((entry) => entry.id === 'former-moderator'), false);
  assert.equal(plan.overwrites.find((entry) => entry.id === 'staff-role')!.allow, textAllow);
});

test('closed visibility preserves bot access and grants read-only access to ticket participants and staff', () => {
  const plan = buildTicketVisibilityPlan({
    existing: base, roleIds: roles, staffRoleId: 'staff-role',
    everyoneRoleId: 'everyone-role', botId: 'bot',
    ownerId: 'owner', userIds: ['participant'], claimedModeratorIds: ['moderator'], mode: 'closed',
  });
  const byId = new Map(plan.overwrites.map((item) => [item.id, item]));
  const staff = byId.get('staff-role')!;
  assert.equal(BigInt(staff.allow) & PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ViewChannel);
  assert.equal(BigInt(staff.allow) & PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ReadMessageHistory);
  assert.equal(BigInt(staff.deny) & PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessages);
  for (const id of ['owner', 'participant', 'moderator']) {
    const member = byId.get(id)!;
    assert.equal(BigInt(member.allow) & PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ViewChannel);
    assert.equal(BigInt(member.allow) & PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ReadMessageHistory);
    assert.equal(BigInt(member.deny) & PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessages);
  }
  assert.equal(byId.has('former-moderator'), false);
  assert.equal(byId.has('unrelated-role'), false);
  assert.equal(BigInt(byId.get('everyone-role')!.deny) & PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ViewChannel);
  assert.equal(BigInt(byId.get('bot')!.allow) & PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessages);
});

test('identical ACL requests do not require a channel mutation', () => {
  const plan = buildTicketVisibilityPlan({
    existing: base.filter((entry) => entry.id !== 'former-moderator'),
    roleIds: roles, staffRoleId: 'staff-role',
    everyoneRoleId: 'everyone-role', botId: 'bot',
    ownerId: 'owner', userIds: [], claimedModeratorIds: [], mode: 'unclaimed',
  });
  assert.equal(plan.changed, false);
});
