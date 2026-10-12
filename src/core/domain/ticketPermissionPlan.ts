import { PermissionFlagsBits } from 'discord.js';

export type OverwriteKind = 'role' | 'member';

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
  ownerId: string;
  userIds: string[];
  claimedModeratorIds: string[];
  formerClaimantIds?: string[];
  removeRoleIds?: string[];
  mode: 'unclaimed' | 'claimed';
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

/** Build a complete ACL plan so ticket visibility is applied in one request. */
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

  if (
    input.staffRoleId &&
    input.staffRoleId !== 'none' &&
    input.roleIds.has(input.staffRoleId)
  ) {
    const textPermissions = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ];
    setOverwrite(
      input.staffRoleId,
      input.mode === 'claimed' ? [] : textPermissions,
      input.mode === 'claimed' ? textPermissions : [],
    );
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
    ...(input.mode === 'claimed' ? input.claimedModeratorIds : []),
  ]);
  participants.delete('');

  const memberPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];
  for (const id of participants) setOverwrite(id, memberPermissions, []);

  const overwrites = [...next.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    changed: canonical(input.existing) !== canonical(overwrites),
    overwrites,
  };
}
