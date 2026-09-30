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
  getAdvancedSettings,
} from './advancedSettingsService';
import { ensureChannelPurposeMessage } from './channelPurposeService';
import { logSystemEvent } from './auditLogService';

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
      settingsButton('sf:settings:tags', 'Tags / Departments', ButtonStyle.Secondary, '🏷️'),
      settingsButton('sf:settings:usecases', 'Use Cases', ButtonStyle.Secondary, '🧩'),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      settingsButton('sf:settings:retention', 'Retention', ButtonStyle.Secondary, '🧹'),
      settingsButton('sf:settings:appearance', 'Appearance', ButtonStyle.Secondary, '🎨'),
      settingsButton('sf:settings:storage', 'Storage', ButtonStyle.Secondary, '🗄️'),
      settingsButton('sf:settings:rules', 'Rules & Roles', ButtonStyle.Secondary, '🎨'),
      settingsButton('sf:settings:repair', 'Repair System', ButtonStyle.Secondary, '🛠️'),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      settingsButton('sf:settings:manual', 'Manual', ButtonStyle.Secondary, '📖'),
      settingsButton('sf:settings:refresh', 'Refresh', ButtonStyle.Secondary, '🔄'),
      settingsButton('sf:settings:reset', 'Delete Everything', ButtonStyle.Danger, '🚨'),
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

  const created = !channel;

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

  const purposeMessage =
    'This private channel is SupportForge’s administrative control center. Use the buttons here to configure tickets, routing tags/departments, retention, appearance, storage, rules, roles, repairs, and other server-level SupportForge settings.';

  await ensureChannelPurposeMessage(channel, purposeMessage);

  await refreshSettingsDashboard(channel, currentSettings);

  if (created) {
    const config = await getGuildConfig(guild.id);
    if (config.supportCategoryId) {
      void logSystemEvent(
        guild,
        config.supportCategoryId,
        'CHANNEL_CREATED',
        'Created SupportForge Settings channel ' + channel.name + ' (' + channel.id + ').',
      ).catch(() => undefined);
    }
  }

  return channel;
}

export function buildSettingsDashboardEmbed(
  settings: Awaited<ReturnType<typeof getAdvancedSettings>>,
  departmentCount: number,
): EmbedBuilder {
  const priorityRoleCount = Object.keys(settings.priorityRoles).length;

  const closed =
    settings.retention.closedDays === 0
      ? 'Never'
      : settings.retention.closedDays + ' days';
  const archive =
    settings.retention.archiveDays === 0
      ? 'Never'
      : settings.retention.archiveDays + ' days';

  const claimed = settings.statusCategories.claimedCategoryId
    ? 'Configured'
    : 'Not configured';
  const pending = settings.statusCategories.pendingCategoryId
    ? 'Configured'
    : 'Not configured';

  return new EmbedBuilder()
    .setTitle(SETTINGS_TITLE)
    .setDescription(
      'Administrative control center for SupportForge.\n' +
        'Button-driven configuration • saved actions are audited with administrator + timestamp.\n' +
        'Use **Refresh** to re-read the latest persisted configuration.',
    )
    .addFields(
      {
        name: '🎛️ Panel',
        value:
          (settings.panelActivity.enabled ? 'Enabled' : 'Disabled') +
          ' • ' +
          settings.panelActivity.visualLineBudget +
          ' lines • ' +
          settings.panelActivity.messageBudget +
          ' message cap',
        inline: true,
      },
      {
        name: '🎟️ Ticket defaults',
        value: 'Priority: **' + settings.ticketDefaults.priority + '**',
        inline: true,
      },
      {
        name: '🏷️ Routing tags',
        value: '**' + departmentCount + '** configured',
        inline: true,
      },
      {
        name: '📂 Departments',
        value: '**' + departmentCount + '** configured',
        inline: true,
      },
      {
        name: '🎨 Priority rules',
        value: '**' + priorityRoleCount + '** role(s) explicitly created',
        inline: true,
      },
      {
        name: '🧹 Retention',
        value: 'Closed: **' + closed + '** • Archive: **' + archive + '**',
        inline: true,
      },
      {
        name: '🎨 Appearance',
        value: 'Panel title: **' + settings.appearance.panelTitle.slice(0, 80) + '**',
        inline: false,
      },
      {
        name: '📋 Configuration snapshot',
        value:
          '**Panel**: Automatic repositioning – ' +
          (settings.panelActivity.enabled ? 'Enabled' : 'Disabled') +
          '; Visual budget – ' +
          settings.panelActivity.visualLineBudget +
          ' lines; Message safety cap – ' +
          settings.panelActivity.messageBudget +
          '\n' +
          '**Ticket defaults**: Default priority – ' +
          settings.ticketDefaults.priority +
          '\n' +
          '**Priority roles**: Explicitly created roles – ' +
          priorityRoleCount +
          '\n' +
          '**Routing tags**: Configured routing tags – ' +
          departmentCount +
          (departmentCount ? '' : ' (none)') +
          '\n' +
          '**Retention**: Closed – ' +
          closed +
          '; Archived – ' +
          archive +
          '\n' +
          '**Optional status categories**: Claimed tickets – ' +
          claimed +
          '; Pending tickets – ' +
          pending,
        inline: false,
      },
    )
    .setFooter({
      text: 'SupportForge • Advanced Ticket Configuration',
    })
    .setTimestamp();
}

const SETTINGS_MESSAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isSettingsDashboardMessage(message: {
  author: { id: string };
  embeds: readonly { title?: string | null; footer?: { text?: string | null } | null }[];
  createdTimestamp: number;
}, botId: string): boolean {
  if (message.author.id !== botId) return false;

  return message.embeds.some(
    (embed) =>
      embed.title === SETTINGS_TITLE ||
      embed.footer?.text?.startsWith('SupportForge • Advanced Ticket Configuration'),
  );
}

function isLegacySmallSettingsDashboard(message: {
  embeds: readonly { title?: string | null; footer?: { text?: string | null } | null }[];
}): boolean {
  return message.embeds.some(
    (embed) =>
      embed.title === SETTINGS_TITLE &&
      embed.footer?.text?.startsWith('SupportForge • Select a section to configure it'),
  );
}

async function pruneSettingsHistory(channel: TextChannel): Promise<void> {
  const botId = channel.client.user?.id;
  if (!botId) return;

  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return;

  /*
   * Legacy small dashboards are intentionally replaced by the complete
   * dashboard, so they may be removed immediately. Everything else is
   * retained for seven days before cleanup. User-authored messages are never
   * deleted by this maintenance task.
   */
  const now = Date.now();
  const stale = [...messages.values()].filter(
    (message) =>
      isSettingsDashboardMessage(message, botId) &&
      !isLegacySmallSettingsDashboard(message) &&
      now - message.createdTimestamp >= SETTINGS_MESSAGE_MAX_AGE_MS,
  );

  await Promise.all(
    stale.map((message) => message.delete().catch(() => undefined)),
  );
}

async function refreshSettingsDashboard(
  channel: TextChannel,
  settings?: Awaited<ReturnType<typeof getAdvancedSettings>>,
): Promise<void> {
  const resolvedSettings =
    settings ?? (await getAdvancedSettings(channel.guild.id));
  const config = await getGuildConfig(channel.guild.id);
  const departmentCount = Object.keys(config.departments).length;
  const embed = buildSettingsDashboardEmbed(
    resolvedSettings,
    departmentCount,
  );

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const botId = channel.client.user?.id;

  const dashboards = recent && botId
    ? [...recent.values()].filter((message) =>
        isSettingsDashboardMessage(message, botId),
      )
    : [];

  /*
   * The current dashboard is intentionally touched, so it is updated in
   * place. We do not sweep unrelated messages merely because Refresh was
   * pressed. That history remains available for up to a week.
   */
  const dashboard = dashboards
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];

  if (dashboard) {
    await dashboard.edit({
      embeds: [embed],
      components: buildSettingsDashboardComponents(),
    });

    /*
     * The old compact dashboard format is explicitly obsolete. Remove only
     * those legacy settings blocks now; ordinary history is left alone.
     */
    await Promise.all(
      dashboards
        .filter(
          (message) =>
            message.id !== dashboard.id &&
            isLegacySmallSettingsDashboard(message),
        )
        .map((message) => message.delete().catch(() => undefined)),
    );
  } else {
    await channel.send({
      embeds: [embed],
      components: buildSettingsDashboardComponents(),
    });
  }

  await pruneSettingsHistory(channel);
}

export async function refreshSettingsChannel(guild: Guild): Promise<void> {
  const settings = await getAdvancedSettings(guild.id);
  if (!settings.settingsChannelId) return;

  const channel = guild.channels.cache.get(settings.settingsChannelId);
  if (channel?.type !== ChannelType.GuildText) return;

  await refreshSettingsDashboard(channel, settings);
}

/**
 * Restore the live settings dashboard to the bottom of the settings channel.
 *
 * A settings sub-view can leave an older dashboard near the top of the
 * channel. Restore should not merely edit that old message in place because
 * that leaves the administrative UI stranded above newer content.
 *
 * Keep the channel-purpose message because it explains what the channel is
 * for. Remove SupportForge's old dashboard messages, then post one fresh
 * dashboard at the bottom. User-authored messages are never deleted here.
 */
export async function restoreSettingsChannelToBottom(guild: Guild): Promise<void> {
  const settings = await getAdvancedSettings(guild.id);
  if (!settings.settingsChannelId) return;

  const channel = guild.channels.cache.get(settings.settingsChannelId);
  if (channel?.type !== ChannelType.GuildText) return;

  const botId = channel.client.user?.id;
  if (!botId) return;

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (recent) {
    const dashboardMessages = [...recent.values()].filter(
      (message) =>
        message.author.id === botId &&
        isSettingsDashboardMessage(message, botId),
    );

    await Promise.all(
      dashboardMessages.map((message) =>
        message.delete().catch(() => undefined),
      ),
    );
  }

  const resolvedSettings = await getAdvancedSettings(guild.id);
  const config = await getGuildConfig(guild.id);
  const departmentCount = Object.keys(config.departments).length;

  await channel.send({
    embeds: [
      buildSettingsDashboardEmbed(
        resolvedSettings,
        departmentCount,
      ),
    ],
    components: buildSettingsDashboardComponents(),
  });

  await pruneSettingsHistory(channel);
}
