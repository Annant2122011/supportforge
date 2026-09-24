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

export async function ensureDepartmentCategory(
  guild: Guild,
  department: Pick<DepartmentConfig, 'name' | 'staffRoleId' | 'categoryId'>,
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
    return saved;
  }

  const candidates = [...guild.channels.cache.values()]
    .filter((channel) => isMatchingCategory(channel, baseName))
    .sort((a, b) => a.position - b.position);

  const available = candidates.find(
    (category) => category.children.cache.size < MAX_CHANNELS_PER_CATEGORY,
  );

  if (available) {
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
    // Fresh installations keep the default General Support department in
    // the main Support Forge category. Only explicitly provisioned
    // department categories are repaired here.
    if (!department.categoryId) continue;

    const category = await ensureDepartmentCategory(guild, department);

    if (department.categoryId !== category.id) {
      await syncDepartmentCategoryId(guild.id, department.id, category.id);
    }
  }
}
