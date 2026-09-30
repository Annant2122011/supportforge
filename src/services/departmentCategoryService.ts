import {
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
} from 'discord.js';

import {
  getGuildConfig,
  updateGuildConfig,
  type DepartmentConfig,
} from './configService';
import { logSystemEvent } from './auditLogService';
import { getPersistedTicketStatus } from './ticketPersistenceService';
import { getField, isTicketTopic } from './ticketStateService';
import { setChannelParent } from './discordChannelService';

const MAX_CHANNELS_PER_CATEGORY = 50;
const PREFIX = 'SupportForge.';

function categoryName(departmentName: string, suffix = 1): string {
  const clean = departmentName.replace(/\s+/g, ' ').trim();
  const base = (PREFIX + clean).slice(0, 100);

  if (suffix === 1) return base;

  const suffixText = ' ' + suffix;
  return base.slice(0, 100 - suffixText.length) + suffixText;
}

function isMatchingCategory(
  channel: unknown,
  baseName: string,
): channel is CategoryChannel {
  if (!channel || typeof channel !== 'object') return false;

  const candidate = channel as CategoryChannel;
  return (
    candidate.type === ChannelType.GuildCategory &&
    (candidate.name.toLowerCase() === baseName.toLowerCase() ||
      candidate.name.toLowerCase().startsWith(baseName.toLowerCase() + ' '))
  );
}

async function reconcileDepartmentTickets(
  guild: Guild,
  departmentId: string,
  category: CategoryChannel,
): Promise<void> {
  const capacity = MAX_CHANNELS_PER_CATEGORY - category.children.cache.size;
  if (capacity <= 0) return;

  let moved = 0;
  for (const channel of guild.channels.cache.values()) {
    if (moved >= capacity) break;
    if (channel.type !== ChannelType.GuildText) continue;

    const topic = channel.topic ?? '';
    if (!isTicketTopic(topic) || getField(topic, 'department') !== departmentId) {
      continue;
    }

    const status =
      (await getPersistedTicketStatus(channel.id)) ??
      getField(topic, 'status') ??
      'open';

    // Archived tickets stay in the dedicated archive bucket.
    if (status === 'archived' || channel.parentId === category.id) {
      continue;
    }

    await setChannelParent(
      channel.id,
      category.id,
      'SupportForge: reconcile ticket with department category',
    ).then(() => {
      moved += 1;
    }).catch((error) => {
      console.warn(
        '⚠️ Could not move ticket #' +
          (getField(topic, 'number') ?? 'unknown') +
          ' into ' +
          category.name +
          ':',
        error,
      );
    });
  }
}

async function removeEmptyOrphanDepartmentCategories(guild: Guild): Promise<void> {
  const config = await getGuildConfig(guild.id);
  const protectedIds = new Set(
    [
      config.supportCategoryId,
      config.openCategoryId,
      ...Object.values(config.departments).map((department) => department.categoryId),
    ].filter((id): id is string => Boolean(id)),
  );

  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildCategory) continue;
    if (protectedIds.has(channel.id)) continue;

    const isSupportForgeDepartmentCategory =
      channel.name.toLowerCase().startsWith(PREFIX.toLowerCase());

    if (!isSupportForgeDepartmentCategory || channel.children.cache.size > 0) {
      continue;
    }

    await channel.delete('SupportForge: remove empty orphan department category')
      .catch((error) => {
        console.warn('⚠️ Could not remove empty orphan SupportForge category ' + channel.name + ':', error);
      });
  }
}

export async function ensureDepartmentCategory(
  guild: Guild,
  department: Pick<DepartmentConfig, 'id' | 'name' | 'staffRoleId' | 'categoryId'>,
): Promise<CategoryChannel> {
  const bot = guild.members.me;
  if (!bot) {
    throw new Error('SupportForge bot member could not be resolved.');
  }

  const baseName = categoryName(department.name);

  const saved = department.categoryId
    ? guild.channels.cache.get(department.categoryId)
    : undefined;

  if (
    saved?.type === ChannelType.GuildCategory &&
    saved.children.cache.size < MAX_CHANNELS_PER_CATEGORY
  ) {
    await reconcileDepartmentTickets(guild, department.id, saved);
    return saved;
  }

  const candidates = [...guild.channels.cache.values()]
    .filter((channel) => isMatchingCategory(channel, baseName))
    .sort((a, b) => a.position - b.position);

  const available = candidates.find(
    (category) => category.children.cache.size < MAX_CHANNELS_PER_CATEGORY,
  );

  if (available) {
    await reconcileDepartmentTickets(guild, department.id, available);
    return available;
  }

  const suffix = candidates.length + 1;

  const category = await guild.channels.create({
    name: categoryName(department.name, suffix),
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      {
        id: bot.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      ...(department.staffRoleId
        ? [
            {
              id: department.staffRoleId,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
          ]
        : []),
    ],
    reason: 'SupportForge department category provisioning',
  });

  const config = await getGuildConfig(guild.id);
  await reconcileDepartmentTickets(guild, department.id, category);
  if (config.supportCategoryId) {
    void logSystemEvent(
      guild,
      config.supportCategoryId,
      'CATEGORY_CREATED',
      `Created SupportForge department category ${category.name} (${category.id}).`,
    ).catch(() => undefined);
  }

  return category;
}

export async function syncDepartmentCategoryId(
  guildId: string,
  departmentId: string,
  categoryId: string,
): Promise<void> {
  await updateGuildConfig(guildId, (config) => {
    const department = config.departments[departmentId];
    if (department) {
      department.categoryId = categoryId;
    }
  });
}

export async function ensureAllDepartmentCategories(
  guild: Guild,
): Promise<void> {
  const config = await getGuildConfig(guild.id);

  for (const department of Object.values(config.departments)) {
    /*
     * Every configured department owns a real Discord category. Missing
     * category IDs are repaired here instead of falling back to a global
     * Open bucket.
     */
    const category = await ensureDepartmentCategory(guild, department);

    if (department.categoryId !== category.id) {
      await syncDepartmentCategoryId(guild.id, department.id, category.id);
    }
  }

  await removeEmptyOrphanDepartmentCategories(guild);
}
