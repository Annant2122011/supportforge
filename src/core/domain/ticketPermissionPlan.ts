import { PermissionFlagsBits } from 'discord.js';

export type OverwriteKind = 'role' | 'member';
export type TicketVisibilityMode = 'unclaimed' | 'claimed' | 'closed';

export interface TicketPermissionSnapshot {
  id: string;
  kind: OverwriteKind;
  allow: string;
  deny: string;
}

export interface TicketVisibilityPlanInput {
  existing: TicketPermissionSnapshot[];
  roleIds: ReadonlySet<string>;
  staffRoleId?: string | null;
  everyoneRoleId?: string | null;
  botId?: string | null;
  ownerId: string;
  userIds: string[];
  claimedModeratorIds: string[];
  formerClaimantIds?: string[];
  removeRoleIds?: string[];
  mode: TicketVisibilityMode;
}

export interface TicketVisibilityPlan {
  changed: boolean;
  overwrites: TicketPermissionSnapshot[];
}

function bitfield(values: readonly bigint[]): string {
  return values.reduce((result, value) => result | value, 0n).toString();
}

function canonical(overwrites: TicketPermissionSnapshot[]): string {
  return JSON.stringify(
    [...overwrites]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((overwrite) => [overwrite.id, overwrite.kind, overwrite.allow, overwrite.deny]),
  );
}

/** Build one complete ACL plan so all ticket access changes use one channel PATCH. */
export function buildTicketVisibilityPlan(input: TicketVisibilityPlanInput): TicketVisibilityPlan {
  const next = new Map<string, TicketPermissionSnapshot>(
    input.existing.map((item) => [item.id, { ...item }]),
  );

  const setOverwrite = (id: string, allow: readonly bigint[], deny: readonly bigint[]): void => {
    next.set(id, {
      id,
      kind: input.roleIds.has(id) ? 'role' : 'member',
      allow: bitfield(allow),
      deny: bitfield(deny),
    });
  };

  const everyoneId = input.everyoneRoleId ?? null;
  const botId = input.botId ?? null;
  const viewHistorySend = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  if (input.mode === 'closed') {
    const allowedMembers = new Set<string>([
      input.ownerId,
      ...input.userIds,
      ...input.claimedModeratorIds,
    ]);
    allowedMembers.delete('');

    // Retain only the @everyone/staff roles, the bot, and current ticket members.
    for (const overwrite of input.existing) {
      if (overwrite.id === botId || allowedMembers.has(overwrite.id)) continue;
      if (overwrite.kind === 'role' && overwrite.id === input.staffRoleId) continue;
      if (overwrite.kind === 'role' && overwrite.id === everyoneId) continue;
      next.delete(overwrite.id);
    }

    if (everyoneId) setOverwrite(everyoneId, [], viewHistorySend);
    if (botId) {
      setOverwrite(botId, [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ], []);
    }
  }

  if (input.staffRoleId && input.staffRoleId !== 'none' && input.staffRoleId !== everyoneId && input.roleIds.has(input.staffRoleId)) {
    if (input.mode === 'claimed') {
      setOverwrite(input.staffRoleId, [], viewHistorySend);
    } else if (input.mode === 'closed') {
      setOverwrite(input.staffRoleId, [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ], [PermissionFlagsBits.SendMessages]);
    } else {
      setOverwrite(input.staffRoleId, viewHistorySend, []);
    }
  }

  for (const roleId of input.removeRoleIds ?? []) {
    if (roleId && roleId !== input.staffRoleId) next.delete(roleId);
  }

  const claimed = new Set(input.claimedModeratorIds.filter(Boolean));
  for (const formerId of input.formerClaimantIds ?? []) {
    if (!formerId || formerId === input.ownerId || claimed.has(formerId)) continue;
    next.delete(formerId);
  }

  const participants = new Set<string>([
    input.ownerId,
    ...input.userIds,
    ...(input.mode === 'claimed' || input.mode === 'closed' ? input.claimedModeratorIds : []),
  ]);
  participants.delete('');
  if (botId) participants.delete(botId);

  if (input.mode === 'closed') {
    for (const id of participants) {
      setOverwrite(id, [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ], [PermissionFlagsBits.SendMessages]);
    }
  } else {
    const memberPermissions = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ];
    for (const id of participants) setOverwrite(id, memberPermissions, []);
  }

  const overwrites = [...next.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    changed: canonical(input.existing) !== canonical(overwrites),
    overwrites,
  };
}
