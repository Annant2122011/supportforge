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


export type OptionalStatusCategory = 'claimed' | 'pending';

const OPTIONAL_STATUS_CATEGORY_CONFIG: Record<
  OptionalStatusCategory,
  { setting: 'claimedCategoryId' | 'pendingCategoryId'; name: string }
> = {
  claimed: {
    setting: 'claimedCategoryId',
    name: 'SupportForge.Claimed tickets',
  },
  pending: {
    setting: 'pendingCategoryId',
    name: 'SupportForge.Pending tickets',
  },
};

export async function ensureOptionalStatusCategory(
  guild: Guild,
  status: OptionalStatusCategory,
): Promise<CategoryChannel> {
  const settings = await getAdvancedSettings(guild.id);
  const config = OPTIONAL_STATUS_CATEGORY_CONFIG[status];
  const savedId = settings.statusCategories[config.setting];
  const bot = guild.members.me;

  if (!bot) {
    throw new Error('SupportForge bot member could not be resolved.');
  }

  const saved = savedId
    ? guild.channels.cache.get(savedId)
    : undefined;

  if (
    saved?.type === ChannelType.GuildCategory &&
    saved.children.cache.size < MAX_CHANNELS_PER_CATEGORY
  ) {
    return saved;
  }

  const candidates = [...guild.channels.cache.values()]
    .filter(
      (channel) =>
        channel.type === ChannelType.GuildCategory &&
        channel.name.toLowerCase().startsWith(config.name.toLowerCase()),
    )
    .sort((a, b) => a.position - b.position);

  const available = candidates.find(
    (category) => category.children.cache.size < MAX_CHANNELS_PER_CATEGORY,
  );

  if (available) {
    await updateAdvancedSettings(guild.id, (current) => {
      current.statusCategories[config.setting] = available.id;
    });
    return available;
  }

  const suffix = candidates.length + 1;
  const name =
    suffix === 1
      ? config.name
      : config.name.slice(0, 100 - String(suffix).length - 1) + ' ' + suffix;

  const category = await guild.channels.create({
    name,
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
    ],
    reason: 'SupportForge optional ticket status category',
  });

  await updateAdvancedSettings(guild.id, (current) => {
    current.statusCategories[config.setting] = category.id;
  });

  return category;
}

export async function getOptionalStatusCategory(
  guild: Guild,
  status: OptionalStatusCategory,
): Promise<CategoryChannel | null> {
  const settings = await getAdvancedSettings(guild.id);
  const setting = OPTIONAL_STATUS_CATEGORY_CONFIG[status].setting;
  const id = settings.statusCategories[setting];

  if (!id) return null;

  const channel = guild.channels.cache.get(id);
  return channel?.type === ChannelType.GuildCategory ? channel : null;
}
