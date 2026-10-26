import type { Guild } from 'discord.js';

import { getAdvancedSettings, type TicketPriority } from './advancedSettingsService';

const PRIORITY_ROLE_ORDER: TicketPriority[] = [
  'critical',
  'urgent',
  'high',
  'normal',
  'low',
];

/**
 * Best-effort ordering shared by slash-command and button priority-role routes.
 * Failure to reorder roles must not undo a successfully created priority role.
 */
export async function enforcePriorityRoleHierarchy(guild: Guild): Promise<void> {
  const settings = await getAdvancedSettings(guild.id);
  const configured = PRIORITY_ROLE_ORDER.flatMap((priority) => {
    const roleId = settings.priorityRoles[priority];
    const role = roleId ? guild.roles.cache.get(roleId) : undefined;

    return roleId && role && !role.managed
      ? [{ priority, role }]
      : [];
  });

  if (configured.length === 0) return;

  const botMember =
    guild.members.me ??
    await guild.members.fetchMe().catch(() => null);

  const botHighestRole = botMember?.roles.highest;
  if (!botHighestRole) {
    console.warn('⚠️ QueryFixr could not determine its highest role; priority role ordering was skipped.');
    return;
  }

  const manageable = configured.filter(
    (entry) =>
      entry.role.editable &&
      entry.role.position < botHighestRole.position,
  );

  if (manageable.length === 0) return;

  const highestTargetPosition = botHighestRole.position - 1;
  const lowestTargetPosition =
    highestTargetPosition - manageable.length + 1;

  if (lowestTargetPosition < 1) {
    console.warn(
      '⚠️ Not enough manageable role positions below the QueryFixr bot role; priority role ordering was skipped.',
    );
    return;
  }

  const positions = manageable.map((entry, index) => ({
    role: entry.role.id,
    position: highestTargetPosition - index,
  }));

  try {
    await guild.roles.setPositions(positions);
    await guild.roles.fetch();
  } catch (error) {
    console.warn(
      '⚠️ Could not reorder QueryFixr priority roles. Role creation/deletion will continue normally:',
      error,
    );
  }
}
