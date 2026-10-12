import assert from 'node:assert/strict';
import test from 'node:test';

import { PermissionFlagsBits } from 'discord.js';
import { buildTicketVisibilityPlan, type TicketPermissionSnapshot } from '../src/core/domain/ticketPermissionPlan';

const textAllow = String(
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.ReadMessageHistory,
);
const memberAllow = String(
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.EmbedLinks,
);
const base: TicketPermissionSnapshot[] = [
  { id: 'everyone-role', kind: 'role', allow: '0', deny: String(PermissionFlagsBits.ViewChannel) },
  { id: 'staff-role', kind: 'role', allow: textAllow, deny: '0' },
  { id: 'owner', kind: 'member', allow: memberAllow, deny: '0' },
  { id: 'former-moderator', kind: 'member', allow: memberAllow, deny: '0' },
  { id: 'unrelated-role', kind: 'role', allow: String(PermissionFlagsBits.SendMessages), deny: '0' },
];
const roles = new Set(['everyone-role', 'staff-role', 'unrelated-role']);

test('claimed visibility batches staff denial and current participant grants', () => {
  const plan = buildTicketVisibilityPlan({
    existing: base,
    roleIds: roles,
    staffRoleId: 'staff-role',
    ownerId: 'owner',
    userIds: [],
    claimedModeratorIds: ['moderator'],
    mode: 'claimed',
  });
  assert.equal(plan.changed, true);
  const staff = plan.overwrites.find((entry) => entry.id === 'staff-role')!;
  assert.equal(staff.deny, String(
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.ReadMessageHistory,
  ));
  assert.ok(plan.overwrites.some((entry) => entry.id === 'moderator'));
  assert.ok(plan.overwrites.some((entry) => entry.id === 'unrelated-role' && entry.allow === String(PermissionFlagsBits.SendMessages)));
});

test('unclaim removes former claimant override and restores department staff', () => {
  const plan = buildTicketVisibilityPlan({
    existing: base,
    roleIds: roles,
    staffRoleId: 'staff-role',
    ownerId: 'owner',
    userIds: [],
    claimedModeratorIds: [],
    formerClaimantIds: ['former-moderator'],
    mode: 'unclaimed',
  });
  assert.equal(plan.changed, true);
  assert.equal(plan.overwrites.some((entry) => entry.id === 'former-moderator'), false);
  assert.equal(plan.overwrites.find((entry) => entry.id === 'staff-role')!.allow, textAllow);
});

test('identical ACL requests do not require a channel mutation', () => {
  const plan = buildTicketVisibilityPlan({
    existing: base.filter((entry) => entry.id !== 'former-moderator'),
    roleIds: roles,
    staffRoleId: 'staff-role',
    ownerId: 'owner',
    userIds: [],
    claimedModeratorIds: [],
    mode: 'unclaimed',
  });
  assert.equal(plan.changed, false);
});
