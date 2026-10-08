import {
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { getAdvancedSettings, updateAdvancedSettings } from './advancedSettingsService';
import { getGuildConfig, updateGuildConfig } from './configService';
import { setChannelParent } from './discordChannelService';
import { logSystemEvent } from './auditLogService';

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
    const bot = guild.members.me;
    if (!bot) {
      throw new Error('SupportForge bot member could not be resolved.');
    }

    await savedChannel.permissionOverwrites.edit(guild.roles.everyone.id, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false,
    });
    await savedChannel.permissionOverwrites.edit(bot.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: true,
      ManageMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
    });
    return savedChannel;
  }

  /*
   * Display names are not ownership proof. If the persisted category ID is
   * missing or invalid, create a new SupportForge storage bucket rather than
   * adopting an unrelated category with the same name.
   */
  const existingManagedBuckets = [...guild.channels.cache.values()]
    .filter(
      (channel): channel is CategoryChannel =>
        channel.type === ChannelType.GuildCategory &&
        channel.name === baseName &&
        channel.permissionOverwrites.cache.has(guild.roles.everyone.id) &&
        channel.permissionOverwrites.cache.has(guild.members.me?.id ?? ''),
    );

  /*
   * A matching display name is still unsafe to adopt. Keep a deterministic
   * suffix for genuinely new buckets, based only on previously provisioned
   * SupportForge buckets that are still identifiable by name + bot overwrite.
   */
  const suffix = existingManagedBuckets.length + 1;
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

  await updateGuildConfig(guild.id, (current) => {
    current.managedCategoryIds = Array.from(
      new Set([...(current.managedCategoryIds ?? []), category.id]),
    );
  });

  const config = await getGuildConfig(guild.id);
  if (config.supportCategoryId) {
    void logSystemEvent(
      guild,
      config.supportCategoryId,
      'CATEGORY_CREATED',
      `Created SupportForge storage category ${category.name} (${category.id}) for ${key.replace('CategoryId', '')} tickets.`,
    ).catch(() => undefined);
  }

  return category;
}

export async function ensureClosedCategory(
  guild: Guild,
): Promise<CategoryChannel> {
  return ensureBucket(guild, 'SupportForge • Closed', 'closedCategoryId');
}


const OPEN_CATEGORY_NAME = 'Open';

export async function ensureOpenCategory(
  guild: Guild,
): Promise<CategoryChannel> {
  const config = await getGuildConfig(guild.id);

  const saved = config.openCategoryId
    ? guild.channels.cache.get(config.openCategoryId)
    : undefined;

  if (
    saved?.type === ChannelType.GuildCategory &&
    saved.children.cache.size < MAX_CHANNELS_PER_CATEGORY
  ) {
    const bot = guild.members.me;
    if (!bot) {
      throw new Error('SupportForge bot member could not be resolved.');
    }

    await saved.permissionOverwrites.edit(guild.roles.everyone.id, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false,
    });
    await saved.permissionOverwrites.edit(bot.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: true,
      ManageMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
    });
    return saved;
  }

  /*
   * A category's name is not ownership proof. Only a persisted ID can identify
   * an existing SupportForge Open bucket; otherwise create a new managed one.
   * Discord allows duplicate category names, so there is no need to adopt an
   * unrelated category or manufacture a suffix based on unrelated resources.
   */
  const name = OPEN_CATEGORY_NAME;

  const bot = guild.members.me;

  if (!bot) {
    throw new Error('SupportForge bot member could not be resolved.');
  }

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
    reason: 'SupportForge open ticket category provisioning',
  });

  await updateGuildConfig(guild.id, (current) => {
    current.openCategoryId = category.id;
    current.managedCategoryIds = Array.from(
      new Set([...(current.managedCategoryIds ?? []), category.id]),
    );
  });

  const supportCategoryId = (await getGuildConfig(guild.id)).supportCategoryId;
  if (supportCategoryId) {
    void logSystemEvent(
      guild,
      supportCategoryId,
      'CATEGORY_CREATED',
      `Created the dedicated Open ticket category ${category.name} (${category.id}).`,
    ).catch(() => undefined);
  }

  return category;
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
    await saved.permissionOverwrites.edit(guild.roles.everyone.id, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false,
    });
    await saved.permissionOverwrites.edit(bot.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: true,
      ManageMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
    });
    return saved;
  }

  /*
   * Optional status categories are SupportForge-owned infrastructure too.
   * Reusing an unrelated category based solely on its display name could
   * expose private tickets to the wrong users.
   */
  /*
   * The visible category name is not ownership proof. A missing persisted ID
   * means SupportForge must create a fresh optional-status bucket.
   */
  const existingNames = [...guild.channels.cache.values()]
    .filter(
      (channel): channel is CategoryChannel =>
        channel.type === ChannelType.GuildCategory &&
        channel.name.toLowerCase().startsWith(config.name.toLowerCase()),
    );

  const suffix = existingNames.length + 1;
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

  await updateGuildConfig(guild.id, (current) => {
    current.managedCategoryIds = Array.from(
      new Set([...(current.managedCategoryIds ?? []), category.id]),
    );
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
