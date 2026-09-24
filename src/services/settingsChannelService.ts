import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
} from 'discord.js';

import { getGuildConfig } from './configService';
import {
  buildSettingsSummary,
  getAdvancedSettings,
} from './advancedSettingsService';

const SETTINGS_TOPIC_PREFIX = 'supportforge:settings';
const SETTINGS_TITLE = '⚙️ SupportForge Settings';

function settingsButton(
  customId: string,
  label: string,
  style = ButtonStyle.Secondary,
  emoji?: string,
): ButtonBuilder {
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style);

  if (emoji) button.setEmoji(emoji);
  return button;
}

export function buildSettingsDashboardComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      settingsButton('sf:settings:panel', 'Panel', ButtonStyle.Primary, '🎛️'),
      settingsButton('sf:settings:defaults', 'Ticket Defaults', ButtonStyle.Secondary, '🎟️'),
      settingsButton('sf:settings:tags', 'Custom Tags', ButtonStyle.Secondary, '🏷️'),
      settingsButton('sf:settings:departments', 'Departments', ButtonStyle.Secondary, '📂'),
      settingsButton('sf:settings:retention', 'Retention', ButtonStyle.Secondary, '🧹'),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      settingsButton('sf:settings:appearance', 'Appearance', ButtonStyle.Secondary, '🎨'),
      settingsButton('sf:settings:storage', 'Storage', ButtonStyle.Secondary, '🗄️'),
      settingsButton('sf:settings:usecases', 'Use Cases', ButtonStyle.Secondary, '🧩'),
      settingsButton('sf:settings:repair', 'Repair System', ButtonStyle.Secondary, '🛠️'),
      settingsButton('sf:settings:refresh', 'Refresh', ButtonStyle.Secondary, '🔄'),
    ),
  ];
}

export async function ensureSettingsChannel(
  guild: Guild,
  parentId: string,
): Promise<TextChannel> {
  const settings = await getAdvancedSettings(guild.id);
  const bot = guild.members.me;

  if (!bot) {
    throw new Error('SupportForge bot member could not be resolved.');
  }

  let channel: TextChannel | undefined;

  if (settings.settingsChannelId) {
    const saved = guild.channels.cache.get(settings.settingsChannelId);
    if (saved?.type === ChannelType.GuildText) {
      channel = saved;
    }
  }

  if (!channel) {
    const existing = guild.channels.cache.find(
      (candidate) =>
        candidate.type === ChannelType.GuildText &&
        candidate.topic?.startsWith(SETTINGS_TOPIC_PREFIX),
    );

    channel =
      existing?.type === ChannelType.GuildText
        ? existing
        : await guild.channels.create({
            name: 'supportforge-settings',
            type: ChannelType.GuildText,
            parent: parentId,
            topic: SETTINGS_TOPIC_PREFIX + ' guild=' + guild.id,
            permissionOverwrites: [
              {
                id: guild.roles.everyone.id,
                deny: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                ],
              },
              {
                id: bot.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.EmbedLinks,
                ],
              },
            ],
          });
  }

  if (channel.parentId !== parentId) {
    await channel
      .setParent(parentId, { lockPermissions: false })
      .catch(() => undefined);
  }

  for (const department of Object.values(
    (await getGuildConfig(guild.id)).departments,
  )) {
    if (!department.staffRoleId) continue;

    await channel.permissionOverwrites
      .edit(department.staffRoleId, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: false,
      })
      .catch(() => undefined);
  }

  await channel.permissionOverwrites
    .edit(guild.roles.everyone.id, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false,
    })
    .catch(() => undefined);

  await channel.permissionOverwrites
    .edit(bot.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      EmbedLinks: true,
    })
    .catch(() => undefined);

  const currentSettings = await getAdvancedSettings(guild.id);

  await refreshSettingsDashboard(channel, currentSettings);

  return channel;
}

async function refreshSettingsDashboard(
  channel: TextChannel,
  settings?: Awaited<ReturnType<typeof getAdvancedSettings>>,
): Promise<void> {
  const resolvedSettings = settings ?? (await getAdvancedSettings(channel.guild.id));
  const config = await getGuildConfig(channel.guild.id);
  const departmentCount = Object.keys(config.departments).length;

  const embed = new EmbedBuilder()
    .setTitle(SETTINGS_TITLE)
    .setDescription(
      'Administrative control center for SupportForge.\n\n' +
        '**Everything below is button-driven.** No configuration slash commands are required.\n\n' +
        'Use the buttons to configure ticket behavior, custom tags, departments, retention, appearance, and system repair.',
    )
    .addFields(
      {
        name: '🎛️ Panel',
        value:
          (resolvedSettings.panelActivity.enabled ? 'Enabled' : 'Disabled') +
          ' • ' +
          resolvedSettings.panelActivity.visualLineBudget +
          ' visual lines • ' +
          resolvedSettings.panelActivity.messageBudget +
          ' message safety cap',
        inline: false,
      },
      {
        name: '🎟️ Ticket defaults',
        value:
          'Default priority: **' +
          resolvedSettings.ticketDefaults.priority +
          '**',
        inline: true,
      },
      {
        name: '🏷️ Custom tags',
        value:
          '**' +
          Object.keys(resolvedSettings.customTags).length +
          '** configured',
        inline: true,
      },
      {
        name: '📂 Departments',
        value: '**' + departmentCount + '** configured',
        inline: true,
      },
      {
        name: '🧹 Retention',
        value:
          'Closed: **' +
          (resolvedSettings.retention.closedDays || 'Never') +
          '** • Archive: **' +
          (resolvedSettings.retention.archiveDays || 'Never') +
          '** days',
        inline: false,
      },
      {
        name: '📋 Configuration snapshot',
        value: buildSettingsSummary(resolvedSettings).slice(0, 1024),
        inline: false,
      },
    )
    .setFooter({
      text: 'SupportForge • Advanced Ticket Configuration',
    })
    .setTimestamp();

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const dashboard = recent?.find(
    (message) =>
      message.author.id === channel.client.user?.id &&
      message.embeds.some((item) => item.title === SETTINGS_TITLE),
  );

  if (dashboard) {
    await dashboard.edit({
      embeds: [embed],
      components: buildSettingsDashboardComponents(),
    });
  } else {
    await channel.send({
      embeds: [embed],
      components: buildSettingsDashboardComponents(),
    });
  }
}

export async function refreshSettingsChannel(guild: Guild): Promise<void> {
  const settings = await getAdvancedSettings(guild.id);
  if (!settings.settingsChannelId) return;

  const channel = guild.channels.cache.get(settings.settingsChannelId);
  if (channel?.type !== ChannelType.GuildText) return;

  await refreshSettingsDashboard(channel, settings);
}
