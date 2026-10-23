import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';

import { getGuildConfig } from './configService';
import { getPersistedTicketStatus } from './ticketPersistenceService';
import { setChannelPermissionOverwrite, setChannelTopic } from './discordChannelService';
import { getField, getTicketStatus, setField } from './ticketStateService';

/**
 * Keep a department's staff-role permissions and ticket metadata synchronized
 * regardless of whether the change came from a button modal or a slash command.
 */
export async function migrateDepartmentStaffRole(
  guild: Guild,
  departmentId: string,
  oldRoleId: string | null,
  newRoleId: string | null,
): Promise<void> {
  if (oldRoleId === newRoleId) return;

  const config = await getGuildConfig(guild.id);
  const department = config.departments[departmentId];
  const category = department?.categoryId
    ? guild.channels.cache.get(department.categoryId)
    : null;

  if (category?.type === ChannelType.GuildCategory) {
    if (oldRoleId) {
      await setChannelPermissionOverwrite(
        category.id,
        oldRoleId,
        [],
        [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        0,
        'QueryFixr remove previous department staff role access',
      ).catch((error) => console.warn('⚠️ Could not remove previous department role from category:', error));
    }
    if (newRoleId) {
      await setChannelPermissionOverwrite(
        category.id,
        newRoleId,
        [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        [],
        0,
        'QueryFixr grant new department staff role access',
      ).catch((error) => console.warn('⚠️ Could not grant new department role to category:', error));
    }
  }

  for (const channel of guild.channels.cache.values()) {
    if (
      channel.type !== ChannelType.GuildText ||
      !channel.topic?.startsWith('supportforge:ticket') ||
      getField(channel.topic, 'department') !== departmentId
    ) {
      continue;
    }

    const topic = channel.topic;
    const status = (await getPersistedTicketStatus(channel.id)) ?? getTicketStatus(topic);
    const nextTopic = setField(topic, 'staff', newRoleId ?? 'none');

    if (oldRoleId && oldRoleId !== newRoleId) {
      await setChannelPermissionOverwrite(
        channel.id,
        oldRoleId,
        [],
        [],
        0,
        'QueryFixr clear previous department staff ticket override',
      ).catch((error) => console.warn('⚠️ Could not clear old department role on ticket ' + channel.id + ':', error));
    }

    if (newRoleId) {
      const claimed = status === 'claimed';
      await setChannelPermissionOverwrite(
        channel.id,
        newRoleId,
        claimed
          ? []
          : [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
        claimed
          ? [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ]
          : [],
        0,
        claimed
          ? 'QueryFixr hide claimed ticket from new department staff role'
          : 'QueryFixr grant new department staff ticket access',
      ).catch((error) => console.warn('⚠️ Could not synchronize new department staff access on ticket ' + channel.id + ':', error));
    }

    await setChannelTopic(
      channel.id,
      nextTopic,
      'QueryFixr migrate department staff role metadata',
    ).catch((error) => console.warn('⚠️ Could not update staff metadata on ticket ' + channel.id + ':', error));

    channel.topic = nextTopic;
  }
}
