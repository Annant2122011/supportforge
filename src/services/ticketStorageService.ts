import {
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { getAdvancedSettings, updateAdvancedSettings } from './advancedSettingsService';
import { setChannelParent } from './discordChannelService';

const MAX_CHANNELS_PER_CATEGORY = 50;

async function ensureBucket(
  guild: Guild,
  baseName: string,
  key:
    | 'closedCategoryId'
    | 'archiveCategoryId',
): Promise<CategoryChannel> {
  const settings = await getAdvancedSettings(guild.id);
  const saved = settings[key];

  const savedChannel = saved
    ? guild.channels.cache.get(saved)
    : undefined;

  if (
    savedChannel?.type === ChannelType.GuildCategory &&
    savedChannel.children.cache.size < MAX_CHANNELS_PER_CATEGORY
  ) {
    return savedChannel;
  }

  const candidates = guild.channels.cache.filter(
    (channel): channel is CategoryChannel =>
      channel.type === ChannelType.GuildCategory &&
      (channel.name === baseName ||
        channel.name.startsWith(baseName + ' ')),
  );

  const available = candidates
    .sort((a, b) => a.position - b.position)
    .find(
      (category) =>
        category.children.cache.size < MAX_CHANNELS_PER_CATEGORY,
    );

  if (available) {
    await updateAdvancedSettings(guild.id, (current) => {
      current[key] = available.id;
    });
    return available;
  }

  const suffix = candidates.size + 1;
  const bot = guild.members.me;

  if (!bot) {
    throw new Error('SupportForge bot member could not be resolved.');
  }

  const category = await guild.channels.create({
    name: suffix === 1 ? baseName : baseName + ' ' + suffix,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
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
    ],
  });

  await updateAdvancedSettings(guild.id, (current) => {
    current[key] = category.id;
  });

  return category;
}

export async function ensureClosedCategory(
  guild: Guild,
): Promise<CategoryChannel> {
  return ensureBucket(guild, 'SupportForge • Closed', 'closedCategoryId');
}

export async function ensureArchiveCategory(
  guild: Guild,
): Promise<CategoryChannel> {
  return ensureBucket(guild, 'SupportForge • Archive', 'archiveCategoryId');
}

export async function moveTicketToCategory(
  channel: TextChannel,
  category: CategoryChannel,
): Promise<void> {
  if (channel.parentId === category.id) return;

  await setChannelParent(
    channel.id,
    category.id,
    'SupportForge ticket storage transition',
  );
}
