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

import { getGuildConfig, type GuildTheme } from './configService';
import { getThemeColor, getThemeDefinition } from './uiThemeService';
import {
  getAdvancedSettings,
  SETTINGS_DASHBOARD_BUTTON_KEYS,
  type SettingsDashboardButtonKey,
} from './advancedSettingsService';
import { ensureChannelPurposeMessage } from './channelPurposeService';
import { logSystemEvent } from './auditLogService';
import { setChannelTopic } from './discordChannelService';
import { translate, type TranslationKey } from '../i18n/translationService';
import { applyQueryFixrBranding } from '../interactions/brandPresentation';

const SETTINGS_TOPIC_PREFIX = 'supportforge:settings';
const SETTINGS_TITLE = '⚙️ QueryFixr Settings';

function settingsButton(
  customId: string,
  label: string,
  style = ButtonStyle.Secondary,
  emoji?: string,
  disabled = false,
): ButtonBuilder {
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style);

  if (emoji) button.setEmoji(emoji);
  if (disabled) button.setDisabled(true);
  return button;
}

const SETTINGS_DASHBOARD_BUTTONS: Record<SettingsDashboardButtonKey, {
  customId: string;
  label: string;
  style: ButtonStyle;
  emoji: string;
}> = {
  panel: { customId: 'sf:settings:panel', label: 'Panel Automation', style: ButtonStyle.Primary, emoji: '🎛️' },
  defaults: { customId: 'sf:settings:defaults', label: 'Ticket Defaults', style: ButtonStyle.Secondary, emoji: '🎟️' },
  tags: { customId: 'sf:settings:tags', label: 'Tags / Departments', style: ButtonStyle.Secondary, emoji: '🏷️' },
  usecases: { customId: 'sf:settings:usecases', label: 'Use Cases', style: ButtonStyle.Secondary, emoji: '🧩' },
  reports: { customId: 'sf:settings:reports', label: 'Safety & Reports', style: ButtonStyle.Secondary, emoji: '🚩' },
  analytics: { customId: 'sf:settings:analytics', label: 'Analytics', style: ButtonStyle.Primary, emoji: '📊' },
  analytics: { customId: 'sf:settings:analytics', label: 'Analytics', style: ButtonStyle.Primary, emoji: '📊' },
  retention: { customId: 'sf:settings:retention', label: 'Retention', style: ButtonStyle.Secondary, emoji: '🧹' },
  inactivity: { customId: 'sf:settings:inactivity', label: 'Inactivity Automation', style: ButtonStyle.Primary, emoji: '⏳' },
  language: { customId: 'sf:settings:language', label: 'Server Language', style: ButtonStyle.Primary, emoji: '🌐' },
  appearance: { customId: 'sf:settings:appearance', label: 'Public Panel', style: ButtonStyle.Secondary, emoji: '🎨' },
  storage: { customId: 'sf:settings:storage', label: 'Storage', style: ButtonStyle.Secondary, emoji: '🗄️' },
  rules: { customId: 'sf:settings:rules', label: 'Rules & Roles', style: ButtonStyle.Secondary, emoji: '🛡️' },
  repair: { customId: 'sf:settings:repair', label: 'Repair System', style: ButtonStyle.Secondary, emoji: '🛠️' },
  team: { customId: 'sf:settings:team', label: 'Team & Voice', style: ButtonStyle.Secondary, emoji: '👥' },
  manual: { customId: 'sf:settings:manual', label: 'Manual', style: ButtonStyle.Secondary, emoji: '📖' },
  forms: { customId: 'sf:settings:forms:home', label: 'Ticket Forms', style: ButtonStyle.Primary, emoji: '🧾' },
  refresh: { customId: 'sf:settings:refresh', label: 'Refresh', style: ButtonStyle.Secondary, emoji: '🔄' },
  reset: { customId: 'sf:settings:reset', label: 'Delete Everything', style: ButtonStyle.Danger, emoji: '🚨' },
  theme: { customId: 'sf:settings:theme', label: 'Server Theme', style: ButtonStyle.Primary, emoji: '🌈' },
  premium: { customId: 'sf:settings:premium', label: 'Premium & Demo', style: ButtonStyle.Secondary, emoji: '💎' },
  panels: { customId: 'sf:settings:panels:home', label: 'Ticket Panels', style: ButtonStyle.Primary, emoji: '🧱' },
  'dashboard-builder': { customId: 'sf:settings:dashboard-builder', label: 'Settings Layout', style: ButtonStyle.Primary, emoji: '🧰' },
  'support-hours': { customId: 'sf:settings:support-hours', label: 'Support Hours', style: ButtonStyle.Primary, emoji: '🕒' },
  'ticket-workspace': { customId: 'sf:settings:ticket-workspace', label: 'Ticket Workspace', style: ButtonStyle.Primary, emoji: '🧵' },
};

const SETTINGS_LABEL_KEYS: Record<SettingsDashboardButtonKey, TranslationKey> = {
  panel: 'settings.nav.panel',
  defaults: 'settings.nav.defaults',
  tags: 'settings.nav.tags',
  usecases: 'settings.nav.usecases',
  reports: 'settings.nav.reports',
  analytics: 'settings.nav.analytics',
  analytics: 'settings.nav.analytics',
  retention: 'settings.nav.retention',
  inactivity: 'settings.nav.inactivity',
  language: 'settings.nav.language',
  appearance: 'settings.nav.appearance',
  storage: 'settings.nav.storage',
  rules: 'settings.nav.rules',
  repair: 'settings.nav.repair',
  team: 'settings.nav.team',
  manual: 'settings.nav.manual',
  forms: 'settings.nav.forms',
  refresh: 'settings.nav.refresh',
  reset: 'settings.nav.reset',
  theme: 'settings.nav.theme',
  premium: 'settings.nav.premium',
  panels: 'settings.nav.panels',
  'dashboard-builder': 'settings.nav.dashboardBuilder',
  'support-hours': 'settings.nav.supportHours',
  'ticket-workspace': 'settings.nav.ticketWorkspace',
};

/** Per-server order is customizable, but every built-in control remains available. */
export function buildSettingsDashboardComponents(
  settings?: Awaited<ReturnType<typeof getAdvancedSettings>>,
  disabled = false,
): ActionRowBuilder<ButtonBuilder>[] {
  const requested = settings?.settingsDashboard?.buttonOrder ?? [...SETTINGS_DASHBOARD_BUTTON_KEYS];
  const order: SettingsDashboardButtonKey[] = [];
  for (const key of requested) {
    if ((SETTINGS_DASHBOARD_BUTTON_KEYS as readonly string[]).includes(key) && !order.includes(key)) {
      order.push(key as SettingsDashboardButtonKey);
    }
  }
  for (const key of SETTINGS_DASHBOARD_BUTTON_KEYS) {
    if (!order.includes(key)) order.push(key);
  }
  const buttons = order.map((key) => {
    const item = SETTINGS_DASHBOARD_BUTTONS[key];
    const customization = settings?.settingsDashboard?.buttonCustomizations?.[key];
    const label = customization?.label ?? translate(settings?.locale, SETTINGS_LABEL_KEYS[key]);
    const emoji = customization ? customization.emoji ?? undefined : item.emoji;
    // Semantic styles are intentionally not editable: delete stays destructive,
    // and navigation/recovery actions retain the built-in safe styling.
    return settingsButton(item.customId, label, item.style, emoji, disabled);
  });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(index, index + 5)));
  }
  return rows;
}

export async function ensureSettingsChannel(
  guild: Guild,
  parentId: string,
): Promise<TextChannel> {
  const settings = await getAdvancedSettings(guild.id);
  const bot = guild.members.me;

  if (!bot) {
    throw new Error('QueryFixr bot member could not be resolved.');
  }

  const parent = guild.channels.cache.get(parentId);
  if (parent?.type !== ChannelType.GuildCategory) {
    throw new Error(
      'QueryFixr Settings destination category does not exist or is not a category.',
    );
  }

  let channel: TextChannel | undefined;

  if (settings.settingsChannelId) {
    const saved = guild.channels.cache.get(settings.settingsChannelId);
    if (saved?.type === ChannelType.GuildText) {
      channel = saved;
    }
  }

  let created = !channel;

  if (!channel) {
    const existing = guild.channels.cache.find(
      (candidate) =>
        candidate.type === ChannelType.GuildText &&
        candidate.topic?.startsWith(SETTINGS_TOPIC_PREFIX),
    );

    if (existing?.type === ChannelType.GuildText) {
      channel = existing;
      created = false;
    } else {
      channel = await guild.channels.create({
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
  }

  await setChannelTopic(
    channel.id,
    SETTINGS_TOPIC_PREFIX + ' guild=' + guild.id,
    'QueryFixr settings channel metadata normalization',
  ).catch((error) => {
    throw new Error(
      'QueryFixr Settings channel metadata could not be repaired.',
      { cause: error },
    );
  });

  if (channel.parentId !== parentId) {
    await channel.setParent(
      parentId,
      { lockPermissions: false },
    );
  }

  for (const department of Object.values(
    (await getGuildConfig(guild.id)).departments,
  )) {
    if (!department.staffRoleId) continue;

    try {
      await channel.permissionOverwrites.edit(
        department.staffRoleId,
        {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: false,
        },
      );
    } catch (error) {
      console.warn(
        '⚠️ Could not grant Settings access to department role ' +
          department.staffRoleId +
          ':',
        error,
      );
    }
  }

  await channel.permissionOverwrites.edit(
    guild.roles.everyone.id,
    {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false,
    },
  );

  await channel.permissionOverwrites.edit(
    bot.id,
    {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      EmbedLinks: true,
    },
  );

  const currentSettings = await getAdvancedSettings(guild.id);

  const purposeMessage =
    'This private channel is QueryFixr’s administrative control center. Use the buttons here to configure tickets, routing tags/departments, retention, appearance, storage, rules, roles, repairs, and other server-level QueryFixr settings.';

  await ensureChannelPurposeMessage(channel, purposeMessage);

  await refreshSettingsDashboard(channel, currentSettings);

  if (created) {
    const config = await getGuildConfig(guild.id);
    if (config.supportCategoryId) {
      void logSystemEvent(
        guild,
        config.supportCategoryId,
        'CHANNEL_CREATED',
        'Created QueryFixr Settings channel ' + channel.name + ' (' + channel.id + ').',
      ).catch(() => undefined);
    }
  }

  return channel;
}

export function buildSettingsDashboardEmbed(
  settings: Awaited<ReturnType<typeof getAdvancedSettings>>,
  departmentCount: number,
  tagCount: number,
  theme: GuildTheme = 'midnight',
): EmbedBuilder {
  const priorityRoleCount = Object.keys(settings.priorityRoles).length;
  const themeInfo = getThemeDefinition(theme);

  const closed =
    settings.retention.closedDays === 0
      ? translate(settings.locale, 'settings.value.noTimer')
      : translate(settings.locale, 'settings.value.days', { count: settings.retention.closedDays });
  const archive =
    settings.retention.archiveDays === 0
      ? translate(settings.locale, 'settings.value.noTimer')
      : translate(settings.locale, 'settings.value.days', { count: settings.retention.archiveDays });

  const claimed = settings.statusCategories.claimedCategoryId
    ? translate(settings.locale, 'settings.value.configured')
    : translate(settings.locale, 'settings.value.notConfigured');
  const pending = settings.statusCategories.pendingCategoryId
    ? translate(settings.locale, 'settings.value.configured')
    : translate(settings.locale, 'settings.value.notConfigured');
  const priorityLabels: Record<'low' | 'normal' | 'high' | 'urgent' | 'critical', TranslationKey> = {
    low: 'priority.low',
    normal: 'priority.normal',
    high: 'priority.high',
    urgent: 'priority.urgent',
    critical: 'priority.critical',
  };
  const priorityLabel = translate(settings.locale, priorityLabels[settings.ticketDefaults.priority]);

  return applyQueryFixrBranding(new EmbedBuilder(), 'Support Control Center', getThemeColor(theme))
    .setTitle(
      !settings.settingsDashboard.title || settings.settingsDashboard.title === SETTINGS_TITLE
        ? '⚙️ ' + translate(settings.locale, 'settings.title')
        : settings.settingsDashboard.title,
    )
    .setDescription(
      ((
        settings.settingsDashboard.description === ('Configure your server' + String.fromCharCode(0x2019) + 's ticket system, support panels and retention policies.')
          ? translate(settings.locale, 'settings.dashboard.description')
          : settings.settingsDashboard.description || translate(settings.locale, 'settings.dashboard.description')
      ) + '\n\n' + translate(settings.locale, 'settings.dashboard.help')).slice(0, 3900),
    )
    .addFields(
      {
        name: '🎛️ ' + translate(settings.locale, 'settings.dashboard.field.panel'),
        value: (settings.panelActivity.enabled ? '🟢 ' + translate(settings.locale, 'common.enabled') : '⚪ ' + translate(settings.locale, 'common.disabled')) +
          '\n' + translate(settings.locale, 'settings.value.panelBudget', {
            lines: settings.panelActivity.visualLineBudget,
            cap: settings.panelActivity.messageBudget,
          }),
        inline: true,
      },
      {
        name: '🎟️ ' + translate(settings.locale, 'settings.dashboard.field.ticketDefaults'),
        value: translate(settings.locale, 'settings.value.priority', { priority: priorityLabel }),
        inline: true,
      },
      {
        name: '🏷️ ' + translate(settings.locale, 'settings.dashboard.field.routingTags'),
        value: translate(settings.locale, 'settings.value.countConfigured', { count: tagCount }),
        inline: true,
      },
      {
        name: '📂 ' + translate(settings.locale, 'settings.dashboard.field.departments'),
        value: translate(settings.locale, 'settings.value.countConfigured', { count: departmentCount }),
        inline: true,
      },
      {
        name: '🎨 ' + translate(settings.locale, 'settings.dashboard.field.priorityRules'),
        value: translate(settings.locale, 'settings.value.createdRoles', { count: priorityRoleCount }),
        inline: true,
      },
      {
        name: '🧹 ' + translate(settings.locale, 'settings.dashboard.field.retention'),
        value: translate(settings.locale, 'settings.value.retention', { closed, archive }),
        inline: true,
      },
      {
        name: '⏳ ' + translate(settings.locale, 'settings.dashboard.field.inactivity'),
        value: (settings.inactivity.enabled ? '🟢 ' + translate(settings.locale, 'common.enabled') : '⚪ ' + translate(settings.locale, 'common.disabled')) +
          '\n' + translate(settings.locale, 'settings.value.inactivity', {
            idle: settings.inactivity.idleHours,
            grace: settings.inactivity.graceHours,
          }),
        inline: true,
      },
      {
        name: '🧵 ' + translate(settings.locale, 'settings.dashboard.field.ticketWorkspace'),
        value: translate(settings.locale, settings.ticketWorkspace.mode === 'private-threads'
          ? 'settings.value.privateThreads'
          : 'settings.value.privateTextChannels'),
        inline: true,
      },
      {
        name: '🎨 ' + translate(settings.locale, 'settings.dashboard.field.appearance'),
        value: translate(settings.locale, 'settings.value.panelTitle', {
          title: settings.appearance.panelTitle.slice(0, 80),
        }),
        inline: true,
      },
      {
        name: '🌈 ' + translate(settings.locale, 'settings.dashboard.field.serverTheme'),
        value: '**' + themeInfo.label + '**\n' + themeInfo.description,
        inline: true,
      },
      {
        name: '📋 ' + translate(settings.locale, 'settings.dashboard.field.configurationSnapshot'),
        value: [
          translate(settings.locale, 'settings.value.snapshot.panel', {
            status: translate(settings.locale, settings.panelActivity.enabled ? 'common.enabled' : 'common.disabled'),
            lines: settings.panelActivity.visualLineBudget,
            cap: settings.panelActivity.messageBudget,
          }),
          translate(settings.locale, 'settings.value.snapshot.defaults', { priority: priorityLabel }),
          translate(settings.locale, 'settings.value.snapshot.priorityRoles', { count: priorityRoleCount }),
          translate(settings.locale, 'settings.value.snapshot.tags', {
            count: tagCount,
            suffix: tagCount ? '' : translate(settings.locale, 'settings.value.noneSuffix'),
          }),
          translate(settings.locale, 'settings.value.snapshot.retention', { closed, archive }),
          translate(settings.locale, 'settings.value.snapshot.inactivity', {
            status: translate(settings.locale, settings.inactivity.enabled ? 'common.enabled' : 'common.disabled'),
            idle: settings.inactivity.idleHours,
            grace: settings.inactivity.graceHours,
          }),
          translate(settings.locale, 'settings.value.snapshot.workspace', {
            workspace: translate(settings.locale, settings.ticketWorkspace.mode === 'private-threads'
              ? 'settings.value.privateThreads'
              : 'settings.value.privateTextChannels'),
          }),
          translate(settings.locale, 'settings.value.snapshot.statusCategories', { claimed, pending }),
        ].join('\n').slice(0, 3900),
        inline: false,
      },
    )
    .setFooter({
      // Stable suffix lets cleanup find this dashboard when a server customizes its visible footer.
      text: (settings.settingsDashboard.footer || 'Settings for this server').slice(0, 1600) + ' • QueryFixr Settings Dashboard • ' + themeInfo.label + ' theme',
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
      embed.footer?.text?.includes('QueryFixr Settings Dashboard') ||
      embed.footer?.text?.includes('ResolvX Settings Dashboard') ||
      embed.footer?.text?.includes('ResolveX Settings Dashboard') ||
      embed.footer?.text?.includes('SupportForge Settings Dashboard') ||
      embed.title === SETTINGS_TITLE ||
      embed.title === '⚙️ SupportForge Settings' ||
      embed.footer?.text?.startsWith('QueryFixr • Advanced Ticket Configuration') ||
      embed.footer?.text?.startsWith('ResolvX • Advanced Ticket Configuration') ||
      embed.footer?.text?.startsWith('SupportForge • Advanced Ticket Configuration'),
  );
}

function isSettingsPurposeMessage(
  message: {
    author: { id: string };
    embeds: readonly {
      title?: string | null;
      footer?: { text?: string | null } | null;
    }[];
  },
  botId: string,
): boolean {
  return message.author.id === botId &&
    message.embeds.some(
      (embed) =>
        (((embed.title === '📝 QueryFixr Channel Purpose' || embed.title === '📝 ResolvX Channel Purpose') &&
          (embed.footer?.text === 'QueryFixr • Channel Purpose' || embed.footer?.text === 'ResolvX • Channel Purpose')) ||
          (embed.title === '📝 SupportForge Channel Purpose' &&
          embed.footer?.text === 'SupportForge • Channel Purpose')),
    );
}

function isLegacySmallSettingsDashboard(message: {
  embeds: readonly { title?: string | null; footer?: { text?: string | null } | null }[];
}): boolean {
  return message.embeds.some(
    (embed) =>
      (embed.title === SETTINGS_TITLE || embed.title === '⚙️ SupportForge Settings') &&
      (embed.footer?.text?.startsWith('QueryFixr • Select a section to configure it') ||
        embed.footer?.text?.startsWith('ResolvX • Select a section to configure it') ||
        embed.footer?.text?.startsWith('SupportForge • Select a section to configure it')),
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
  const tagCount = Object.values(config.departments).reduce(
    (total, department) => total + Object.keys(department.tags ?? {}).length,
    0,
  );
  const embed = buildSettingsDashboardEmbed(
    resolvedSettings,
    departmentCount,
    tagCount,
    config.theme,
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
      components: buildSettingsDashboardComponents(resolvedSettings),
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
      components: buildSettingsDashboardComponents(settings),
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
 * for. Remove QueryFixr's old dashboard messages, then post one fresh
 * dashboard at the bottom. User-authored messages are never deleted here.
 */
export async function restoreSettingsChannelToBottom(guild: Guild): Promise<void> {
  const settings = await getAdvancedSettings(guild.id);
  if (!settings.settingsChannelId) return;

  const channel = guild.channels.cache.get(settings.settingsChannelId);
  if (channel?.type !== ChannelType.GuildText) return;

  /*
   * Restore-to-settings must restore the dashboard without deleting the
   * dashboard itself. The previous implementation swept the whole channel
   * and recreated the panel, which made the live Settings panel appear to
   * vanish when the user clicked its navigation controls.
   *
   * Keep the newest real dashboard intact, remove only QueryFixr's
   * temporary/sub-view messages, and create a dashboard only when one is
   * genuinely missing. User-authored messages are never touched here.
   */
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const botId = channel.client.user?.id;

  if (!recent || !botId) {
    await refreshSettingsDashboard(channel, settings);
    return;
  }

  const dashboards = [...recent.values()]
    .filter((message) => isSettingsDashboardMessage(message, botId))
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  const dashboard = dashboards[0];

  const removable = [...recent.values()].filter(
    (message) =>
      message.author.id === botId &&
      message.id !== dashboard?.id &&
      !isSettingsDashboardMessage(message, botId) &&
      !isSettingsPurposeMessage(message, botId),
  );

  /*
   * Only QueryFixr-authored transient messages are cleared. The current
   * dashboard remains the same Discord message, preserving its buttons,
   * position and message identity.
   */
  await Promise.all(
    removable.map((message) =>
      message.delete().catch((error) => {
        console.warn(
          `⚠️ Could not remove temporary Settings message ${message.id}:`,
          error,
        );
      }),
    ),
  );

  if (dashboard) {
    const resolvedSettings = await getAdvancedSettings(guild.id);
    const config = await getGuildConfig(guild.id);
    await dashboard.edit({
      embeds: [
        buildSettingsDashboardEmbed(
          resolvedSettings,
          Object.keys(config.departments).length,
          Object.values(config.departments).reduce(
            (total, department) => total + Object.keys(department.tags ?? {}).length,
            0,
          ),
        ),
      ],
      components: buildSettingsDashboardComponents(resolvedSettings),
    });
  } else {
    await channel.send({
      embeds: [
        buildSettingsDashboardEmbed(
          settings,
          Object.keys((await getGuildConfig(guild.id)).departments).length,
          Object.values((await getGuildConfig(guild.id)).departments).reduce(
            (total, department) => total + Object.keys(department.tags ?? {}).length,
            0,
          ),
        ),
      ],
      components: buildSettingsDashboardComponents(settings),
    });
  }

  await pruneSettingsHistory(channel);

  console.log(
    `📌 Restored QueryFixr Settings navigation without deleting the live dashboard: ${channel.id}`,
  );
}