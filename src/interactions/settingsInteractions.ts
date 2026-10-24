import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  RoleSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type ModalSubmitInteraction,
} from 'discord.js';

import {
  getGuildConfig,
  getTier,
  setTier,
  tierLabel,
  newDepartmentId,
  newTagId,
  updateGuildConfig,
} from '../services/configService';

import {
  getAdvancedSettings,
  updateAdvancedSettings,
  SETTINGS_DASHBOARD_BUTTON_KEYS,
  type SettingsDashboardButtonKey,
  type TicketPriority,
} from '../services/advancedSettingsService';
import { LOCALE_OPTIONS, getLocaleLabel, isSupportedLocale } from '../i18n/localeRegistry';
import { translate, type TranslationKey } from '../i18n/translationService';
import { buildSystemDiagnosticsEmbed, diagnosticsPageCount, runSystemDiagnostics } from '../services/systemDiagnosticsService';
import {
  assertCurrentConfigurationFingerprint,
  createConfigurationSnapshot,
  getConfigurationSnapshot,
  listConfigurationSnapshots,
  reviewConfigurationSnapshot,
  restoreConfigurationSnapshot,
} from '../services/configurationHistoryService';

import {
  buildSettingsDashboardComponents,
  refreshSettingsChannel,
  ensureSettingsChannel,
  buildSettingsDashboardEmbed,
  restoreSettingsChannelToBottom,
} from '../services/settingsChannelService';

import {
  ensureArchiveCategory,
  ensureClosedCategory,
  ensureOptionalStatusCategory,
  getOptionalStatusCategory,
} from '../services/ticketStorageService';

import {
  ensureAllDepartmentCategories,
} from '../services/departmentCategoryService';

import { ensureAuditDeveloperInfrastructure, logSettingsEvent, refreshAuditPanelTheme, logTicketEvent, logSystemEvent } from '../services/auditLogService';
import { requestGitHubDeployment } from '../services/updateService';
import { getField, getTicketStatus, setField } from '../services/ticketStateService';
import { migrateDepartmentStaffRole } from '../services/departmentStaffRoleService';
import { getPersistedTicket, getPersistedTicketById, getPersistedTicketStatus } from '../services/ticketPersistenceService';
import { performFactoryReset } from '../services/factoryResetService';
import { addUseCasePreset, USE_CASE_PRESETS } from '../services/useCasePresetService';
import { enforcePriorityRoleHierarchy } from '../services/priorityRoleService';
import { UI_THEMES, getThemeColor, getThemeDefinition, isGuildTheme } from '../services/uiThemeService';
import {
  createDefaultSupportHoursPolicy,
  deleteSupportHoursPolicy,
  evaluateSupportHours,
  formatSupportHoursInstant,
  formatSupportHoursWeeklySchedule,
  getSupportHoursPolicy,
  getSupportHoursPolicies,
  resolveEffectiveSupportHoursPolicy,
  parseSupportHoursWeeklySchedule,
  saveSupportHoursPolicy,
  SUPPORT_HOURS_DAYS,
  type SupportHoursScopeType,
  type SupportHoursContext,
} from '../services/supportHoursService';
import { normalizeDiscordEmoji } from '../core/domain/discordEmoji';
import { handleTicketFormSettingsInteraction } from './ticketFormSettingsInteractions';
import { handleCustomPanelSettingsInteraction } from './customPanelSettingsInteractions';
import {
  answerTicketDeletionReview,
  getTicketRecoveryPreview,
  listTicketRecoveryCandidates,
  restoreArchivedTicket,
  type TicketRecoveryCandidate,
} from '../services/ticketArchiveService';
import {
  approveRetentionDeletion,
  declineRetentionDeletion,
  getEligibleRetentionTickets,
  runRetentionSweepForGuild,
} from '../services/ticketRetentionService';
import { clearTicketInactivityWarningsForGuild } from '../services/ticketInactivityService';

import {
  ensureContainer,
  ensurePanelChannel,
  ensureTranscriptChannel,
  syncPanel,
  runSupportForgeSetup,
  runSupportForgeRepair,
} from '../commands/supportforge';

const SETTINGS_TOPIC_PREFIX = 'supportforge:settings';

type SettingsViewInteraction = ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction;

function isAdministrator(interaction: ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ModalSubmitInteraction): boolean {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
  );
}

const PRIORITY_ROLE_DEFINITIONS: Record<TicketPriority, { label: string; emoji: string; color: number }> = {
  low: { label: 'Low', emoji: '🟢', color: 0x2ecc71 },
  normal: { label: 'Normal', emoji: '🟡', color: 0xf1c40f },
  high: { label: 'High', emoji: '🟠', color: 0xe67e22 },
  urgent: { label: 'Urgent', emoji: '🔴', color: 0xe74c3c },
  critical: { label: 'Critical', emoji: '🟣', color: 0x9b59b6 },
};

async function isDepartmentStaff(interaction: ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild) return false;
  const roleIds = new Set(
    Object.values((await getGuildConfig(guild.id)).departments)
      .map((department) => department.staffRoleId)
      .filter((id): id is string => Boolean(id)),
  );
  if (roleIds.size === 0) return false;
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  return Boolean(member?.roles.cache.some((role) => roleIds.has(role.id)));
};

function manualQuickEmbed(locale: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(translate(locale, 'settings.manual.quick.title'))
    .setDescription(translate(locale, 'settings.manual.quick.content'))
    .setFooter({ text: translate(locale, 'settings.manual.quick.footer') })
    .setTimestamp();
}

function manualDetailedEmbeds(locale: string): EmbedBuilder[] {
  return [
    new EmbedBuilder()
      .setTitle(translate(locale, 'settings.manual.detailed.page1.title'))
      .setDescription(translate(locale, 'settings.manual.detailed.page1.content'))
      .setFooter({ text: translate(locale, 'settings.manual.detailed.page1.footer') })
      .setTimestamp(),
    new EmbedBuilder()
      .setTitle(translate(locale, 'settings.manual.detailed.page2.title'))
      .setDescription(translate(locale, 'settings.manual.detailed.page2.content'))
      .setFooter({ text: translate(locale, 'settings.manual.detailed.page2.footer') })
      .setTimestamp(),
  ];
}

function priorityRoleLabel(priority: TicketPriority): string {
  return PRIORITY_ROLE_DEFINITIONS[priority].label;
}

function findPriorityRole(
  guild: Guild,
  _priority: TicketPriority,
  configuredRoleId?: string,
) {
  // A matching display name is not ownership proof. Only the saved role ID
  // identifies a ResolvX-managed priority role.
  if (!configuredRoleId) return undefined;
  const configured = guild.roles.cache.get(configuredRoleId);
  return configured && !configured.managed ? configured : undefined;
}

const pendingResetAuditChoice = new Map<string, boolean>();

async function showManual(interaction: SettingsViewInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('📖 ' + translate(settings.locale, 'settings.manual.title'))
      .setDescription(translate(settings.locale, 'settings.manual.description'))
      .addFields(
        {
          name: translate(settings.locale, 'settings.manual.field.quick'),
          value: translate(settings.locale, 'settings.manual.value.quick'),
          inline: true,
        },
        {
          name: translate(settings.locale, 'settings.manual.field.detailed'),
          value: translate(settings.locale, 'settings.manual.value.detailed'),
          inline: true,
        },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:manual:quick')
        .setLabel(translate(settings.locale, 'settings.manual.action.quick'))
        .setEmoji('⚡').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sf:settings:manual:detailed')
        .setLabel(translate(settings.locale, 'settings.manual.action.detailed'))
        .setEmoji('📚').setStyle(ButtonStyle.Secondary),
      backButton(),
    ),
  ]);
}


async function showManualVersion(interaction: ButtonInteraction, detailed: boolean): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  await interaction.reply({
    embeds: detailed ? manualDetailedEmbeds(settings.locale) : [manualQuickEmbed(settings.locale)],
    flags: MessageFlags.Ephemeral,
  });
}

async function showPriorityRules(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const priorities = Object.keys(PRIORITY_ROLE_DEFINITIONS) as TicketPriority[];

  const lines = priorities.map((priority) => {
    const role = findPriorityRole(
      interaction.guild!,
      priority,
      settings.priorityRoles[priority],
    );

    return (
      PRIORITY_ROLE_DEFINITIONS[priority].emoji +
      ' **' +
      PRIORITY_ROLE_DEFINITIONS[priority].label +
      '** • ' +
      (role
        ? role.toString()
        : 'No role created')
    );
  });

  const controls = priorities.map((priority) => {
    const role = findPriorityRole(
      interaction.guild!,
      priority,
      settings.priorityRoles[priority],
    );

    return new ButtonBuilder()
      .setCustomId(
        'sf:settings:rules:' +
          (role ? 'delete:' : 'create:') +
          priority,
      )
      .setLabel(
        (role ? 'Delete ' : 'Create ') +
          PRIORITY_ROLE_DEFINITIONS[priority].label +
          ' Role',
      )
      .setEmoji(PRIORITY_ROLE_DEFINITIONS[priority].emoji)
      .setStyle(role ? ButtonStyle.Danger : ButtonStyle.Secondary);
  });

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🎨 Priority Rules & Roles')
      .setDescription(
        'Priority roles are optional server rules. **Nothing is created automatically.** Choose a priority to create its role, or delete an existing ResolvX priority role. ResolvX will not fail the whole rule operation just because Discord refuses a role-hierarchy reorder.',
      )
      .addFields({
        name: 'Current priority rules',
        value: lines.join('\n'),
      }),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(...controls),
    new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()),
  ]);
}

async function createPriorityRole(interaction: ButtonInteraction, priority: TicketPriority): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await reject(interaction, '❌ Creating priority roles requires the **Administrator** permission.');
    return;
  }

  const botMember =
    interaction.guild!.members.me ??
    await interaction.guild!.members.fetchMe().catch(() => null);

  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await reject(
      interaction,
      '❌ ResolvX needs **Manage Roles** to create priority roles. Discord does not allow a bot to grant itself that permission.',
    );
    return;
  }

  const existingSettings = await getAdvancedSettings(interaction.guild!.id);
  const configuredRoleId = existingSettings.priorityRoles[priority];
  const existingRole = findPriorityRole(
    interaction.guild!,
    priority,
    configuredRoleId,
  );

  if (existingRole) {
    await interaction.reply({
      content:
        'ℹ️ The ' +
        priorityRoleLabel(priority) +
        ' priority role already exists: ' +
        existingRole.toString(),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const definition = PRIORITY_ROLE_DEFINITIONS[priority];
    const role = await interaction.guild!.roles.create({
      name: 'ResolvX • ' + definition.label + ' Tickets',
      colors: {
        primaryColor: definition.color,
      },
      mentionable: false,
      reason: 'ResolvX administrator-created priority rule',
    });

    await updateAdvancedSettings(interaction.guild!.id, (settings) => {
      settings.priorityRoles[priority] = role.id;
    });

    // Reordering is useful but not required for the rule itself. Discord may
    // reject hierarchy changes with 50013 even though role creation succeeds.
    await enforcePriorityRoleHierarchy(interaction.guild!);

    await refreshSettingsChannel(interaction.guild!);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ Priority Role Created')
          .setDescription(
            definition.emoji +
              ' **' +
              definition.label +
              '** tickets can now use ' +
              role.toString() +
              '.',
          ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()),
      ],
    });

    await auditSettingsAction(
      interaction.guild!,
      interaction,
      'PRIORITY_ROLE_CREATED',
      'Created ' + role.name + ' for ' + priority + ' priority.',
    );
  } catch (error) {
    console.error('❌ Priority role creation failed:', error);
    await interaction.editReply(
      '❌ ResolvX could not create that priority role. Check that the bot can Manage Roles and that its role is above the target role.',
    );
  }
}

async function deletePriorityRole(
  interaction: ButtonInteraction,
  priority: TicketPriority,
): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await reject(
      interaction,
      '❌ Deleting priority roles requires the **Administrator** permission.',
    );
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const settings = await getAdvancedSettings(interaction.guild!.id);
    const role = findPriorityRole(
      interaction.guild!,
      priority,
      settings.priorityRoles[priority],
    );

    if (!role) {
      await updateAdvancedSettings(interaction.guild!.id, (current) => {
        delete current.priorityRoles[priority];
      });
      await interaction.editReply(
        'ℹ️ No ' +
          priorityRoleLabel(priority) +
          ' priority role exists. The stale ResolvX configuration was cleared.',
      );
      await auditSettingsAction(
        interaction.guild!,
        interaction,
        'PRIORITY_ROLE_CLEANED',
        'Cleared stale configuration for missing ' + priority + ' priority role.',
      );
      return;
    }

    const botMember =
      interaction.guild!.members.me ??
      await interaction.guild!.members.fetchMe().catch(() => null);

    if (!role.editable || role.managed || !botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await auditSettingsAction(
        interaction.guild!,
        interaction,
        'PRIORITY_ROLE_DELETE_FAILED',
        'Could not delete ' +
          role.name +
          ' because Discord role hierarchy/permissions do not permit the bot to manage it.',
      );
      await interaction.editReply(
        '❌ Discord will not let ResolvX delete ' +
          role.toString() +
          '. Move the ResolvX bot role above this role and ensure it has **Manage Roles**, then try again.',
      );
      return;
    }

    await role.delete('ResolvX administrator deleted priority rule role');

    await updateAdvancedSettings(interaction.guild!.id, (current) => {
      delete current.priorityRoles[priority];
    });

    await refreshSettingsChannel(interaction.guild!);
    await enforcePriorityRoleHierarchy(interaction.guild!);

    await interaction.editReply(
      '✅ Deleted the ' +
        priorityRoleLabel(priority) +
        ' priority role.',
    );

    await auditSettingsAction(
      interaction.guild!,
      interaction,
      'PRIORITY_ROLE_DELETED',
      'Deleted ' + role.name + ' for ' + priority + ' priority.',
    );
  } catch (error) {
    console.error('❌ Priority role deletion failed:', error);
    await interaction.editReply(
      '❌ ResolvX could not delete that priority role. Discord may be preventing the bot from managing it because of the role hierarchy.',
    );
  }
}
function isSettingsChannel(interaction: ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ModalSubmitInteraction): boolean {
  return interaction.channel?.type === ChannelType.GuildText &&
    Boolean(interaction.channel.topic?.startsWith(SETTINGS_TOPIC_PREFIX));
}

async function reject(interaction: ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ModalSubmitInteraction, content: string): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply(content).catch(() => undefined);
    return;
  }

  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  }).catch(() => undefined);
}

function backButton(): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId('sf:settings:home')
    .setLabel('Restore to Settings')
    .setEmoji('↩️')
    .setStyle(ButtonStyle.Secondary);
}

async function restoreSettingsHome(
  interaction: SettingsViewInteraction,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;

  /*
   * Restore can be clicked from either a persistent settings message or an
   * ephemeral settings sub-view. A component interaction must be acknowledged
   * within Discord's short interaction window, so acknowledge it first and do
   * the slower channel refresh afterwards.
   */
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate();
  }

  /*
   * Do not delete the message that contains the Restore to Settings button.
   * The channel restore routine preserves the live dashboard itself. If the
   * clicked control came from an ephemeral settings sub-view, simply replace
   * that ephemeral view with a small confirmation instead of deleting it.
   */
  await restoreSettingsChannelToBottom(guild);

  if (isEphemeralSettingsMessage(interaction as ButtonInteraction)) {
    await interaction.editReply({
      content: '✅ Restored the Settings view. The live Settings panel remains intact.',
      embeds: [],
      components: [],
    }).catch(() => undefined);
  }
}

function isEphemeralSettingsMessage(interaction: ButtonInteraction): boolean {
  return interaction.message.flags.has(MessageFlags.Ephemeral);
}

async function renderSettingsView(
  interaction: SettingsViewInteraction,
  embeds: EmbedBuilder[],
  components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<RoleSelectMenuBuilder>>,
): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const themedEmbeds = embeds.map((embed) => embed.setColor(getThemeColor(config.theme)));
  const payload = { embeds: themedEmbeds, components };

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply(payload);
    return;
  }

  if (interaction.isButton() && isEphemeralSettingsMessage(interaction)) {
    await interaction.deferUpdate();
    await interaction.editReply(payload);
    return;
  }

  await interaction.reply({
    ...payload,
    flags: MessageFlags.Ephemeral,
  });
}

async function auditSettingsAction(
  guild: Guild,
  interaction: ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ModalSubmitInteraction,
  action: string,
  detail: string,
): Promise<void> {
  const config = await getGuildConfig(guild.id);
  if (!config.supportCategoryId) return;

  void logSettingsEvent(guild, config.supportCategoryId, {
    action,
    actorId: interaction.user.id,
    actorName: interaction.user.tag,
    detail,
  }).catch((error) => {
    console.warn('⚠️ Settings audit logging failed:', error);
  });
}

async function showHome(interaction: SettingsViewInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const config = await getGuildConfig(interaction.guild!.id);

  await renderSettingsView(
    interaction,
    [
      buildSettingsDashboardEmbed(
        settings,
        Object.keys(config.departments).length,
        Object.values(config.departments).reduce(
          (total, department) => total + Object.keys(department.tags ?? {}).length,
          0,
        ),
        config.theme,
      ),
    ],
    buildSettingsDashboardComponents(settings),
  );
}

async function showLanguageSettings(interaction: SettingsViewInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;
  const settings = await getAdvancedSettings(guild.id);
  const picker = new StringSelectMenuBuilder()
    .setCustomId('sf:settings:language:select')
    .setPlaceholder(translate(settings.locale, 'settings.locale.title').slice(0, 150))
    .addOptions(LOCALE_OPTIONS.map((locale) => ({
      label: (locale.label + ' · ' + locale.nativeLabel).slice(0, 100),
      value: locale.value,
      description: locale.value,
      default: locale.value === settings.locale,
    })));
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🌐 ' + translate(settings.locale, 'settings.locale.title'))
      .setDescription(
        translate(settings.locale, 'settings.locale.prompt') + '\n\n' +
        translate(settings.locale, 'settings.locale.current', { locale: getLocaleLabel(settings.locale) }),
      ),
  ], [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(picker),
    new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()),
  ]);
}

const SETTINGS_LAYOUT_PREFIX = 'sf:settings:dashboard-builder';

const SETTINGS_LAYOUT_LABELS: Record<SettingsDashboardButtonKey, string> = {
  panel: 'Panel Automation',
  defaults: 'Ticket Defaults',
  tags: 'Tags / Departments',
  usecases: 'Use Cases',
  reports: 'Safety & Reports',
  retention: 'Retention',
  appearance: 'Public Panel Appearance',
  storage: 'Storage',
  rules: 'Rules & Roles',
  repair: 'Repair System',
  team: 'Team & Voice',
  manual: 'Staff Manual',
  forms: 'Ticket Forms',
  refresh: 'Refresh',
  reset: 'Delete Everything',
  theme: 'Server Theme',
  premium: 'Premium & Demo',
  panels: 'Ticket Panels',
  'dashboard-builder': 'Settings Layout',
  'support-hours': 'Support Hours',
  'ticket-workspace': 'Ticket Workspace',
  inactivity: 'Inactivity Automation',
  language: 'Server Language',
};

const SETTINGS_LAYOUT_DEFAULT_EMOJIS: Record<SettingsDashboardButtonKey, string> = {
  panel: '🎛️', defaults: '🎟️', tags: '🏷️', usecases: '🧩', reports: '🚩',
  retention: '🧹', appearance: '🎨', storage: '🗄️', rules: '🛡️', repair: '🛠️',
  team: '👥', manual: '📖', forms: '🧾', refresh: '🔄', reset: '🚨', theme: '🌈',
  premium: '💎', panels: '🧱', 'dashboard-builder': '🧰', 'support-hours': '🕒', 'ticket-workspace': '🧵',
  inactivity: '⏳',
  language: '🌐',
};

function effectiveSettingsLayoutLabel(
  settings: Awaited<ReturnType<typeof getAdvancedSettings>>,
  key: SettingsDashboardButtonKey,
): string {
  return settings.settingsDashboard.buttonCustomizations[key]?.label ?? SETTINGS_LAYOUT_LABELS[key];
}

function effectiveSettingsLayoutEmoji(
  settings: Awaited<ReturnType<typeof getAdvancedSettings>>,
  key: SettingsDashboardButtonKey,
): string {
  const custom = settings.settingsDashboard.buttonCustomizations[key];
  return custom ? (custom.emoji ?? '') : SETTINGS_LAYOUT_DEFAULT_EMOJIS[key];
}


function settingsButtonOrder(settings: Awaited<ReturnType<typeof getAdvancedSettings>>): SettingsDashboardButtonKey[] {
  const valid: SettingsDashboardButtonKey[] = [];
  for (const candidate of settings.settingsDashboard.buttonOrder) {
    if ((SETTINGS_DASHBOARD_BUTTON_KEYS as readonly string[]).includes(candidate) && !valid.includes(candidate)) {
      valid.push(candidate);
    }
  }
  for (const candidate of SETTINGS_DASHBOARD_BUTTON_KEYS) {
    if (!valid.includes(candidate)) valid.push(candidate);
  }
  return valid;
}

async function showSettingsDashboardBuilder(
  interaction: SettingsViewInteraction,
  notice = '',
): Promise<void> {
  const guildId = interaction.guild!.id;
  const settings = await getAdvancedSettings(guildId);
  const config = await getGuildConfig(guildId);
  const order = settingsButtonOrder(settings);
  const orderText = order.map((key, index) => (index + 1) + '. ' + (effectiveSettingsLayoutEmoji(settings, key) ? effectiveSettingsLayoutEmoji(settings, key) + ' ' : '') + effectiveSettingsLayoutLabel(settings, key)).join('\n');
  const chooser = new StringSelectMenuBuilder()
    .setCustomId(SETTINGS_LAYOUT_PREFIX + ':reorder-select')
    .setPlaceholder('Choose a control to move up or down')
    .addOptions(order.map((key) => ({
      label: effectiveSettingsLayoutLabel(settings, key).slice(0, 100),
      value: key,
      description: 'Current position ' + (order.indexOf(key) + 1) + ' of ' + order.length,
      default: key === order[0],
    })));
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🧰 Settings Dashboard Builder')
      .setDescription(
        (notice ? notice + '\n\n' : '') +
        'Customize the **Settings channel itself** for this server. Change its heading, description, footer, control order, per-control labels and emojis. Edits save immediately; Preview shows the saved layout with disabled controls. This changes only the Settings dashboard, not the public ticket panel.\n\n' +
        '**Title:** ' + settings.settingsDashboard.title + '\n' +
        '**Description:** ' + (settings.settingsDashboard.description || 'No description') + '\n' +
        '**Footer:** ' + settings.settingsDashboard.footer + '\n\n' +
        '**Control order**\n' + orderText +
        '\n\nSafety rule: all built-in controls remain available. Reordering cannot hide repair, refresh or Delete Everything.',
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(SETTINGS_LAYOUT_PREFIX + ':edit').setLabel('Edit Branding').setEmoji('🎨').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(SETTINGS_LAYOUT_PREFIX + ':preview').setLabel('Preview').setEmoji('👁️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(SETTINGS_LAYOUT_PREFIX + ':reset-order').setLabel('Reset Layout').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
      backButton(),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(chooser),
  ]);
}

async function showSettingsDashboardOrder(
  interaction: SettingsViewInteraction,
  key: SettingsDashboardButtonKey,
): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const order = settingsButtonOrder(settings);
  const index = order.indexOf(key);
  if (index < 0) throw new Error('That Settings control no longer exists.');
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('Reorder Settings Control')
      .setDescription(
        '**Selected:** ' + (effectiveSettingsLayoutEmoji(settings, key) ? effectiveSettingsLayoutEmoji(settings, key) + ' ' : '') + effectiveSettingsLayoutLabel(settings, key) + '\n' +
        '**Current position:** ' + (index + 1) + ' of ' + order.length + '\n' +
        '**Emoji:** ' + (effectiveSettingsLayoutEmoji(settings, key) || 'None') + '\n\n' +
        'Moving this item changes the order of buttons on the persistent Settings dashboard for this server. It does not remove or disable the selected feature.',
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(SETTINGS_LAYOUT_PREFIX + ':up:' + key).setLabel('Move Up').setEmoji('⬆️').setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
      new ButtonBuilder().setCustomId(SETTINGS_LAYOUT_PREFIX + ':down:' + key).setLabel('Move Down').setEmoji('⬇️').setStyle(ButtonStyle.Secondary).setDisabled(index === order.length - 1),
      new ButtonBuilder().setCustomId(SETTINGS_LAYOUT_PREFIX + ':customize:' + key).setLabel('Customize Label / Emoji').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(SETTINGS_LAYOUT_PREFIX + ':preview').setLabel('Preview').setEmoji('👁️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(SETTINGS_LAYOUT_PREFIX + ':home').setLabel('Layout Builder').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
  ]);
}

async function showSettingsDashboardPreview(interaction: SettingsViewInteraction): Promise<void> {
  const guildId = interaction.guild!.id;
  const settings = await getAdvancedSettings(guildId);
  const config = await getGuildConfig(guildId);
  const departmentCount = Object.keys(config.departments).length;
  const tagCount = Object.values(config.departments).reduce(
    (total, department) => total + Object.keys(department.tags ?? {}).length,
    0,
  );
  const preview = buildSettingsDashboardEmbed(settings, departmentCount, tagCount, config.theme)
    .addFields({
      name: translate(settings.locale, 'settings.preview.only'),
      value: translate(settings.locale, 'settings.preview.disabledDescription'),
    });
  await renderSettingsView(interaction, [preview], [
    ...buildSettingsDashboardComponents(settings, true),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(SETTINGS_LAYOUT_PREFIX + ':home').setLabel(translate(settings.locale, 'settings.preview.returnToBuilder')).setEmoji('↩️').setStyle(ButtonStyle.Primary),
    ),
  ]);
}

async function showPremiumSettings(interaction: SettingsViewInteraction, notice = ''): Promise<void> {
  const tier = await getTier(interaction.guild!.id);
  const next = tier === 'free' ? 'premium-demo' : tier === 'premium-demo' ? 'pro-demo' : 'free';
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('💎 Premium & Feature Demo')
      .setDescription(
        (notice ? notice + '\\n\\n' : '') +
        'Current tier: **' + tierLabel(tier) + '**. Premium and Pro are demo entitlements for preview only, not real billing. ' +
        'This control cycles Free → Premium Demo → Pro Demo → Free.',
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('sf:settings:premium:toggle')
        .setLabel('Switch to ' + tierLabel(next))
        .setEmoji('🔁')
        .setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}


type SupportHoursSettingsScope = { scopeType: SupportHoursScopeType; scopeId: string | null };

function supportHoursContext(scope: SupportHoursSettingsScope): SupportHoursContext {
  if (scope.scopeType === 'department') return { departmentId: scope.scopeId ?? undefined };
  if (scope.scopeType === 'panel') return { panelId: scope.scopeId ?? undefined };
  return {};
}

function parseSupportHoursSettingsScope(parts: string[], typeIndex = 4): SupportHoursSettingsScope {
  const rawType = parts[typeIndex];
  const scopeType: SupportHoursScopeType =
    rawType === 'department' || rawType === 'panel' ? rawType : 'guild';
  const candidate = parts[typeIndex + 1];
  return { scopeType, scopeId: scopeType === 'guild' || !candidate || candidate === '-' ? null : candidate };
}

function supportHoursScopedActionId(action: string, scope: SupportHoursSettingsScope): string {
  return 'sf:settings:support-hours:' + action + ':' + scope.scopeType + ':' + (scope.scopeId ?? '-');
}

async function showSupportHoursSettings(
  interaction: SettingsViewInteraction,
  notice = '',
  scopeType: SupportHoursScopeType = 'guild',
  scopeId: string | null = null,
  departmentPage = 0,
  panelPage = 0,
): Promise<void> {
  const guild = interaction.guild!;
  const config = await getGuildConfig(guild.id);
  const settings = await getAdvancedSettings(guild.id);
  const locale = settings.locale;
  const scope = { scopeType, scopeId: scopeType === 'guild' ? null : scopeId };
  if (scope.scopeType !== 'guild' && !scope.scopeId) {
    await renderSettingsView(interaction, [
      new EmbedBuilder()
        .setTitle('🕒 ' + translate(locale, 'settings.supportHours.title'))
        .setDescription(translate(locale, 'settings.supportHours.invalidScope')),
    ], [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())]);
    return;
  }

  const context = supportHoursContext(scope);
  const [localPolicy, policies] = await Promise.all([
    getSupportHoursPolicy(guild.id, scope.scopeType, scope.scopeId),
    getSupportHoursPolicies(guild.id),
  ]);
  const effectivePolicy = resolveEffectiveSupportHoursPolicy(policies, context);
  const decision = await evaluateSupportHours(guild.id, context);
  const schedule = effectivePolicy
    ? formatSupportHoursWeeklySchedule(effectivePolicy.weeklySchedule)
    : SUPPORT_HOURS_DAYS.map((day) => day + '=closed').join('\n');

  const status = !effectivePolicy
    ? translate(locale, 'settings.supportHours.unrestricted')
    : !decision.policyEnabled
      ? translate(locale, 'settings.supportHours.enforcementDisabled')
      : decision.isOpen
        ? translate(locale, 'settings.supportHours.open')
        : decision.ticketCreationAllowed
          ? translate(locale, 'settings.supportHours.closedAllow')
          : translate(locale, 'settings.supportHours.closedRestrict');

  const scopeLabel = scope.scopeType === 'guild'
    ? translate(locale, 'settings.supportHours.scope.server')
    : scope.scopeType === 'department'
      ? translate(locale, 'settings.supportHours.scope.department', {
          name: config.departments[scope.scopeId!]?.name ?? scope.scopeId!,
        })
      : translate(locale, 'settings.supportHours.scope.panel', { id: scope.scopeId! });

  const inheritedScope = effectivePolicy?.scopeType === 'guild'
    ? translate(locale, 'settings.supportHours.scope.server')
    : effectivePolicy?.scopeType === 'department'
      ? translate(locale, 'settings.supportHours.scope.department', {
          name: config.departments[effectivePolicy.scopeId!]?.name ?? effectivePolicy.scopeId!,
        })
      : effectivePolicy?.scopeType === 'panel'
        ? translate(locale, 'settings.supportHours.scope.panel', { id: effectivePolicy.scopeId! })
        : '';
  const inheritance = localPolicy
    ? translate(locale, 'settings.supportHours.overrideSaved')
    : effectivePolicy
      ? translate(locale, 'settings.supportHours.inherits', { scope: inheritedScope })
      : translate(locale, 'settings.supportHours.noSchedule');

  const policyVersion = localPolicy?.version !== undefined
    ? String(localPolicy.version)
    : effectivePolicy
      ? translate(locale, 'settings.supportHours.inheritedVersion', { version: effectivePolicy.version })
      : translate(locale, 'settings.supportHours.notSaved');

  const outsideHoursValue = effectivePolicy?.outsideHoursBehavior === 'allow'
    ? translate(locale, 'settings.supportHours.action.allow')
    : translate(locale, 'settings.supportHours.action.restrict');

  const embed = new EmbedBuilder()
    .setTitle('🕒 ' + translate(locale, 'settings.supportHours.title'))
    .setDescription(
      (notice ? notice + '\n\n' : '') +
      '**' + translate(locale, 'settings.supportHours.label.scope') + ':** ' + scopeLabel + '\n' +
      inheritance + '\n\n' +
      '**' + translate(locale, 'settings.supportHours.label.status') + ':** ' + status + '\n' +
      '**' + translate(locale, 'settings.supportHours.label.timezone') + ':** ' +
      (effectivePolicy?.timezone ?? translate(locale, 'settings.supportHours.notConfiguredTimezone')) + '\n' +
      '**' + translate(locale, 'settings.supportHours.label.outsideHours') + ':** ' + outsideHoursValue + '\n' +
      '**' + translate(locale, 'settings.supportHours.label.version') + ':** ' + policyVersion + '\n\n' +
      '**' + translate(locale, 'settings.supportHours.label.weeklySchedule') + '**\n' + schedule +
      (decision.nextOpeningAt
        ? '\n\n**' + translate(locale, 'settings.supportHours.nextOpening') + ':** ' +
          formatSupportHoursInstant(decision.nextOpeningAt, decision.timezone)
        : '') +
      '\n\n' + translate(locale, 'settings.supportHours.timeHint'),
    );

  const hasIntervals = Boolean(effectivePolicy && SUPPORT_HOURS_DAYS.some((day) => effectivePolicy.weeklySchedule[day].length > 0));
  const currentBehavior = effectivePolicy?.outsideHoursBehavior ?? 'restrict';
  const rows: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(supportHoursScopedActionId('edit', scope))
        .setLabel(translate(locale, 'settings.supportHours.action.editSchedule'))
        .setEmoji('🗓️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(supportHoursScopedActionId('toggle', scope))
        .setLabel(translate(locale, decision.policyEnabled
          ? 'settings.supportHours.action.disable'
          : 'settings.supportHours.action.enable'))
        .setEmoji(decision.policyEnabled ? '⏸️' : '▶️')
        .setStyle(decision.policyEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
        .setDisabled(!decision.policyEnabled && !hasIntervals),
      new ButtonBuilder()
        .setCustomId(supportHoursScopedActionId('behavior', scope))
        .setLabel(translate(locale, currentBehavior === 'allow'
          ? 'settings.supportHours.action.restrict'
          : 'settings.supportHours.action.allow'))
        .setEmoji('🚦').setStyle(ButtonStyle.Secondary).setDisabled(!effectivePolicy),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(supportHoursScopedActionId('clear', scope))
        .setLabel(translate(locale, scope.scopeType === 'guild'
          ? 'settings.supportHours.action.clearServer'
          : 'settings.supportHours.action.clearOverride'))
        .setEmoji('🧹').setStyle(ButtonStyle.Secondary).setDisabled(!localPolicy),
      backButton(),
    ),
  ];

  const departments = Object.entries(config.departments ?? {});
  const panels = Object.keys(config.customPanels ?? {});
  const departmentPageCount = Math.max(1, Math.ceil(departments.length / 25));
  const panelPageCount = Math.max(1, Math.ceil(panels.length / 25));
  departmentPage = Math.min(Math.max(0, departmentPage), departmentPageCount - 1);
  panelPage = Math.min(Math.max(0, panelPage), panelPageCount - 1);

  if (departments.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('sf:settings:support-hours:scope:department')
      .setPlaceholder(translate(locale, 'settings.supportHours.chooseDepartment', {
        page: departmentPage + 1,
        pages: departmentPageCount,
      }).slice(0, 150))
      .addOptions(departments.slice(departmentPage * 25, departmentPage * 25 + 25).map(([id, department]) => ({
        label: String(department.name || id).slice(0, 100),
        value: id,
        description: ('Department ID: ' + id).slice(0, 100),
      })));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  if (panels.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('sf:settings:support-hours:scope:panel')
      .setPlaceholder(translate(locale, 'settings.supportHours.choosePanel', {
        page: panelPage + 1,
        pages: panelPageCount,
      }).slice(0, 150))
      .addOptions(panels.slice(panelPage * 25, panelPage * 25 + 25).map((id) => ({
        label: ('Panel ' + id).slice(0, 100),
        value: id,
        description: ('Ticket panel ID: ' + id).slice(0, 100),
      })));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  const pageButtons: ButtonBuilder[] = [];
  if (departmentPage > 0) {
    pageButtons.push(new ButtonBuilder()
      .setCustomId('sf:settings:support-hours:page:' + (departmentPage - 1) + ':' + panelPage + ':' + scope.scopeType + ':' + (scope.scopeId ?? '-'))
      .setLabel(translate(locale, 'settings.supportHours.previousDepartments')).setStyle(ButtonStyle.Secondary));
  }
  if (departmentPage + 1 < departmentPageCount) {
    pageButtons.push(new ButtonBuilder()
      .setCustomId('sf:settings:support-hours:page:' + (departmentPage + 1) + ':' + panelPage + ':' + scope.scopeType + ':' + (scope.scopeId ?? '-'))
      .setLabel(translate(locale, 'settings.supportHours.nextDepartments')).setStyle(ButtonStyle.Secondary));
  }
  if (panelPage > 0) {
    pageButtons.push(new ButtonBuilder()
      .setCustomId('sf:settings:support-hours:page:' + departmentPage + ':' + (panelPage - 1) + ':' + scope.scopeType + ':' + (scope.scopeId ?? '-'))
      .setLabel(translate(locale, 'settings.supportHours.previousPanels')).setStyle(ButtonStyle.Secondary));
  }
  if (panelPage + 1 < panelPageCount) {
    pageButtons.push(new ButtonBuilder()
      .setCustomId('sf:settings:support-hours:page:' + departmentPage + ':' + (panelPage + 1) + ':' + scope.scopeType + ':' + (scope.scopeId ?? '-'))
      .setLabel(translate(locale, 'settings.supportHours.nextPanels')).setStyle(ButtonStyle.Secondary));
  }
  if (pageButtons.length) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(pageButtons));

  await renderSettingsView(interaction, [embed], rows);
}

async function showTicketWorkspaceSettings(
  interaction: SettingsViewInteraction,
  notice = '',
): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const privateThreads = settings.ticketWorkspace.mode === 'private-threads';
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🧵 ' + translate(settings.locale, 'settings.nav.ticketWorkspace'))
      .setDescription(
        (notice ? notice + '\n\n' : '') +
        '**' + translate(settings.locale, 'settings.ticketWorkspace.label.currentMode') + ':** ' +
        translate(settings.locale, privateThreads
          ? 'settings.value.privateThreads'
          : 'settings.value.privateTextChannels') + '\n\n' +
        translate(settings.locale, privateThreads
          ? 'settings.ticketWorkspace.description.privateThreads'
          : 'settings.ticketWorkspace.description.textChannels') + '\n\n' +
        translate(settings.locale, 'settings.ticketWorkspace.scope.newOnly') +
        (privateThreads ? '\n\n' + translate(settings.locale, 'settings.ticketWorkspace.requirements') : ''),
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('sf:settings:ticket-workspace:set:text-channels')
        .setLabel(translate(settings.locale, 'settings.ticketWorkspace.action.useTextChannels'))
        .setEmoji('📁')
        .setStyle(privateThreads ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(!privateThreads),
      new ButtonBuilder()
        .setCustomId('sf:settings:ticket-workspace:set:private-threads')
        .setLabel(translate(settings.locale, 'settings.ticketWorkspace.action.usePrivateThreads'))
        .setEmoji('🧵')
        .setStyle(privateThreads ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(privateThreads),
      backButton(),
    ),
  ]);
}

async function showPanelSettings(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const status = translate(settings.locale, settings.panelActivity.enabled ? 'common.enabled' : 'common.disabled');

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🎛️ ' + translate(settings.locale, 'settings.panel.title'))
      .setDescription(translate(settings.locale, 'settings.panel.description'))
      .addFields({
        name: translate(settings.locale, 'settings.panel.field.currentConfiguration'),
        value: [
          translate(settings.locale, 'settings.panel.value.automaticMovement', { status }),
          translate(settings.locale, 'settings.panel.value.visualBudget', { lines: settings.panelActivity.visualLineBudget }),
          translate(settings.locale, 'settings.panel.value.messageCap', { cap: settings.panelActivity.messageBudget }),
          translate(settings.locale, 'settings.panel.value.minimumMessages', { count: settings.panelActivity.minimumMessagesBeforeMove }),
        ].join('\n'),
      }),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:panel:toggle')
        .setLabel(translate(settings.locale, settings.panelActivity.enabled ? 'settings.panel.action.disableAutoMove' : 'settings.panel.action.enableAutoMove'))
        .setEmoji(settings.panelActivity.enabled ? '⏸️' : '▶️')
        .setStyle(settings.panelActivity.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sf:settings:panel:thresholds')
        .setLabel(translate(settings.locale, 'settings.panel.action.editThresholds'))
        .setEmoji('📏').setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}

async function showTeamSettings(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const max = settings.ticketDefaults.maxClaimedModerators;
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('👥 ' + translate(settings.locale, 'settings.team.title'))
      .setDescription(translate(settings.locale, 'settings.team.description'))
      .addFields(
        {
          name: translate(settings.locale, 'settings.team.field.maxModerators'),
          value: '**' + max + '**',
          inline: true,
        },
        {
          name: translate(settings.locale, 'settings.team.field.voiceCapacity'),
          value: '**' + translate(settings.locale, 'settings.team.value.people', { count: max + 1 }) + '**',
          inline: true,
        },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('sf:settings:team:edit')
        .setLabel(translate(settings.locale, 'settings.team.action.setModeratorLimit'))
        .setEmoji('👥')
        .setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}

async function showReportSettings(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const categories = Object.values(settings.reports.categories);
  const rules = Object.values(settings.reports.flagRules).filter((rule) => rule.enabled).sort((a, b) => a.threshold - b.threshold);
  const categoryText = categories.map((category) =>
    category.emoji + ' **' + category.name + '**\n' +
    Object.values(category.subcategories).map((sub) => '• ' + sub.name).join(' • ')
  ).join('\n\n').slice(0, 3800) || translate(settings.locale, 'settings.reports.value.noCategories');

  const actionKeys: Record<'tickets' | 'channel' | 'server', TranslationKey> = {
    tickets: 'settings.reports.ruleAction.tickets',
    channel: 'settings.reports.ruleAction.channel',
    server: 'settings.reports.ruleAction.server',
  };
  const ruleText = rules.length
    ? rules.map((rule) => {
        const actionKey = actionKeys[rule.action as keyof typeof actionKeys] ?? 'settings.reports.ruleAction.unknown';
        return '• **' + translate(settings.locale, 'settings.reports.flagThreshold', { threshold: rule.threshold }) +
          ' → **' + translate(settings.locale, actionKey) + '**' +
          (rule.channelId ? ' • <#' + rule.channelId + '>' : '');
      }).join('\n')
    : translate(settings.locale, 'settings.reports.value.noAutomaticActions');

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🚩 ' + translate(settings.locale, 'settings.reports.title'))
      .setDescription(translate(settings.locale, 'settings.reports.description'))
      .addFields(
        { name: translate(settings.locale, 'settings.reports.field.reporting'), value: settings.reports.enabled ? '🟢 ' + translate(settings.locale, 'common.enabled') : '🔴 ' + translate(settings.locale, 'common.disabled'), inline: true },
        { name: translate(settings.locale, 'settings.reports.field.configuredCategories'), value: String(categories.length), inline: true },
        { name: translate(settings.locale, 'settings.reports.field.automaticFlagRules'), value: String(rules.length), inline: true },
        { name: translate(settings.locale, 'settings.reports.field.categoriesSubcategories'), value: categoryText.slice(0, 1024) },
        { name: translate(settings.locale, 'settings.reports.field.automaticActions'), value: ruleText.slice(0, 1024) },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:reports:toggle')
        .setLabel(translate(settings.locale, settings.reports.enabled ? 'settings.reports.action.disable' : 'settings.reports.action.enable'))
        .setEmoji(settings.reports.enabled ? '⏸️' : '▶️')
        .setStyle(settings.reports.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sf:settings:reports:rules')
        .setLabel(translate(settings.locale, 'settings.reports.action.flagRules'))
        .setEmoji('🚩').setStyle(ButtonStyle.Primary),
      backButton(),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...categories.slice(0, 5).map((category) =>
        new ButtonBuilder().setCustomId('sf:settings:reports:category:' + category.id)
          .setLabel(category.name.slice(0, 80)).setEmoji(category.emoji).setStyle(ButtonStyle.Secondary),
      ),
    ),
  ]);
}

async function showReportCategorySettings(interaction: ButtonInteraction, categoryId: string): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const category = settings.reports.categories[categoryId];
  if (!category) { await reject(interaction, '❌ Report category not found.'); return; }
  const subcategories = Object.values(category.subcategories);
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle(category.emoji + ' ' + category.name)
      .setDescription('These are the report subcategories automatically available to moderators. They are independent of ticket departments and use cases.')
      .addFields({ name: 'Subcategories', value: subcategories.map((sub) => '• ' + sub.name).join('\n').slice(0, 3900) || 'None' }),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:reports:subcategory:add:' + categoryId).setLabel('Add Subcategory').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sf:settings:reports:subcategory:select:' + categoryId).setLabel('Edit / Remove').setEmoji('✏️').setStyle(ButtonStyle.Primary).setDisabled(!subcategories.length),
      backButton(),
    ),
  ]);
}

async function showReportSubcategorySelector(
  interaction: ButtonInteraction,
  categoryId: string,
  page = 0,
): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const category = settings.reports.categories[categoryId];
  if (!category) {
    await reject(interaction, '❌ Report category not found.');
    return;
  }

  const subcategories = Object.values(category.subcategories);
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(subcategories.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = subcategories.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );

  const components: Array<
    ActionRowBuilder<StringSelectMenuBuilder> |
    ActionRowBuilder<ButtonBuilder>
  > = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(
          'sf:settings:reports:subcategory:pick:' + categoryId,
        )
        .setPlaceholder('Choose a subcategory')
        .addOptions(
          visible.map((sub) => ({
            label: sub.name.slice(0, 100),
            value: sub.id,
          })),
        ),
    ),
  ];

  if (pageCount > 1) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            'sf:settings:reports:subcategory:select:' +
              categoryId +
              ':' +
              (safePage - 1),
          )
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage === 0),
        new ButtonBuilder()
          .setCustomId(
            'sf:settings:reports:subcategory:select:' +
              categoryId +
              ':' +
              safePage,
          )
          .setLabel('Page ' + (safePage + 1) + ' / ' + pageCount)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(
            'sf:settings:reports:subcategory:select:' +
              categoryId +
              ':' +
              (safePage + 1),
          )
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage >= pageCount - 1),
      ),
    );
  }

  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()),
  );

  await interaction.reply({
    content:
      'Select the report subcategory to edit or remove.' +
      (pageCount > 1
        ? ' Page ' + (safePage + 1) + ' of ' + pageCount + '.'
        : ''),
    components,
    flags: MessageFlags.Ephemeral,
  });
}

async function showDefaults(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const priorityKeys: Record<TicketPriority, TranslationKey> = {
    low: 'priority.low',
    normal: 'priority.normal',
    high: 'priority.high',
    urgent: 'priority.urgent',
    critical: 'priority.critical',
  };

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🎟️ ' + translate(settings.locale, 'settings.defaults.title'))
      .setDescription(translate(settings.locale, 'settings.defaults.description'))
      .addFields({
        name: translate(settings.locale, 'settings.defaults.field.priority'),
        value: '⚡ **' + translate(settings.locale, priorityKeys[settings.ticketDefaults.priority]) + '**',
      }),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('sf:settings:defaults:edit')
        .setLabel(translate(settings.locale, 'settings.defaults.action.changePriority'))
        .setEmoji('⚡')
        .setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}

async function showTagActions(interaction: SettingsViewInteraction, departmentId: string, tagId: string): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const department = config.departments[departmentId];
  const tag = department?.tags?.[tagId];
  if (!department || !tag) { await reject(interaction, '❌ Tag not found.'); return; }
  await renderSettingsView(interaction, [
    new EmbedBuilder().setTitle('🏷️ ' + tag.name).setDescription('Tag **' + tag.name + '** belongs to **' + department.name + '**. Tags are subcategories only and never create Discord categories.'),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:tag:edit:' + departmentId + ':' + tagId).setLabel('Edit Tag').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sf:settings:tag:remove:' + departmentId + ':' + tagId).setLabel('Remove Tag').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(Object.keys(department.tags).length <= 1),
      new ButtonBuilder().setCustomId('sf:settings:tag:manage:' + departmentId).setLabel('Back').setStyle(ButtonStyle.Secondary),
    ),
  ]);
}

async function showTags(interaction: SettingsViewInteraction): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const locale = settings.locale;
  const departments = Object.values(config.departments).sort((a, b) => a.name.localeCompare(b.name));
  const lines = departments.length
    ? departments.map((department) => {
        const tags = Object.values(department.tags ?? {}).map((tag) => tag.name).sort().join(', ') ||
          translate(locale, 'settings.departments.noTags');
        return '📂 **' + department.name + '** • ' +
          (department.categoryId ? '<#' + department.categoryId + '>' : translate(locale, 'settings.departments.categoryPending')) +
          '\n   🏷️ ' + tags;
      }).join('\n')
    : translate(locale, 'settings.departments.noDepartments');
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('📂 ' + translate(locale, 'settings.departments.title'))
      .setDescription(lines.slice(0, 3200))
      .addFields(
        {
          name: translate(locale, 'settings.departments.hierarchy.title'),
          value: translate(locale, 'settings.departments.hierarchy.description'),
        },
        {
          name: translate(locale, 'settings.departments.aiReady.title'),
          value: translate(locale, 'settings.departments.aiReady.description'),
        },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:departments:add')
        .setLabel(translate(locale, 'settings.departments.actions.add'))
        .setEmoji('📂').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sf:settings:departments:manage')
        .setLabel(translate(locale, 'settings.departments.actions.manage'))
        .setEmoji('⚙️').setStyle(ButtonStyle.Primary).setDisabled(!departments.length),
      backButton(),
    ),
  ]);
}

async function showDepartmentPicker(
  interaction: SettingsViewInteraction,
  page = 0,
): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const locale = settings.locale;
  const departments = Object.values(config.departments).sort((a, b) => a.name.localeCompare(b.name));
  if (!departments.length) {
    await renderSettingsView(interaction, [
      new EmbedBuilder()
        .setTitle('📂 ' + translate(locale, 'settings.departments.title'))
        .setDescription(translate(locale, 'settings.departments.noDepartments')),
    ], [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())]);
    return;
  }

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(departments.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = departments.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('sf:settings:department:select')
        .setPlaceholder(translate(locale, 'settings.departments.actions.select').slice(0, 150))
        .addOptions(visible.map((department) => ({
          label: department.name.slice(0, 100),
          value: department.id,
          description: translate(locale, 'settings.departments.actions.tags', {
            count: Object.keys(department.tags ?? {}).length,
          }).slice(0, 100),
        }))),
    ),
  ];
  if (pageCount > 1) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:departments:manage:page:' + (safePage - 1))
        .setLabel(translate(locale, 'settings.common.previous'))
        .setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
      new ButtonBuilder().setCustomId('sf:settings:departments:manage:page:' + safePage)
        .setLabel(translate(locale, 'settings.common.page', {
          page: safePage + 1, pages: pageCount,
        }).slice(0, 80))
        .setEmoji('📄').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('sf:settings:departments:manage:page:' + (safePage + 1))
        .setLabel(translate(locale, 'settings.common.next'))
        .setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pageCount - 1),
    ));
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()));
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('⚙️ ' + translate(locale, 'settings.departments.actions.manage'))
      .setDescription(
        translate(locale, 'settings.departments.actions.selectToManage') +
        (pageCount > 1 ? '\n' + translate(locale, 'settings.departments.range', {
          start: safePage * pageSize + 1,
          end: Math.min((safePage + 1) * pageSize, departments.length),
          total: departments.length,
        }) : ''),
      ),
  ], components);
}

async function showDepartmentManager(interaction: SettingsViewInteraction, departmentId: string): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const locale = settings.locale;
  const department = config.departments[departmentId];
  if (!department) {
    await reject(interaction, '❌ ' + translate(locale, 'settings.departments.notFound'));
    return;
  }
  const tags = Object.values(department.tags ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('⚙️ ' + department.name)
      .setDescription(
        '**' + translate(locale, 'settings.departments.field.category') + ':** ' +
        (department.categoryId ? '<#' + department.categoryId + '>' : translate(locale, 'settings.departments.value.pending')) + '\n' +
        '**' + translate(locale, 'settings.departments.field.staff') + ':** ' +
        (department.staffRoleId ? '<@&' + department.staffRoleId + '>' : translate(locale, 'settings.departments.value.adminsOnly')) +
        '\n\n**' + translate(locale, 'settings.departments.field.tags') + ':** ' +
        (tags.length ? tags.map((tag) => '🏷️ ' + tag.name).join(' • ') : translate(locale, 'settings.departments.noTags')),
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:department:edit:' + department.id)
        .setLabel(translate(locale, 'settings.departments.actions.edit')).setEmoji('✏️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sf:settings:tag:add:' + department.id)
        .setLabel(translate(locale, 'settings.tags.actions.add'))
        .setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sf:settings:tag:manage:' + department.id)
        .setLabel(translate(locale, 'settings.tags.title')).setEmoji('🏷️')
        .setStyle(ButtonStyle.Secondary).setDisabled(!tags.length),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:department:remove:' + department.id)
        .setLabel(translate(locale, 'settings.departments.actions.remove')).setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger).setDisabled(Object.keys(config.departments).length <= 1),
      new ButtonBuilder().setCustomId('sf:settings:departments')
        .setLabel(translate(locale, 'settings.departments.actions.back')).setStyle(ButtonStyle.Secondary),
    ),
  ]);
}

async function showTagManager(
  interaction: SettingsViewInteraction,
  departmentId: string,
  page = 0,
): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const locale = settings.locale;
  const department = config.departments[departmentId];
  if (!department) {
    await reject(interaction, '❌ ' + translate(locale, 'settings.departments.notFound'));
    return;
  }
  const tags = Object.values(department.tags ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  if (!tags.length) {
    await renderSettingsView(interaction, [
      new EmbedBuilder().setTitle('🏷️ ' + translate(locale, 'settings.tags.title') + ' • ' + department.name)
        .setDescription(translate(locale, 'settings.tags.noTags')),
    ], [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:department:manage:' + department.id)
        .setLabel(translate(locale, 'settings.tags.actions.backToDepartment')).setStyle(ButtonStyle.Secondary),
    )]);
    return;
  }

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(tags.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = tags.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('sf:settings:tag:select:' + department.id)
        .setPlaceholder(translate(locale, 'settings.tags.select').slice(0, 150))
        .addOptions(visible.map((tag) => ({
          label: tag.name.slice(0, 100),
          value: tag.id,
          description: translate(locale, 'settings.tags.subcategoryOf', { department: department.name }).slice(0, 100),
        }))),
    ),
  ];
  if (pageCount > 1) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:tag:manage-page:' + department.id + ':' + (safePage - 1))
        .setLabel(translate(locale, 'quickReply.picker.previous')).setEmoji('⬅️')
        .setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
      new ButtonBuilder().setCustomId('sf:settings:tag:manage-page:' + department.id + ':' + safePage)
        .setLabel(translate(locale, 'settings.common.page', { page: safePage + 1, pages: pageCount }).slice(0, 80))
        .setEmoji('📄').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('sf:settings:tag:manage-page:' + department.id + ':' + (safePage + 1))
        .setLabel(translate(locale, 'quickReply.picker.next')).setEmoji('➡️')
        .setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pageCount - 1),
    ));
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sf:settings:department:manage:' + department.id)
      .setLabel(translate(locale, 'settings.tags.actions.backToDepartment')).setStyle(ButtonStyle.Secondary),
  ));
  await renderSettingsView(interaction, [
    new EmbedBuilder().setTitle('🏷️ ' + translate(locale, 'settings.tags.title') + ' • ' + department.name)
      .setDescription(
        translate(locale, 'settings.tags.selectToManage') +
        (pageCount > 1 ? '\n' + translate(locale, 'settings.tags.range', {
          start: safePage * pageSize + 1,
          end: Math.min((safePage + 1) * pageSize, tags.length),
          total: tags.length,
        }) : ''),
      ),
  ], components);
}

async function showDepartments(interaction: SettingsViewInteraction): Promise<void> {
  await showTags(interaction);
}

async function showRetention(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const retentionValue = (days: number) => days === 0
    ? translate(settings.locale, 'settings.value.noTimer')
    : translate(settings.locale, 'settings.value.days', { count: days });

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🧹 ' + translate(settings.locale, 'settings.retention.title'))
      .setDescription(translate(settings.locale, 'settings.retention.description'))
      .addFields(
        {
          name: translate(settings.locale, 'settings.retention.field.closed'),
          value: retentionValue(settings.retention.closedDays),
          inline: true,
        },
        {
          name: translate(settings.locale, 'settings.retention.field.archived'),
          value: retentionValue(settings.retention.archiveDays),
          inline: true,
        },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('sf:settings:retention:edit')
        .setLabel(translate(settings.locale, 'settings.retention.action.edit'))
        .setEmoji('🕒')
        .setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}

async function showInactivitySettings(interaction: SettingsViewInteraction, notice = ''): Promise<void> {
  const guild = interaction.guild!;
  const settings = await getAdvancedSettings(guild.id);
  const config = await getGuildConfig(guild.id);
  const defaultRoleIds = settings.inactivity.exemptRoleIds.filter((roleId) => guild.roles.cache.has(roleId));
  const roleSelector = new RoleSelectMenuBuilder()
    .setCustomId('sf:settings:inactivity:exempt-roles')
    .setPlaceholder(translate(settings.locale, 'settings.inactivity.roleSelectPlaceholder').slice(0, 150))
    .setMinValues(0)
    .setMaxValues(25);
  if (defaultRoleIds.length) roleSelector.setDefaultRoles(...defaultRoleIds);

  const roleNames = settings.inactivity.exemptRoleIds
    .map((roleId) => guild.roles.cache.get(roleId)?.name ?? roleId)
    .join(', ') || translate(settings.locale, 'common.none');
  const departmentNames = settings.inactivity.exemptDepartmentIds
    .map((departmentId) => config.departments[departmentId]?.name ?? departmentId)
    .join(', ') || translate(settings.locale, 'common.none');

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('⏳ ' + translate(settings.locale, 'settings.inactivity.title'))
      .setDescription(
        (notice ? notice + '\n\n' : '') +
        translate(settings.locale, 'settings.inactivity.description') + '\n\n' +
        '**' + translate(settings.locale, 'settings.inactivity.status') + ':** ' +
        (settings.inactivity.enabled
          ? '🟢 ' + translate(settings.locale, 'common.enabled')
          : '⚪ ' + translate(settings.locale, 'common.disabled')) + '\n' +
        translate(settings.locale, 'settings.inactivity.warnAfter', { hours: settings.inactivity.idleHours }) + '\n' +
        translate(settings.locale, 'settings.inactivity.graceAfter', { hours: settings.inactivity.graceHours }) + '\n' +
        '**' + translate(settings.locale, 'settings.inactivity.exemptRoles') + ':** ' + roleNames + '\n' +
        '**' + translate(settings.locale, 'settings.inactivity.exemptDepartments') + ':** ' + departmentNames + '\n\n' +
        translate(settings.locale, 'settings.inactivity.exemptionHelp')
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('sf:settings:inactivity:' + (settings.inactivity.enabled ? 'disable' : 'enable'))
        .setLabel(translate(settings.locale, settings.inactivity.enabled ? 'settings.inactivity.action.disable' : 'settings.inactivity.action.enable'))
        .setEmoji(settings.inactivity.enabled ? '⏸️' : '▶️')
        .setStyle(settings.inactivity.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('sf:settings:inactivity:edit')
        .setLabel(translate(settings.locale, 'settings.inactivity.action.editThresholds'))
        .setEmoji('🕒')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('sf:settings:inactivity:departments')
        .setLabel(translate(settings.locale, 'settings.inactivity.action.editDepartments'))
        .setEmoji('🗂️')
        .setStyle(ButtonStyle.Secondary),
      backButton(),
    ),
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelector),
  ]);
}

async function showAppearance(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🎨 ' + translate(settings.locale, 'settings.appearance.title'))
      .setDescription(translate(settings.locale, 'settings.appearance.description'))
      .addFields(
        { name: translate(settings.locale, 'settings.appearance.field.title'), value: settings.appearance.panelTitle.slice(0, 1024) || translate(settings.locale, 'settings.appearance.value.notSet') },
        { name: translate(settings.locale, 'settings.appearance.field.description'), value: settings.appearance.panelDescription.slice(0, 1024) || translate(settings.locale, 'settings.appearance.value.notSet') },
        { name: translate(settings.locale, 'settings.appearance.field.footer'), value: settings.appearance.panelFooter.slice(0, 1024) || translate(settings.locale, 'settings.appearance.value.notSet') },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:appearance:edit')
        .setLabel(translate(settings.locale, 'settings.appearance.action.edit'))
        .setEmoji('✏️').setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}

async function showThemeSettings(
  interaction: SettingsViewInteraction,
  notice = '',
): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const active = getThemeDefinition(config.theme);
  const chooser = new StringSelectMenuBuilder()
    .setCustomId('sf:settings:theme:select')
    .setPlaceholder(translate(settings.locale, 'settings.theme.choose').slice(0, 150))
    .addOptions(UI_THEMES.map((theme) => ({
      label: theme.label,
      value: theme.id,
      description: theme.description,
      default: theme.id === config.theme,
    })));

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🌈 ' + translate(settings.locale, 'settings.theme.title'))
      .setDescription(
        (notice ? notice + '\n\n' : '') +
        translate(settings.locale, 'settings.theme.description')
      )
      .addFields(
        { name: translate(settings.locale, 'settings.theme.field.activePalette'), value: '**' + active.label + '**\n' + active.description, inline: true },
        { name: translate(settings.locale, 'settings.theme.field.preview'), value: active.preview, inline: true },
      ),
  ], [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(chooser),
    new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()),
  ]);
}

async function showUseCases(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const presets = Object.entries(USE_CASE_PRESETS);
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < presets.length; i += 4) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...presets.slice(i, i + 4).map(([key, preset]) =>
        new ButtonBuilder()
          .setCustomId('sf:settings:usecases:add:' + key)
          .setLabel(preset.name)
          .setEmoji(preset.emoji)
          .setStyle(ButtonStyle.Secondary),
      ),
    ));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()));
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🧩 ' + translate(settings.locale, 'settings.useCases.title'))
      .setDescription(translate(settings.locale, 'settings.useCases.description')),
  ], rows);
}

async function showStorage(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const claimed = await getOptionalStatusCategory(interaction.guild!, 'claimed');
  const pending = await getOptionalStatusCategory(interaction.guild!, 'pending');

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🗄️ ' + translate(settings.locale, 'settings.storage.title'))
      .setDescription(translate(settings.locale, 'settings.storage.description'))
      .addFields(
        {
          name: translate(settings.locale, 'settings.storage.field.closed'),
          value: settings.closedCategoryId
            ? (interaction.guild!.channels.cache.get(settings.closedCategoryId)?.name ?? translate(settings.locale, 'settings.storage.value.configuredCategory'))
            : translate(settings.locale, 'settings.storage.value.notProvisioned'),
          inline: true,
        },
        {
          name: translate(settings.locale, 'settings.storage.field.archive'),
          value: settings.archiveCategoryId
            ? (interaction.guild!.channels.cache.get(settings.archiveCategoryId)?.name ?? translate(settings.locale, 'settings.storage.value.configuredCategory'))
            : translate(settings.locale, 'settings.storage.value.notProvisioned'),
          inline: true,
        },
        {
          name: translate(settings.locale, 'settings.storage.field.claimed'),
          value: claimed?.name ?? translate(settings.locale, 'settings.storage.value.notAdded'),
          inline: true,
        },
        {
          name: translate(settings.locale, 'settings.storage.field.pending'),
          value: pending?.name ?? translate(settings.locale, 'settings.storage.value.notAdded'),
          inline: true,
        },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('sf:settings:storage:add:claimed')
        .setLabel(translate(settings.locale, claimed
          ? 'settings.storage.action.claimedAdded'
          : 'settings.storage.action.addClaimed'))
        .setEmoji('🙋').setStyle(ButtonStyle.Secondary).setDisabled(Boolean(claimed)),
      new ButtonBuilder()
        .setCustomId('sf:settings:storage:add:pending')
        .setLabel(translate(settings.locale, pending
          ? 'settings.storage.action.pendingAdded'
          : 'settings.storage.action.addPending'))
        .setEmoji('⏳').setStyle(ButtonStyle.Secondary).setDisabled(Boolean(pending)),
      new ButtonBuilder()
        .setCustomId('sf:settings:storage:repair')
        .setLabel(translate(settings.locale, 'settings.storage.action.repair'))
        .setEmoji('🗄️').setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}

async function showResetStepOne(interaction: ButtonInteraction): Promise<void> {
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🚨 Delete Everything • Confirmation 1 of 3')
      .setDescription(
        '**This permanently removes ResolvX data from this server.**\n\n' +
        'Before continuing, choose whether ResolvX should retain individual audit events for future summaries. Daily and overall summaries are retained either way.\n\n' +
        'ResolvX-managed ticket channels and their messages, ResolvX categories, the public ticket panel, transcript/audit/settings channels, and stored ResolvX data will be deleted.\n\n' +
        'Unrelated Discord channels are not targeted.',
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:reset:audit:no').setLabel('Do Not Accumulate').setEmoji('📊').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sf:settings:reset:audit:yes').setLabel('Accumulate Audit Data').setEmoji('💾').setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}

async function showResetStepTwo(interaction: ButtonInteraction): Promise<void> {
  const accumulate = pendingResetAuditChoice.get(interaction.guild!.id) ?? false;
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🚨 Delete Everything • Confirmation 2 of 3')
      .setDescription(
        '**You are about to erase every ResolvX-managed channel and stored record in this server.**\n\n' +
        'Audit retention choice: **' + (accumulate ? 'Accumulate individual audit data' : 'Keep summaries only') + '**.\n\n' +
        'Daily and overall summaries will remain available after ResolvX is set up again. This choice can be changed later from the Audit Log controls.\n\n' +
        'This includes every message inside ResolvX-managed channels. ResolvX cannot undo this operation.',
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:reset:confirm3').setLabel('Continue to Final Confirmation').setEmoji('☢️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('sf:settings:home').setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
    ),
  ]);
}

async function showResetFinal(interaction: ButtonInteraction): Promise<void> {
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId('sf:settings:modal:reset')
      .setTitle('Final Confirmation • 3 of 3')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('confirmation')
            .setLabel('Type DELETE SUPPORT FORGE to continue')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('DELETE SUPPORT FORGE')
            .setMaxLength(20),
        ),
      ),
  );
}

async function openModal(
  interaction: ButtonInteraction,
  customId: string,
  title: string,
  inputs: TextInputBuilder[],
): Promise<void> {
  try {
    const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
    for (const input of inputs) {
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(input),
      );
    }
    await interaction.showModal(modal);
  } catch (error) {
    console.error('❌ Failed to open ResolvX settings form:', error);
    await reject(interaction, '❌ The settings form could not be opened. Please try again.');
  }
}


type TicketRecoveryInteraction = ButtonInteraction | StringSelectMenuInteraction;
const RECOVERY_PAGE_SIZE = 20;

async function recoveryEmbed(guild: Guild, title: string, description: string): Promise<EmbedBuilder> {
  const config = await getGuildConfig(guild.id);
  return new EmbedBuilder()
    .setColor(getThemeColor(config.theme))
    .setTitle(title.slice(0, 256))
    .setDescription((description || 'Use the controls below to continue.').slice(0, 3900))
    .setFooter({ text: getThemeDefinition(config.theme).label + ' theme • ResolvX Ticket Recovery' })
    .setTimestamp();
}

async function ensureRecoveryReply(interaction: TicketRecoveryInteraction): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

function recoveryButton(id: string, label: string, style: ButtonStyle = ButtonStyle.Secondary, emoji?: string, disabled = false): ButtonBuilder {
  const result = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  if (emoji) result.setEmoji(emoji);
  return result;
}

function recoverySelect(candidates: TicketRecoveryCandidate[], source: 'discord_native' | 'ticket_button'): ActionRowBuilder<StringSelectMenuBuilder> | null {
  if (!candidates.length) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(source === 'discord_native' ? 'sf:settings:recovery:channels:pick' : 'sf:settings:recovery:review:pick')
    .setPlaceholder(source === 'discord_native' ? 'Choose a channel to restore' : 'Choose a deletion to review')
    .addOptions(candidates.slice(0, 25).map((item) => ({
      label: ('Ticket #' + item.ticketNumber).slice(0, 100),
      value: item.ticketId,
      description: (item.messageCount + ' archived messages • owner ' + item.ownerId).slice(0, 100),
    })));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

async function showRecoveryCandidates(
  interaction: TicketRecoveryInteraction,
  source: 'discord_native' | 'ticket_button',
  requestedPage = 1,
): Promise<void> {
  await ensureRecoveryReply(interaction);
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply('Ticket recovery must be opened inside a server.');
    return;
  }

  const all = await listTicketRecoveryCandidates(guild.id, source);
  const pages = Math.max(1, Math.ceil(all.length / RECOVERY_PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), pages);
  const candidates = all.slice((page - 1) * RECOVERY_PAGE_SIZE, page * RECOVERY_PAGE_SIZE);
  const native = source === 'discord_native';
  const rows: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [];
  const select = recoverySelect(candidates, source);
  if (select) rows.push(select);
  if (pages > 1) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      recoveryButton('sf:settings:recovery:' + (native ? 'channels' : 'review') + ':page:' + (page - 1), 'Previous', ButtonStyle.Secondary, '◀️', page <= 1),
      recoveryButton('sf:settings:recovery:' + (native ? 'channels' : 'review') + ':page:' + (page + 1), 'Next', ButtonStyle.Secondary, '▶️', page >= pages),
      recoveryButton('sf:settings:repair:back', 'Repair System', ButtonStyle.Secondary, '↩️'),
    ));
  } else {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      recoveryButton('sf:settings:repair:back', 'Repair System', ButtonStyle.Secondary, '↩️'),
    ));
  }

  const lines = candidates.map((item) =>
    '• **Ticket #' + item.ticketNumber + '** • ' + item.messageCount + ' archived message(s) • original channel ID: ' + item.originalChannelId +
    (item.accidentalAnswer === 'yes' ? ' • **marked accidental, ready to restore**' : ''),
  );
  const description = native
    ? (all.length ? 'Native Discord deletions only. These records never enter the ticket-button accidental-deletion review.\\n\\n' : 'No native Discord channel deletions are currently available for restoration.\\n\\n')
    : (all.length ? 'Ticket-button deletions only. Choose a record to answer the question or restore a ticket already marked as accidental.\\n\\n' : 'No ticket-button deletions are awaiting review or accidental-deletion recovery.\\n\\n');
  const embed = await recoveryEmbed(
    guild,
    native ? '♻️ Restore Channel' : '🛡️ Ticket Deletion Review',
    description + (lines.length ? lines.join('\n') : 'Nothing to display on this page.') + '\n\nPage ' + page + ' / ' + pages,
  );
  await interaction.editReply({ content: '', embeds: [embed], components: rows });
}

async function showRecoveryCandidateDetail(
  interaction: TicketRecoveryInteraction,
  ticketId: string,
  source: 'discord_native' | 'ticket_button',
): Promise<void> {
  await ensureRecoveryReply(interaction);
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply('Ticket recovery must be opened inside a server.');
    return;
  }
  const item = (await listTicketRecoveryCandidates(guild.id, source)).find((candidate) => candidate.ticketId === ticketId);
  if (!item) {
    await interaction.editReply({
      content: '',
      embeds: [await recoveryEmbed(guild, 'Recovery record no longer available', 'Refresh the recovery list. The record may already have been restored or reviewed.')],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(recoveryButton('sf:settings:recovery:' + (source === 'discord_native' ? 'channels' : 'review'), 'Back to list', ButtonStyle.Secondary, '↩️'))],
    });
    return;
  }

  let preview: Awaited<ReturnType<typeof getTicketRecoveryPreview>>;
  try {
    preview = await getTicketRecoveryPreview(guild.id, ticketId, source);
  } catch (error) {
    await interaction.editReply({
      content: '',
      embeds: [await recoveryEmbed(guild, 'Recovery preview unavailable', error instanceof Error ? error.message : 'The archive summary could not be loaded safely.')],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(recoveryButton('sf:settings:recovery:' + (source === 'discord_native' ? 'channels' : 'review'), 'Back to list', ButtonStyle.Secondary, '↩️'))],
    });
    return;
  }

  const previewLines = [
    '**Read-only recovery preview**',
    'Archive snapshot: **' + (preview.channelSnapshotAvailable ? 'available' : 'missing, safe channel defaults will be used') + '**',
    'Historic message scan: **' + (preview.historicalBackfillComplete ? 'complete' : 'incomplete') + '**',
    'Archived message records: **' + preview.archivedMessageCount + '** (source-deleted: ' + preview.deletedMessageCount + ')',
    'Attachments: **' + preview.totalAttachmentCount + '** metadata; **' + preview.restorableAttachmentCount + '** with archived bytes; **' + preview.tooLargeAttachmentCount + '** oversized; **' + preview.metadataOnlyAttachmentCount + '** metadata-only; **' + preview.pendingAttachmentCount + '** pending; **' + preview.failedAttachmentCount + '** failed',
    'Attachment archive rows: **' + preview.trackedAttachmentCount + ' / ' + preview.totalAttachmentCount + '**; missing rows: **' + preview.attachmentRecordsMissing + '**',
    'Previously replayed message records: **' + preview.alreadyReplayedMessageCount + '**',
    'Restore eligibility: **' + (preview.eligibleToRestore ? 'eligible' : 'not eligible') + '**',
    ...(preview.latestArchivedAt ? ['Latest archived message: <t:' + Math.floor(Date.parse(preview.latestArchivedAt) / 1000) + ':F>'] : []),
    ...(preview.warnings.length ? ['', '**Recovery limitations**', ...preview.warnings.map((warning) => '• ' + warning)] : []),
    '',
    'Restoration creates a replacement channel with a new Discord ID. Replayed content is posted by the bot and labelled with original author, channel, message ID and timestamp; historical users are never impersonated. Existing ticket controls are rebuilt from current safe actions.',
  ].join('\\n');

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (source === 'discord_native') {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      recoveryButton('sf:settings:recovery:channels:restore:' + ticketId, 'Restore Channel', ButtonStyle.Success, '♻️', !preview.eligibleToRestore),
      recoveryButton('sf:settings:recovery:channels', 'Back to list', ButtonStyle.Secondary, '↩️'),
    ));
  } else if (item.accidentalAnswer === 'yes') {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      recoveryButton('sf:settings:recovery:review:restore:' + ticketId, 'Restore Ticket', ButtonStyle.Success, '♻️', !preview.eligibleToRestore),
      recoveryButton('sf:settings:recovery:review', 'Back to list', ButtonStyle.Secondary, '↩️'),
    ));
  } else {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      recoveryButton('sf:settings:recovery:review:answer:' + ticketId + ':yes', 'Yes, deleted by mistake', ButtonStyle.Success, '✅'),
      recoveryButton('sf:settings:recovery:review:answer:' + ticketId + ':no', 'No, intentional', ButtonStyle.Danger, '🛑'),
      recoveryButton('sf:settings:recovery:review', 'Back', ButtonStyle.Secondary, '↩️'),
    ));
  }

  const context = source === 'discord_native'
    ? 'This channel was deleted outside the ResolvX ticket Delete button. Native deletion is recorded separately and does not trigger the accidental-deletion question.'
    : item.accidentalAnswer === 'yes'
      ? 'Review answer: **Yes, it was deleted by mistake.** This ticket is eligible for restoration through this review workflow.'
      : [
          'Was this ticket deleted by mistake?',
          '',
          'Original channel ID: ' + item.originalChannelId,
          'Ticket creator ID: ' + item.ownerId,
          'Archived messages: ' + item.messageCount,
          '',
          'Your answer will be saved in Neon and logged in both the ticket audit stream and developer/system audit stream.',
        ].join('\n');
  const text = [context, '', ...previewLines].join('\n');
  const embed = await recoveryEmbed(guild, (source === 'discord_native' ? '♻️ Restore Channel' : '🛡️ Ticket Deletion Review') + ' • Ticket #' + item.ticketNumber, text);
  await interaction.editReply({ content: '', embeds: [embed], components: rows });
}

async function handleTicketRecoveryInteraction(interaction: TicketRecoveryInteraction): Promise<boolean> {
  const id = interaction.customId;
  if (!id.startsWith('sf:settings:recovery:')) return false;
  const guild = interaction.guild;
  if (!guild) return true;

  if (id === 'sf:settings:recovery:channels') {
    await showRecoveryCandidates(interaction, 'discord_native');
    return true;
  }
  if (id.startsWith('sf:settings:recovery:channels:page:')) {
    await showRecoveryCandidates(interaction, 'discord_native', Number(id.slice('sf:settings:recovery:channels:page:'.length)) || 1);
    return true;
  }
  if (id === 'sf:settings:recovery:channels:pick' && interaction.isStringSelectMenu()) {
    const selected = interaction.values[0];
    if (selected) await showRecoveryCandidateDetail(interaction, selected, 'discord_native');
    return true;
  }
  if (id.startsWith('sf:settings:recovery:channels:restore:')) {
    await ensureRecoveryReply(interaction);
    const ticketId = id.slice('sf:settings:recovery:channels:restore:'.length);
    try {
      const restored = await restoreArchivedTicket(guild, ticketId, 'discord_native');
      const config = await getGuildConfig(guild.id);
      const ticket = await getPersistedTicketById(ticketId);
      if (config.supportCategoryId) {
        await ensureAuditDeveloperInfrastructure(guild, config.supportCategoryId);
        await logTicketEvent(guild, config.supportCategoryId, {
          ticketNumber: restored.ticketNumber,
          ticketChannelId: ticket?.channelId ?? restored.channelId,
          event: 'TICKET_RESTORED_AFTER_NATIVE_DELETION',
          actorId: interaction.user.id,
          actor: interaction.user.tag,
          actorName: interaction.user.tag,
          detail: 'Restored into new channel ' + restored.channelId + '; replayed ' + restored.restoredMessages + ' archived messages; failed messages=' + restored.failedMessages + '.',
        });
        await logSystemEvent(guild, config.supportCategoryId, 'TICKET_NATIVE_DELETION_RECOVERED',
          'Moderator ' + interaction.user.tag + ' restored ticket #' + restored.ticketNumber + ' from native Discord deletion. New channel ID: ' + restored.channelId + '. Replayed messages: ' + restored.restoredMessages + '. Failed messages: ' + restored.failedMessages + '.');
      }
      const embed = await recoveryEmbed(guild, '✅ Ticket channel restored', 'Ticket #' + restored.ticketNumber + ' now exists in ' + '<#' + restored.channelId + '> with new channel ID ' + restored.channelId + ' and a new URL.\\n\\nReplayed messages: **' + restored.restoredMessages + '**\\nMessages that failed to replay: **' + restored.failedMessages + '**\\n\\nArchived author/channel/message IDs are included in each recovery message. The bot does not impersonate original users.');
      await interaction.editReply({ content: '', embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(recoveryButton('sf:settings:recovery:channels', 'Back to Restore Channel', ButtonStyle.Secondary, '↩️'))] });
    } catch (error) {
      const embed = await recoveryEmbed(guild, '❌ Ticket recovery failed', error instanceof Error ? error.message : 'Unknown recovery error.');
      await interaction.editReply({ content: '', embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(recoveryButton('sf:settings:recovery:channels', 'Back to Restore Channel', ButtonStyle.Secondary, '↩️'))] });
    }
    return true;
  }

  if (id === 'sf:settings:recovery:review') {
    await showRecoveryCandidates(interaction, 'ticket_button');
    return true;
  }
  if (id.startsWith('sf:settings:recovery:review:page:')) {
    await showRecoveryCandidates(interaction, 'ticket_button', Number(id.slice('sf:settings:recovery:review:page:'.length)) || 1);
    return true;
  }
  if (id === 'sf:settings:recovery:review:pick' && interaction.isStringSelectMenu()) {
    const selected = interaction.values[0];
    if (selected) await showRecoveryCandidateDetail(interaction, selected, 'ticket_button');
    return true;
  }
  if (id.startsWith('sf:settings:recovery:review:answer:')) {
    await ensureRecoveryReply(interaction);
    const parts = id.slice('sf:settings:recovery:review:answer:'.length).split(':');
    const ticketId = parts[0] ?? '';
    const answer = parts[1] === 'yes' ? 'yes' : parts[1] === 'no' ? 'no' : null;
    if (!answer) {
      await interaction.editReply('Invalid deletion-review answer.');
      return true;
    }
    try {
      const ticket = await getPersistedTicketById(ticketId);
      if (!ticket || ticket.guildId !== guild.id) throw new Error('Ticket deletion review belongs to a different server or no longer exists.');
      const result = await answerTicketDeletionReview(ticketId, answer, interaction.user.id, interaction.user.tag);
      const config = await getGuildConfig(guild.id);
      const eventName = answer === 'yes' ? 'TICKET_DELETION_MARKED_ACCIDENTAL' : 'TICKET_DELETION_MARKED_INTENTIONAL';
      const detail = 'Answer to “Was this ticket deleted by mistake?”: ' + (answer === 'yes' ? 'YES, deleted by mistake.' : 'NO, deletion was intentional.') +
        ' Reviewer: ' + interaction.user.tag + ' (' + interaction.user.id + '). Original channel ID: ' + result.originalChannelId + '.';
      if (config.supportCategoryId) {
        await ensureAuditDeveloperInfrastructure(guild, config.supportCategoryId);
        await logTicketEvent(guild, config.supportCategoryId, {
          ticketNumber: result.ticketNumber,
          ticketChannelId: ticket?.channelId ?? result.originalChannelId,
          event: eventName,
          actorId: interaction.user.id,
          actor: interaction.user.tag,
          actorName: interaction.user.tag,
          detail,
        });
        await logSystemEvent(guild, config.supportCategoryId, 'DEVELOPER_' + eventName, detail);
      }
      if (answer === 'yes') {
        await showRecoveryCandidateDetail(interaction, ticketId, 'ticket_button');
      } else {
        const embed = await recoveryEmbed(guild, '✅ Deletion review saved', 'The answer was recorded as **No, this deletion was intentional**. The response, reviewer ID and timestamp were written to the ticket audit stream and developer/system audit stream. This ticket will not appear in the accidental-deletion restoration path.');
        await interaction.editReply({
          content: '',
          embeds: [embed],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(recoveryButton('sf:settings:recovery:review', 'Back to Ticket Deletion Review', ButtonStyle.Secondary, '↩️'))],
        });
      }
    } catch (error) {
      const embed = await recoveryEmbed(guild, '❌ Could not save deletion review', error instanceof Error ? error.message : 'Unknown review error.');
      await interaction.editReply({ content: '', embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(recoveryButton('sf:settings:recovery:review', 'Back to review list', ButtonStyle.Secondary, '↩️'))] });
    }
    return true;
  }
  if (id.startsWith('sf:settings:recovery:review:restore:')) {
    await ensureRecoveryReply(interaction);
    const ticketId = id.slice('sf:settings:recovery:review:restore:'.length);
    try {
      const restored = await restoreArchivedTicket(guild, ticketId, 'ticket_button');
      const config = await getGuildConfig(guild.id);
      const ticket = await getPersistedTicketById(ticketId);
      if (config.supportCategoryId) {
        await ensureAuditDeveloperInfrastructure(guild, config.supportCategoryId);
        await logTicketEvent(guild, config.supportCategoryId, {
          ticketNumber: restored.ticketNumber,
          ticketChannelId: ticket?.channelId ?? restored.channelId,
          event: 'TICKET_RESTORED_AFTER_ACCIDENTAL_BUTTON_DELETION',
          actorId: interaction.user.id,
          actor: interaction.user.tag,
          actorName: interaction.user.tag,
          detail: 'Moderator restored a ticket-button deletion marked accidental. Replacement channel ' + restored.channelId + '; replayed messages=' + restored.restoredMessages + '; failed=' + restored.failedMessages + '.',
        });
        await logSystemEvent(guild, config.supportCategoryId, 'TICKET_ACCIDENTAL_DELETION_RECOVERED',
          'Moderator ' + interaction.user.tag + ' restored ticket #' + restored.ticketNumber + ' after marking its ticket-button deletion accidental. New channel ID: ' + restored.channelId + '.');
      }
      const embed = await recoveryEmbed(guild, '✅ Accidentally deleted ticket restored', 'Ticket #' + restored.ticketNumber + ' is available in ' + '<#' + restored.channelId + '>.\\n\\nReplayed messages: **' + restored.restoredMessages + '**\\nMessages that failed to replay: **' + restored.failedMessages + '**\\n\\nThe new channel has a new ID and URL. Recovery messages clearly show their original user and channel IDs.');
      await interaction.editReply({ content: '', embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(recoveryButton('sf:settings:recovery:review', 'Back to Ticket Deletion Review', ButtonStyle.Secondary, '↩️'))] });
    } catch (error) {
      const embed = await recoveryEmbed(guild, '❌ Ticket recovery failed', error instanceof Error ? error.message : 'Unknown recovery error.');
      await interaction.editReply({ content: '', embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(recoveryButton('sf:settings:recovery:review', 'Back to Ticket Deletion Review', ButtonStyle.Secondary, '↩️'))] });
    }
    return true;
  }
  return true;
}

export async function handleSettingsInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ModalSubmitInteraction,
): Promise<boolean> {
  if (!interaction.guild) return false;

  /*
   * Acknowledge settings select menus immediately. This must happen before
   * authorization/configuration lookups because Discord expires unacknowledged
   * component interactions after a few seconds.
   */
  if ((interaction.isStringSelectMenu() || interaction.isRoleSelectMenu()) && !interaction.customId.startsWith('sf:settings:recovery:')) {
    await interaction.deferUpdate().catch(() => undefined);
  }

  if (
    (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isModalSubmit()) &&
    (interaction.customId.startsWith('sf:settings:'))
  ) {
    if (!isSettingsChannel(interaction)) {
      await reject(interaction, '❌ ResolvX settings can only be used from the ResolvX settings channel.');
      return true;
    }

    const manualAction = interaction.customId === 'sf:settings:manual' ||
      interaction.customId === 'sf:settings:manual:quick' ||
      interaction.customId === 'sf:settings:manual:detailed';

    if (!isAdministrator(interaction) && !(manualAction && await isDepartmentStaff(interaction))) {
      await reject(
        interaction,
        manualAction
          ? '❌ The Staff Manual is available to configured department staff or administrators.'
          : '❌ You need **Manage Server** or **Administrator** to change ResolvX settings.',
      );
      return true;
    }
  } else {
    return false;
  }

  const guild = interaction.guild;

  if (interaction.isStringSelectMenu() && interaction.customId === 'sf:settings:diagnostics:snapshot-select') {
    const snapshotId = interaction.values[0];
    const review = await reviewConfigurationSnapshot(guild.id, snapshotId);
    const snapshot = review?.snapshot ?? null;
    if (!review || !snapshot) {
      await interaction.followUp({ content: 'That configuration snapshot is no longer available. Refresh the snapshot list.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const config = await getGuildConfig(guild.id).catch(() => null);
    await interaction.followUp({
      flags: MessageFlags.Ephemeral,
      embeds: [new EmbedBuilder()
        .setColor(getThemeColor(config?.theme ?? 'midnight'))
        .setTitle('Review Configuration Restore')
        .setDescription(
          '**Snapshot:** `' + snapshot.id + '`\n' +
          '**Saved:** <t:' + Math.floor(Date.parse(snapshot.createdAt) / 1000) + ':F>\n' +
          '**Reason:** ' + snapshot.reason + '\n' +
          '**Departments / panels / tags / forms / schedules:** ' +
          snapshot.departmentCount + ' / ' + snapshot.panelCount + ' / ' + snapshot.tagCount + ' / ' + (snapshot.formCount ?? 0) + ' / ' + (snapshot.supportHoursPolicyCount ?? 0) +
          '\n\n**Detected differences**\n' +
          (review.changedSections.length ? review.changedSections.map((section) => '• ' + section).join('\n') : 'No differences were detected in the reviewed sections.') +
          '\n\n**Saved → current counts**\n' +
          'Departments: ' + snapshot.departmentCount + ' → ' + review.currentCounts.departmentCount + '\n' +
          'Panels: ' + snapshot.panelCount + ' → ' + review.currentCounts.panelCount + '\n' +
          'Tags: ' + snapshot.tagCount + ' → ' + review.currentCounts.tagCount + '\n' +
          'Forms: ' + (snapshot.formCount ?? 0) + ' → ' + review.currentCounts.formCount + '\n' +
          'Support-hours policies: ' + (snapshot.supportHoursPolicyCount ?? 0) + ' → ' + review.currentCounts.supportHoursPolicyCount +
          '\n\nThis preview is read-only. Restoring replaces this server’s guild configuration and advanced settings, but does not intentionally delete ticket records, messages, transcripts or audit history. A checkpoint of current configuration is saved before restore.'
        )],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('sf:settings:diagnostics:restore-preview:' + snapshot.id + ':' + review.currentFingerprint)
          .setLabel('Continue to Confirmation')
          .setEmoji('⚠️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('sf:settings:diagnostics:snapshots')
          .setLabel('Cancel / Back')
          .setEmoji('↩️')
          .setStyle(ButtonStyle.Secondary),
      )],
    });
    return true;
  }


  if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.customId.startsWith('sf:settings:recovery:')) {
    return await handleTicketRecoveryInteraction(interaction);
  }

  if (
    (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) &&
    interaction.customId.startsWith('sf:settings:forms:')
  ) {
    return await handleTicketFormSettingsInteraction(interaction);
  }

  if (interaction.customId.startsWith('sf:settings:panels:')) {
    return await handleCustomPanelSettingsInteraction(interaction);
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'sf:settings:theme:select') {
    const selectedTheme = interaction.values[0];
    if (!isGuildTheme(selectedTheme)) {
      await reject(interaction, '❌ That theme selection is not supported.');
      return true;
    }

    const before = (await getGuildConfig(guild.id)).theme;
    if (before !== selectedTheme) {
      await updateGuildConfig(guild.id, (current) => {
        current.theme = selectedTheme;
      });
      await syncPanel(guild);
      await refreshSettingsChannel(guild);
      await refreshAuditPanelTheme(guild);
      await auditSettingsAction(
        guild,
        interaction,
        'SERVER_THEME_CHANGED',
        'Changed the server UI theme from ' + getThemeDefinition(before).label + ' to ' + getThemeDefinition(selectedTheme).label + '.',
      );
    }

    await showThemeSettings(
      interaction,
      '✅ Theme set to **' + getThemeDefinition(selectedTheme).label + '** for this server.',
    );
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sf:settings:reports:subcategory:pick:')) {
    const categoryId = interaction.customId.slice('sf:settings:reports:subcategory:pick:'.length);
    const subcategoryId = interaction.values[0];
    const settings = await getAdvancedSettings(guild.id);
    const sub = settings.reports.categories[categoryId]?.subcategories[subcategoryId];
    if (!sub) { await reject(interaction, '❌ Report subcategory not found.'); return true; }
    await interaction.editReply({
      content: 'Edit or remove **' + sub.name + '**.',
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('sf:settings:reports:subcategory:edit:' + categoryId + ':' + subcategoryId).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('sf:settings:reports:subcategory:remove:' + categoryId + ':' + subcategoryId).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      )],
    });
    return true;
  }

  if (interaction.isRoleSelectMenu() && interaction.customId === 'sf:settings:inactivity:exempt-roles') {
    const selectedRoleIds = [...new Set(interaction.values)].slice(0, 25);
    await updateAdvancedSettings(guild.id, (settings) => {
      settings.inactivity.exemptRoleIds = selectedRoleIds;
      settings.inactivity.generation = Math.min(2147483647, settings.inactivity.generation + 1);
    });
    await clearTicketInactivityWarningsForGuild(guild);
    await refreshSettingsChannel(guild);
    await auditSettingsAction(guild, interaction, 'TICKET_INACTIVITY_EXEMPT_ROLES_CHANGED',
      'Set inactivity-exempt roles to ' + (selectedRoleIds.join(', ') || 'none') + '.');
    await showInactivitySettings(interaction, '✅ Inactivity role exemptions saved.');
    return true;
  }

  if (interaction.isButton()) {
    const id = interaction.customId;

    if (
      id === 'sf:settings:diagnostics' ||
      id === 'sf:settings:diagnostics:refresh' ||
      id === 'sf:settings:diagnostics:setup-doctor' ||
      id.startsWith('sf:settings:diagnostics:page:')
    ) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const pageMatch = id.match(/^sf:settings:diagnostics:page:(health|setup-doctor):([1-9][0-9]{0,2})$/);
        const mode: 'health' | 'setup-doctor' = pageMatch
          ? pageMatch[1] as 'health' | 'setup-doctor'
          : id === 'sf:settings:diagnostics:setup-doctor' ? 'setup-doctor' : 'health';
        const requestedPage = pageMatch ? Number(pageMatch[2]) : 1;
        const report = await runSystemDiagnostics(interaction.guild!, mode);
        const config = await getGuildConfig(interaction.guild!.id).catch(() => null);
        const themeColor = getThemeColor(config?.theme ?? 'midnight');
        const pageCount = diagnosticsPageCount(report);
        const page = Math.min(pageCount, Math.max(1, requestedPage));
        const components: Array<ActionRowBuilder<ButtonBuilder>> = [];

        if (pageCount > 1) {
          components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('sf:settings:diagnostics:page:' + mode + ':' + Math.max(1, page - 1))
              .setLabel('Previous Checks')
              .setEmoji('◀️')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(page <= 1),
            new ButtonBuilder()
              .setCustomId('sf:settings:diagnostics:page:' + mode + ':' + Math.min(pageCount, page + 1))
              .setLabel('Next Checks')
              .setEmoji('▶️')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(page >= pageCount),
            new ButtonBuilder()
              .setCustomId('sf:settings:diagnostics:refresh')
              .setLabel('Refresh All Checks')
              .setEmoji('🔄')
              .setStyle(ButtonStyle.Primary),
          ));
        }

        components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('sf:settings:diagnostics:setup-doctor')
            .setLabel('Setup Doctor')
            .setEmoji('🩺')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('sf:settings:diagnostics:snapshot')
            .setLabel('Save Snapshot')
            .setEmoji('📸')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('sf:settings:diagnostics:snapshots')
            .setLabel('View Snapshots')
            .setEmoji('🗂️')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('sf:settings:repair:back')
            .setLabel('Repair System')
            .setEmoji('↩️')
            .setStyle(ButtonStyle.Secondary),
        ));

        await interaction.editReply({
          embeds: [buildSystemDiagnosticsEmbed(report, themeColor, page)],
          components,
        });
      } catch (error) {
        console.error('System diagnostics failed:', error);
        await interaction.editReply('Diagnostics could not complete. The bot did not attempt any repair. Check the bot logs for a sanitized diagnostic error.');
      }
      return true;
    }

    if (id === 'sf:settings:diagnostics:snapshot' || id === 'sf:settings:diagnostics:snapshots') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (id === 'sf:settings:diagnostics:snapshot') {
          const snapshot = await createConfigurationSnapshot(
            guild.id,
            { id: interaction.user.id, name: interaction.user.tag },
            'Saved from the Settings System Health panel',
          );
          const config = await getGuildConfig(guild.id).catch(() => null);
          if (config?.supportCategoryId) {
            await logSettingsEvent(guild, config.supportCategoryId, {
              action: 'CONFIGURATION_SNAPSHOT_CREATED',
              actorId: interaction.user.id,
              actorName: interaction.user.tag,
              detail: 'Saved configuration checkpoint ' + snapshot.id + '.',
            }).catch(() => undefined);
          }
          await interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor(getThemeColor(config?.theme ?? 'midnight'))
              .setTitle('✅ Configuration checkpoint saved')
              .setDescription(
                '**Snapshot:** `' + snapshot.id + '`\n' +
                '**Departments:** ' + snapshot.departmentCount + '\n' +
                '**Panels:** ' + snapshot.panelCount + '\n' +
                '**Tags:** ' + snapshot.tagCount + '\n' +
                '**Forms:** ' + (snapshot.formCount ?? 0) + '\n' +
                '**Support-hours policies:** ' + (snapshot.supportHoursPolicyCount ?? 0) + '\n\n' +
                'A maximum of 10 recent checkpoints is kept per server.',
              )],
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId('sf:settings:diagnostics:snapshots').setLabel('View Snapshots').setEmoji('🗂️').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId('sf:settings:repair:back').setLabel('Repair System').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
            )],
          });
          return true;
        }

        const snapshots = await listConfigurationSnapshots(guild.id);
        const config = await getGuildConfig(guild.id).catch(() => null);
        const embed = new EmbedBuilder()
          .setColor(getThemeColor(config?.theme ?? 'midnight'))
          .setTitle('🗂️ Configuration History')
          .setDescription(snapshots.length
            ? snapshots.map((snapshot) =>
                '**`' + snapshot.id + '`** · <t:' + Math.floor(Date.parse(snapshot.createdAt) / 1000) + ':R>\n' +
                snapshot.reason + '\nDepartments: ' + snapshot.departmentCount + ' · Panels: ' + snapshot.panelCount + ' · Tags: ' + snapshot.tagCount + ' · Forms: ' + (snapshot.formCount ?? 0) + ' · Hours policies: ' + (snapshot.supportHoursPolicyCount ?? 0),
              ).join('\n\n').slice(0, 4000)
            : 'No snapshots saved yet. Save one before changing important configuration.');
        if (!snapshots.length) {
          await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('sf:settings:diagnostics:snapshot').setLabel('Save Snapshot').setEmoji('📸').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('sf:settings:repair:back').setLabel('Repair System').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
          )] });
          return true;
        }
        const select = new StringSelectMenuBuilder()
          .setCustomId('sf:settings:diagnostics:snapshot-select')
          .setPlaceholder('Choose a checkpoint to review')
          .addOptions(snapshots.slice(0, 10).map((snapshot) => ({
            label: (snapshot.reason || 'Configuration checkpoint').slice(0, 100),
            description: (snapshot.id + ' · ' + snapshot.departmentCount + ' departments · ' + snapshot.panelCount + ' panels · ' + (snapshot.formCount ?? 0) + ' forms').slice(0, 100),
            value: snapshot.id,
          })));
        await interaction.editReply({
          embeds: [embed],
          components: [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId('sf:settings:diagnostics:snapshot').setLabel('Save New Snapshot').setEmoji('📸').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId('sf:settings:repair:back').setLabel('Repair System').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
      } catch (error) {
        console.error('Configuration history action failed:', error);
        await interaction.editReply('Configuration history could not be read or saved. No destructive repair was attempted; inspect the database document status before retrying.');
      }
      return true;
    }

    if (id.startsWith('sf:settings:diagnostics:restore-preview:')) {
      const [snapshotId = '', expectedFingerprint = ''] = id.slice('sf:settings:diagnostics:restore-preview:'.length).split(':');
      const review = await reviewConfigurationSnapshot(guild.id, snapshotId);
      const snapshot = review?.snapshot ?? null;
      if (!review || !snapshot) {
        await interaction.reply({ content: 'That snapshot no longer exists. Reopen Configuration History and select a current checkpoint.', flags: MessageFlags.Ephemeral });
        return true;
      }
      try {
        assertCurrentConfigurationFingerprint(expectedFingerprint, review.currentFingerprint);
      } catch {
        await interaction.reply({
          content: 'Settings changed after you selected this checkpoint. Nothing was restored. Reopen Configuration History, select the checkpoint again and review the fresh preview.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [new EmbedBuilder()
          .setColor(0xdc2626)
          .setTitle('⚠️ Confirm Configuration Restore')
          .setDescription(
            'You selected `' + snapshot.id + '` (' + snapshot.reason + ').\n\n' +
            '**Configuration areas that differ now:**\n' +
            (review.changedSections.length ? review.changedSections.map((section) => '• ' + section).join('\n') : 'No differences were detected in the reviewed sections.') + '\n\n' +
            '**Saved → current counts:** departments ' + snapshot.departmentCount + ' → ' + review.currentCounts.departmentCount +
            ', panels ' + snapshot.panelCount + ' → ' + review.currentCounts.panelCount +
            ', tags ' + snapshot.tagCount + ' → ' + review.currentCounts.tagCount +
            ', forms ' + (snapshot.formCount ?? 0) + ' → ' + review.currentCounts.formCount +
            ', support-hours ' + (snapshot.supportHoursPolicyCount ?? 0) + ' → ' + review.currentCounts.supportHoursPolicyCount + '.\n\n' +
            'ResolveX will first save a checkpoint of current settings, then restore the saved guild configuration and advanced settings. This does not restore old Discord channel names/messages or change ticket/transcript records.\n\n' +
            '**Preview fingerprint:** \`' + review.currentFingerprint + '\`\n' +
            'The fingerprint is tied to the current configuration and is checked again at restore time. If settings change, restore is refused and you must review a fresh preview.'          )],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('sf:settings:diagnostics:restore-confirm:' + snapshot.id + ':' + interaction.user.id + ':' + expectedFingerprint)
            .setLabel('Confirm Restore')
            .setEmoji('⚠️')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('sf:settings:repair:back')
            .setLabel('Cancel')
            .setEmoji('↩️')
            .setStyle(ButtonStyle.Secondary),
        )],
      });
      return true;
    }

    if (id.startsWith('sf:settings:diagnostics:restore-confirm:')) {
      const tail = id.slice('sf:settings:diagnostics:restore-confirm:'.length).split(':');
      const snapshotId = tail[0] ?? '';
      const actorId = tail[1] ?? '';
      const expectedFingerprint = tail[2] ?? '';
      if (actorId !== interaction.user.id) {
        await interaction.reply({ content: 'This confirmation belongs to another administrator. Return to Settings and initiate your own restore.', flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await restoreConfigurationSnapshot(
          guild.id,
          snapshotId,
          'RESTORE ' + snapshotId,
          { id: interaction.user.id, name: interaction.user.tag },
          expectedFingerprint,
        );
        const config = await getGuildConfig(guild.id).catch(() => null);
        if (config?.supportCategoryId) {
          await logSettingsEvent(guild, config.supportCategoryId, {
            action: 'CONFIGURATION_SNAPSHOT_RESTORED',
            actorId: interaction.user.id,
            actorName: interaction.user.tag,
            detail: 'Restored snapshot ' + result.restored.id + '; automatic checkpoint ' + result.checkpoint.id + '.',
          }).catch(() => undefined);
        }
        const failures: string[] = [];
        await syncPanel(guild).catch(() => failures.push('public panel'));
        await refreshSettingsChannel(guild).catch(() => failures.push('Settings dashboard'));
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor(getThemeColor(config?.theme ?? 'midnight'))
            .setTitle('✅ Configuration checkpoint restored')
            .setDescription(
              '**Restored:** `' + result.restored.id + '`\n' +
              '**Pre-restore checkpoint:** `' + result.checkpoint.id + '`\n\n' +
              'Restored guild/advanced settings, support-hours policies and current schemas for forms present in the checkpoint using new immutable versions. Existing submissions, historical form versions and forms created after the checkpoint were not deleted.' +
              (failures.length ? '\n\n⚠️ Refresh failed for: ' + failures.join(', ') + '. Use the Settings Refresh action after checking permissions.' : ''),
            )],
        });
      } catch (error) {
        console.error('Configuration restore failed:', error);
        await interaction.editReply('Configuration restore was not completed. Check the diagnostic logs and use the saved pre-restore checkpoint if an operation partially failed.');
      }
      return true;
    }

    if (id === 'sf:settings:repair:back') {
      await showRepairSystem(interaction);
      return true;
    }

    if (id === 'sf:settings:home') {
      await restoreSettingsHome(interaction);
      return true;
    }

    if (id === 'sf:settings:language') {
      await showLanguageSettings(interaction);
      return true;
    }

    if (id === 'sf:settings:manual') {
      await showManual(interaction);
      return true;
    }

    if (id === 'sf:settings:manual:quick') {
      await showManualVersion(interaction, false);
      return true;
    }

    if (id === 'sf:settings:manual:detailed') {
      await showManualVersion(interaction, true);
      return true;
    }

    if (id === 'sf:settings:rules') {
      await showPriorityRules(interaction);
      return true;
    }

    if (
      id.startsWith('sf:settings:rules:create:') ||
      id.startsWith('sf:settings:rules:delete:')
    ) {
      const deleting = id.startsWith('sf:settings:rules:delete:');
      const prefix = deleting
        ? 'sf:settings:rules:delete:'
        : 'sf:settings:rules:create:';
      const priority = id.slice(prefix.length);

      if (!Object.prototype.hasOwnProperty.call(PRIORITY_ROLE_DEFINITIONS, priority)) {
        await reject(interaction, '❌ Unknown priority rule.');
        return true;
      }

      if (deleting) {
        await deletePriorityRole(interaction, priority as TicketPriority);
      } else {
        await createPriorityRole(interaction, priority as TicketPriority);
      }
      return true;
    }

    if (id === 'sf:settings:reset') {
      await showResetStepOne(interaction);
      return true;
    }

    if (id === 'sf:settings:reset:audit:no' || id === 'sf:settings:reset:audit:yes') {
      pendingResetAuditChoice.set(guild.id, id.endsWith(':yes'));
      await showResetStepTwo(interaction);
      return true;
    }

    if (id === 'sf:settings:reset:confirm2') {
      await showResetStepTwo(interaction);
      return true;
    }

    if (id === 'sf:settings:reset:confirm3') {
      await showResetFinal(interaction);
      return true;
    }

    if (id === 'sf:settings:refresh') {
      await interaction.deferUpdate();
      await refreshSettingsChannel(guild);
      await auditSettingsAction(
        guild,
        interaction,
        'SETTINGS_REFRESH',
        'Settings dashboard refreshed and the current dashboard message was replaced with the latest persisted configuration.',
      );
      return true;
    }

    if (id === 'sf:settings:premium') {
      await showPremiumSettings(interaction);
      return true;
    }

    if (id === 'sf:settings:premium:toggle') {
      const current = await getTier(guild.id);
      const next = current === 'free' ? 'premium-demo' : current === 'premium-demo' ? 'pro-demo' : 'free';
      await setTier(guild.id, next);
      await refreshSettingsChannel(guild);
      await auditSettingsAction(guild, interaction, 'TIER_CHANGED', 'Tier changed from ' + tierLabel(current) + ' to ' + tierLabel(next) + '.');
      await showPremiumSettings(interaction, '✅ Tier changed: **' + tierLabel(current) + '** → **' + tierLabel(next) + '**.');
      return true;
    }

    if (id === SETTINGS_LAYOUT_PREFIX || id === SETTINGS_LAYOUT_PREFIX + ':home') {
      await showSettingsDashboardBuilder(interaction);
      return true;
    }

    if (id.startsWith(SETTINGS_LAYOUT_PREFIX + ':customize:')) {
      const rawKey = id.slice((SETTINGS_LAYOUT_PREFIX + ':customize:').length);
      if (!(SETTINGS_DASHBOARD_BUTTON_KEYS as readonly string[]).includes(rawKey)) {
        await reject(interaction, 'That Settings control is not supported.');
        return true;
      }
      const key = rawKey as SettingsDashboardButtonKey;
      const settings = await getAdvancedSettings(guild.id);
      const saved = settings.settingsDashboard.buttonCustomizations[key];
      const label = new TextInputBuilder()
        .setCustomId('label')
        .setLabel('Button label (type default to reset)')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(80)
        .setRequired(true)
        .setValue((saved?.label ?? SETTINGS_LAYOUT_LABELS[key]).slice(0, 80));
      const emoji = new TextInputBuilder()
        .setCustomId('emoji')
        .setLabel('Emoji (type none to remove)')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(false)
        .setPlaceholder(SETTINGS_LAYOUT_DEFAULT_EMOJIS[key]);
      emoji.setValue(saved ? (saved.emoji ?? 'none') : SETTINGS_LAYOUT_DEFAULT_EMOJIS[key]);
      await openModal(interaction, 'sf:settings:modal:dashboard-button:' + key, 'Customize Settings Button', [label, emoji]);
      return true;
    }

    if (id === SETTINGS_LAYOUT_PREFIX + ':edit') {
      const settings = await getAdvancedSettings(guild.id);
      const description = new TextInputBuilder().setCustomId('description').setLabel('Dashboard description').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(false);
      if (settings.settingsDashboard.description) description.setValue(settings.settingsDashboard.description.slice(0, 4000));
      const footer = new TextInputBuilder().setCustomId('footer').setLabel('Dashboard footer').setStyle(TextInputStyle.Short).setMaxLength(1800).setRequired(false).setValue(settings.settingsDashboard.footer.slice(0, 1800));
      await openModal(interaction, 'sf:settings:modal:dashboard-builder', 'Settings Dashboard Branding', [
        new TextInputBuilder().setCustomId('title').setLabel('Dashboard title').setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true).setValue(settings.settingsDashboard.title.slice(0, 256)),
        description,
        footer,
      ]);
      return true;
    }

    if (id === SETTINGS_LAYOUT_PREFIX + ':preview') {
      await showSettingsDashboardPreview(interaction);
      return true;
    }

    if (id === SETTINGS_LAYOUT_PREFIX + ':reset-order') {
      await interaction.deferUpdate();
      await updateAdvancedSettings(guild.id, (settings) => {
        settings.settingsDashboard.title = '⚙️ ResolvX Settings';
        settings.settingsDashboard.description = 'Configure your server’s ticket system, support panels and retention policies.';
        settings.settingsDashboard.footer = 'ResolvX • Settings Dashboard';
        settings.settingsDashboard.buttonOrder = [...SETTINGS_DASHBOARD_BUTTON_KEYS];
        settings.settingsDashboard.buttonCustomizations = {};
      });
      await refreshSettingsChannel(guild);
      await auditSettingsAction(guild, interaction, 'SETTINGS_DASHBOARD_LAYOUT_RESET', 'Reset the per-server Settings dashboard branding, order, labels and emojis.');
      await showSettingsDashboardBuilder(interaction, '✅ The default Settings dashboard branding, order, labels and emojis have been restored.');
      return true;
    }

    if (id.startsWith(SETTINGS_LAYOUT_PREFIX + ':up:') || id.startsWith(SETTINGS_LAYOUT_PREFIX + ':down:')) {
      const movingUp = id.startsWith(SETTINGS_LAYOUT_PREFIX + ':up:');
      const key = id.slice((SETTINGS_LAYOUT_PREFIX + (movingUp ? ':up:' : ':down:')).length);
      if (!(SETTINGS_DASHBOARD_BUTTON_KEYS as readonly string[]).includes(key)) {
        await reject(interaction, 'That Settings control is not supported.');
        return true;
      }
      await interaction.deferUpdate();
      await updateAdvancedSettings(guild.id, (settings) => {
        const order = settingsButtonOrder(settings);
        const currentIndex = order.indexOf(key as SettingsDashboardButtonKey);
        const targetIndex = currentIndex + (movingUp ? -1 : 1);
        if (currentIndex < 0 || targetIndex < 0 || targetIndex >= order.length) return;
        [order[currentIndex], order[targetIndex]] = [order[targetIndex]!, order[currentIndex]!];
        settings.settingsDashboard.buttonOrder = order;
      });
      await refreshSettingsChannel(guild);
      await auditSettingsAction(guild, interaction, 'SETTINGS_DASHBOARD_ORDER_CHANGED', 'Moved ' + SETTINGS_LAYOUT_LABELS[key as SettingsDashboardButtonKey] + ' ' + (movingUp ? 'up' : 'down') + ' in the Settings dashboard.');
      await showSettingsDashboardOrder(interaction, key as SettingsDashboardButtonKey);
      return true;
    }

    if (id === 'sf:settings:ticket-workspace') {
      await showTicketWorkspaceSettings(interaction);
      return true;
    }

    if (id.startsWith('sf:settings:ticket-workspace:set:')) {
      const mode = id.slice('sf:settings:ticket-workspace:set:'.length);
      if (mode !== 'text-channels' && mode !== 'private-threads') {
        await reject(interaction, 'That ticket workspace mode is not supported.');
        return true;
      }
      const previous = (await getAdvancedSettings(guild.id)).ticketWorkspace.mode;
      await interaction.deferUpdate();
      await updateAdvancedSettings(guild.id, (current) => {
        current.ticketWorkspace.mode = mode;
      });
      await refreshSettingsChannel(guild);
      await auditSettingsAction(guild, interaction, 'TICKET_WORKSPACE_MODE_CHANGED', 'Changed ticket workspace mode from ' + previous + ' to ' + mode + '. Existing tickets were not migrated.');
      await showTicketWorkspaceSettings(interaction, '✅ New tickets will use **' + (mode === 'private-threads' ? 'private threads' : 'dedicated text channels') + '**. Existing tickets are unchanged.');
      return true;
    }

    if (id === 'sf:settings:support-hours') {
      await showSupportHoursSettings(interaction);
      return true;
    }

    if (id.startsWith('sf:settings:support-hours:view:')) {
      const scope = parseSupportHoursSettingsScope(id.split(':'));
      await showSupportHoursSettings(interaction, '', scope.scopeType, scope.scopeId);
      return true;
    }

    if (id.startsWith('sf:settings:support-hours:scope:') && interaction.isStringSelectMenu()) {
      const parts = id.split(':');
      const scopeType = parts[4] === 'department' || parts[4] === 'panel' ? parts[4] : null;
      const scopeId = (interaction as StringSelectMenuInteraction).values[0]?.trim();
      const config = await getGuildConfig(guild.id);
      const exists = scopeType === 'department'
        ? Boolean(scopeId && config.departments[scopeId])
        : scopeType === 'panel'
          ? Boolean(scopeId && config.customPanels[scopeId])
          : false;
      if (!scopeType || !scopeId || !exists) {
        await reject(interaction, 'That department or ticket panel no longer exists. Refresh the Support Hours view and choose an existing entry.');
        return true;
      }
      await showSupportHoursSettings(interaction, '', scopeType, scopeId);
      return true;
    }

    if (id.startsWith('sf:settings:support-hours:page:') && interaction.isButton()) {
      const parts = id.split(':');
      const departmentPage = Number(parts[4]);
      const panelPage = Number(parts[5]);
      const scope = parseSupportHoursSettingsScope(parts, 6);
      if (!Number.isInteger(departmentPage) || departmentPage < 0 || !Number.isInteger(panelPage) || panelPage < 0) {
        await reject(interaction, 'That Support Hours page control has expired. Reopen Support Hours and try again.');
        return true;
      }
      await showSupportHoursSettings(interaction, '', scope.scopeType, scope.scopeId, departmentPage, panelPage);
      return true;
    }

    if (id === 'sf:settings:support-hours:edit' || id.startsWith('sf:settings:support-hours:edit:')) {
      const scope = parseSupportHoursSettingsScope(id.split(':'));
      const context = supportHoursContext(scope);
      const local = await getSupportHoursPolicy(guild.id, scope.scopeType, scope.scopeId);
      const policies = await getSupportHoursPolicies(guild.id);
      const policy = local ?? resolveEffectiveSupportHoursPolicy(policies, context);
      const timezone = new TextInputBuilder()
        .setCustomId('timezone')
        .setLabel('IANA time zone (e.g. Asia/Kolkata)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
        .setValue((policy?.timezone ?? 'UTC').slice(0, 100));
      const schedule = new TextInputBuilder()
        .setCustomId('schedule')
        .setLabel('All seven weekdays: day=intervals')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('monday=09:00-17:00\ntuesday=09:00-17:00\n...\nsunday=closed')
        .setRequired(true)
        .setMaxLength(4000)
        .setValue((policy ? formatSupportHoursWeeklySchedule(policy.weeklySchedule) : SUPPORT_HOURS_DAYS.map((day) => day + '=closed').join('\n')).slice(0, 4000));
      await openModal(interaction, 'sf:settings:modal:support-hours:' + scope.scopeType + ':' + (scope.scopeId ?? '-'), 'Edit Support Hours', [timezone, schedule]);
      return true;
    }

    if (id === 'sf:settings:support-hours:toggle' || id.startsWith('sf:settings:support-hours:toggle:')) {
      const scope = parseSupportHoursSettingsScope(id.split(':'));
      const context = supportHoursContext(scope);
      const current = await getSupportHoursPolicy(guild.id, scope.scopeType, scope.scopeId);
      const policies = await getSupportHoursPolicies(guild.id);
      const effective = resolveEffectiveSupportHoursPolicy(policies, context);
      const decision = await evaluateSupportHours(guild.id, context);
      const enabling = !decision.policyEnabled;
      const base = current ?? effective ?? createDefaultSupportHoursPolicy(scope.scopeType, scope.scopeId);
      const hasIntervals = SUPPORT_HOURS_DAYS.some((day) => base.weeklySchedule[day].length > 0);
      if (enabling && !hasIntervals) {
        await showSupportHoursSettings(interaction, 'Add at least one opening interval before enabling enforcement.', scope.scopeType, scope.scopeId);
        return true;
      }
      await interaction.deferUpdate();
      const saved = await saveSupportHoursPolicy(guild.id, {
        ...base,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        enabled: enabling,
        updatedBy: interaction.user.id,
      });
      await refreshSettingsChannel(guild);
      await auditSettingsAction(guild, interaction, 'SUPPORT_HOURS_CHANGED', 'Support-hours enforcement ' + (saved.enabled ? 'enabled' : 'disabled') + ' for ' + scope.scopeType + (scope.scopeId ? ' ' + scope.scopeId : '') + '; policy version=' + saved.version + '.');
      await showSupportHoursSettings(interaction, saved.enabled ? '✅ Support-hours enforcement enabled.' : 'Support-hours enforcement disabled.', scope.scopeType, scope.scopeId);
      return true;
    }

    if (id === 'sf:settings:support-hours:behavior' || id.startsWith('sf:settings:support-hours:behavior:')) {
      const scope = parseSupportHoursSettingsScope(id.split(':'));
      const current = await getSupportHoursPolicy(guild.id, scope.scopeType, scope.scopeId);
      const policies = await getSupportHoursPolicies(guild.id);
      const effective = resolveEffectiveSupportHoursPolicy(policies, supportHoursContext(scope));
      const base = current ?? effective;
      if (!base) {
        await reject(interaction, 'Edit and save a weekly schedule first.');
        return true;
      }
      await interaction.deferUpdate();
      const behavior = base.outsideHoursBehavior === 'allow' ? 'restrict' : 'allow';
      const saved = await saveSupportHoursPolicy(guild.id, {
        ...base,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        outsideHoursBehavior: behavior,
        updatedBy: interaction.user.id,
      });
      await refreshSettingsChannel(guild);
      await auditSettingsAction(guild, interaction, 'SUPPORT_HOURS_CHANGED', 'Outside-hours behavior for ' + scope.scopeType + (scope.scopeId ? ' ' + scope.scopeId : '') + ' changed to ' + behavior + '; policy version=' + saved.version + '.');
      await showSupportHoursSettings(interaction, '✅ Outside-hours behavior set to ' + behavior + '.', scope.scopeType, scope.scopeId);
      return true;
    }

    if (id === 'sf:settings:support-hours:clear' || id.startsWith('sf:settings:support-hours:clear:')) {
      const scope = parseSupportHoursSettingsScope(id.split(':'));
      await interaction.deferUpdate();
      const removed = await deleteSupportHoursPolicy(guild.id, scope.scopeType, scope.scopeId);
      await refreshSettingsChannel(guild);
      if (removed) await auditSettingsAction(guild, interaction, 'SUPPORT_HOURS_CHANGED', 'Removed the ' + scope.scopeType + (scope.scopeId ? ' ' + scope.scopeId : '') + ' support-hours policy; inherited schedules now apply.');
      const notice = removed
        ? scope.scopeType === 'guild'
          ? '✅ Server default removed. More-specific overrides still apply.'
          : '✅ Override removed. The inherited schedule now applies.'
        : 'No support-hours policy existed at this scope.';
      await showSupportHoursSettings(interaction, notice, scope.scopeType, scope.scopeId);
      return true;
    }

    if (id === 'sf:settings:panel') {
      await showPanelSettings(interaction);
      return true;
    }

    if (id === 'sf:settings:panel:toggle') {
      const before = (await getAdvancedSettings(guild.id)).panelActivity.enabled;
      await interaction.deferUpdate();
      await updateAdvancedSettings(guild.id, (settings) => {
        settings.panelActivity.enabled = !settings.panelActivity.enabled;
      });
      await refreshSettingsChannel(guild);
      await showHomeAfterUpdate(interaction);
      await auditSettingsAction(guild, interaction, 'PANEL_TOGGLE', 'Automatic panel movement: ' + (before ? 'enabled → disabled' : 'disabled → enabled') + '.');
      return true;
    }

    if (id === 'sf:settings:panel:thresholds') {
      await openModal(interaction, 'sf:settings:modal:panel', 'Panel Thresholds', [
        new TextInputBuilder().setCustomId('visual').setLabel('Visual line budget (6-40)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String((await getAdvancedSettings(guild.id)).panelActivity.visualLineBudget)),
        new TextInputBuilder().setCustomId('messages').setLabel('Message safety cap (5-30)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String((await getAdvancedSettings(guild.id)).panelActivity.messageBudget)),
        new TextInputBuilder().setCustomId('minimum').setLabel('Minimum messages (3-20)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String((await getAdvancedSettings(guild.id)).panelActivity.minimumMessagesBeforeMove)),
      ]);
      return true;
    }

    if (id === 'sf:settings:team') {
      await showTeamSettings(interaction);
      return true;
    }

    if (id === 'sf:settings:team:edit') {
      const settings = await getAdvancedSettings(guild.id);
      await openModal(interaction, 'sf:settings:modal:team', 'Team & Voice', [
        new TextInputBuilder().setCustomId('maxModerators').setLabel('Maximum simultaneous moderators (1-3)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.ticketDefaults.maxClaimedModerators)),
      ]);
      return true;
    }

    if (id === 'sf:settings:reports') {
      await showReportSettings(interaction);
      return true;
    }

    if (id === 'sf:settings:reports:toggle') {
      await interaction.deferUpdate();
      await updateAdvancedSettings(guild.id, (settings) => { settings.reports.enabled = !settings.reports.enabled; });
      await refreshSettingsChannel(guild);
      await showReportSettings(interaction);
      return true;
    }

    if (id === 'sf:settings:reports:rules') {
      const settings = await getAdvancedSettings(guild.id);
      const ticketRule = Object.values(settings.reports.flagRules).find((r) => r.action === 'tickets');
      const serverRule = Object.values(settings.reports.flagRules).find((r) => r.action === 'server');
      const channelRule = Object.values(settings.reports.flagRules).find((r) => r.action === 'channel');
      await openModal(interaction, 'sf:settings:modal:report-rules', 'Report Flag Rules', [
        new TextInputBuilder().setCustomId('tickets').setLabel('Ticket restriction threshold (0 = off)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(ticketRule?.threshold ?? 5)),
        new TextInputBuilder().setCustomId('server').setLabel('Server ban threshold (0 = off)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(serverRule?.threshold ?? 10)),
        new TextInputBuilder().setCustomId('channel').setLabel('Channel restriction threshold (0 = off)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(channelRule?.threshold ?? 0)),
        new TextInputBuilder().setCustomId('channelId').setLabel('Channel ID / mention for channel rule').setStyle(TextInputStyle.Short).setRequired(false).setValue(channelRule?.channelId ? '<#' + channelRule.channelId + '>' : ''),
      ]);
      return true;
    }

    if (id.startsWith('sf:settings:reports:category:')) {
      await showReportCategorySettings(interaction, id.slice('sf:settings:reports:category:'.length));
      return true;
    }

    if (id.startsWith('sf:settings:reports:subcategory:add:')) {
      const categoryId = id.slice('sf:settings:reports:subcategory:add:'.length);
      await openModal(interaction, 'sf:settings:modal:report-subcategory:add:' + categoryId, 'Add Report Subcategory', [
        new TextInputBuilder().setCustomId('name').setLabel('Subcategory name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
      ]);
      return true;
    }

    if (id.startsWith('sf:settings:reports:subcategory:select:')) {
      const remainder = id.slice(
        'sf:settings:reports:subcategory:select:'.length,
      );
      const parts = remainder.split(':');
      const categoryId = parts[0] ?? '';
      const page = Number(parts[1] ?? '0');
      await showReportSubcategorySelector(
        interaction,
        categoryId,
        Number.isInteger(page) ? page : 0,
      );
      return true;
    }

    if (id.startsWith('sf:settings:reports:subcategory:edit:')) {
      const parts = id.split(':'); const categoryId = parts[5] ?? ''; const subcategoryId = parts[6] ?? '';
      const sub = (await getAdvancedSettings(guild.id)).reports.categories[categoryId]?.subcategories[subcategoryId];
      if (!sub) { await reject(interaction, '❌ Report subcategory not found.'); return true; }
      await openModal(interaction, 'sf:settings:modal:report-subcategory:edit:' + categoryId + ':' + subcategoryId, 'Edit Report Subcategory', [
        new TextInputBuilder().setCustomId('name').setLabel('Subcategory name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(sub.name),
      ]);
      return true;
    }

    if (id.startsWith('sf:settings:reports:subcategory:remove:')) {
      const parts = id.split(':'); const categoryId = parts[5] ?? ''; const subcategoryId = parts[6] ?? '';
      const settings = await getAdvancedSettings(guild.id);
      const category = settings.reports.categories[categoryId];
      if (!category || !category.subcategories[subcategoryId]) { await reject(interaction, '❌ Report subcategory not found.'); return true; }
      if (Object.keys(category.subcategories).length <= 1) { await reject(interaction, '❌ Each report category must keep at least one subcategory.'); return true; }
      await interaction.deferUpdate();
      await updateAdvancedSettings(guild.id, (current) => { const item = current.reports.categories[categoryId]; if (item) delete item.subcategories[subcategoryId]; });
      await refreshSettingsChannel(guild);
      await showReportCategorySettings(interaction, categoryId);
      return true;
    }

    if (id === 'sf:settings:defaults') {
      await showDefaults(interaction);
      return true;
    }

    if (id === 'sf:settings:defaults:edit') {
      await openModal(interaction, 'sf:settings:modal:defaults', 'Ticket Defaults', [
        new TextInputBuilder().setCustomId('priority').setLabel('Default priority').setPlaceholder('low, normal, high, urgent, critical').setStyle(TextInputStyle.Short).setRequired(true),
      ]);
      return true;
    }

    if (id === 'sf:settings:tags' || id === 'sf:settings:departments') {
      await showTags(interaction);
      return true;
    }

    if (id === 'sf:settings:departments:add') {
      await openModal(interaction, 'sf:settings:modal:department:add', 'Add Department', [
        new TextInputBuilder().setCustomId('name').setLabel('Department name').setPlaceholder('Monetary Affairs').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
        new TextInputBuilder().setCustomId('staff').setLabel('Staff role ID or mention (optional)').setPlaceholder('@Finance Staff').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100),
      ]);
      return true;
    }

    if (id === 'sf:settings:departments:manage') {
      await showDepartmentPicker(interaction, 0);
      return true;
    }

    if (id.startsWith('sf:settings:departments:manage:page:')) {
      const page = Number(id.slice('sf:settings:departments:manage:page:'.length));
      if (!Number.isInteger(page)) {
        await reject(interaction, '❌ Invalid department page.');
        return true;
      }
      await showDepartmentPicker(interaction, page);
      return true;
    }

    if (id.startsWith('sf:settings:department:manage:')) {
      await showDepartmentManager(interaction, id.slice('sf:settings:department:manage:'.length));
      return true;
    }

    if (id.startsWith('sf:settings:department:edit:')) {
      const departmentId = id.slice('sf:settings:department:edit:'.length);
      const d = (await getGuildConfig(guild.id)).departments[departmentId];
      if (!d) { await reject(interaction, '❌ Department not found.'); return true; }
      await openModal(interaction, 'sf:settings:modal:department:edit:' + departmentId, 'Edit Department', [
        new TextInputBuilder().setCustomId('name').setLabel('Department name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(d.name),
        new TextInputBuilder().setCustomId('staff').setLabel('Staff role ID or mention (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setValue(d.staffRoleId ? '<@&' + d.staffRoleId + '>' : ''),
      ]);
      return true;
    }

    if (id.startsWith('sf:settings:tag:add:')) {
      const departmentId = id.slice('sf:settings:tag:add:'.length);
      await openModal(interaction, 'sf:settings:modal:tag:add:' + departmentId, 'Add Tag', [
        new TextInputBuilder().setCustomId('name').setLabel('Tag name').setPlaceholder('Billing, Refund, Chargeback').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
      ]);
      return true;
    }

    if (id.startsWith('sf:settings:tag:manage-page:')) {
      const parts = id.split(':');
      const departmentId = parts[5] ?? '';
      const page = Number(parts[6] ?? '0');
      if (!Number.isInteger(page)) {
        await reject(interaction, '❌ Invalid tag page.');
        return true;
      }
      await showTagManager(interaction, departmentId, page);
      return true;
    }

    if (id.startsWith('sf:settings:tag:manage:')) {
      await showTagManager(interaction, id.slice('sf:settings:tag:manage:'.length));
      return true;
    }

    if (id.startsWith('sf:settings:tag:edit:')) {
      const parts = id.split(':');
      const departmentId = parts[5] ?? ''; const tagId = parts[6] ?? '';
      const tag = (await getGuildConfig(guild.id)).departments[departmentId]?.tags?.[tagId];
      if (!tag) { await reject(interaction, '❌ Tag not found.'); return true; }
      await openModal(interaction, 'sf:settings:modal:tag:edit:' + departmentId + ':' + tagId, 'Edit Tag', [
        new TextInputBuilder().setCustomId('name').setLabel('Tag name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(tag.name),
      ]);
      return true;
    }

    if (id.startsWith('sf:settings:tag:remove:')) {
      const parts = id.split(':');
      const departmentId = parts[4] ?? ''; const tagId = parts[5] ?? '';
      const config = await getGuildConfig(guild.id); const d = config.departments[departmentId];
      if (!d?.tags?.[tagId]) { await reject(interaction, '❌ Tag not found.'); return true; }
      if (Object.keys(d.tags).length <= 1) { await reject(interaction, '❌ Each department must keep at least one tag.'); return true; }
      const replacement = Object.values(d.tags).find((t) => t.id !== tagId);
      if (!replacement) { await reject(interaction, '❌ No replacement tag is available.'); return true; }
      const removedTagName = d.tags[tagId].name;
      const departmentName = d.name;
      await updateGuildConfig(guild.id, (current) => {
        const item = current.departments[departmentId];
        if (item) delete item.tags[tagId];
      });
      await refreshSettingsChannel(guild); await syncPanel(guild); await showTagManager(interaction, departmentId);
      await auditSettingsAction(guild, interaction, 'TAG_REMOVED', 'Removed tag ' + removedTagName + ' from department ' + departmentName + '. Existing tickets keep their historical tag metadata.');
      return true;
    }

    if (id.startsWith('sf:settings:department:remove:')) {
      const departmentId = id.slice('sf:settings:department:remove:'.length);
      const config = await getGuildConfig(guild.id); const d = config.departments[departmentId];
      if (!d) { await reject(interaction, '❌ Department not found.'); return true; }
      if (Object.keys(config.departments).length <= 1) { await reject(interaction, '❌ At least one department must remain.'); return true; }
      const active: string[] = [];
      for (const channel of guild.channels.cache.values()) {
        if (
          channel.type !== ChannelType.GuildText ||
          !channel.topic?.startsWith('supportforge:ticket') ||
          getField(channel.topic, 'department') !== departmentId
        ) {
          continue;
        }

        const status =
          (await getPersistedTicketStatus(channel.id)) ??
          getTicketStatus(channel.topic);

        if (['open', 'claimed', 'pending', 'reopened'].includes(status)) {
          active.push(channel.id);
        }
      }

      if (active.length) {
        await reject(
          interaction,
          '❌ Cannot remove this department while it has active tickets. Reassign them first.',
        );
        return true;
      }
      await updateGuildConfig(guild.id, (current) => {
        const department = current.departments[departmentId];
        if (department?.categoryId) {
          current.retiredCategoryIds = Array.from(new Set([
            ...(current.retiredCategoryIds ?? []),
            department.categoryId,
          ]));
        }
        delete current.departments[departmentId];
      });
      await refreshSettingsChannel(guild); await syncPanel(guild); await showTags(interaction);
      await auditSettingsAction(guild, interaction, 'DEPARTMENT_REMOVED', 'Removed department ' + d.name + '. Its Discord category was retained.');
      return true;
    }

    if (id === 'sf:settings:retention') {
      await showRetention(interaction);
      return true;
    }

    if (id === 'sf:settings:inactivity') {
      await showInactivitySettings(interaction);
      return true;
    }

    if (id === 'sf:settings:inactivity:enable' || id === 'sf:settings:inactivity:disable') {
      const enabled = id.endsWith(':enable');
      await interaction.deferUpdate();
      await updateAdvancedSettings(guild.id, (settings) => {
        settings.inactivity.enabled = enabled;
        settings.inactivity.generation = Math.min(2147483647, settings.inactivity.generation + 1);
      });
      await clearTicketInactivityWarningsForGuild(guild);
      await refreshSettingsChannel(guild);
      await auditSettingsAction(guild, interaction, 'TICKET_INACTIVITY_AUTOMATION_' + (enabled ? 'ENABLED' : 'DISABLED'),
        (enabled ? 'Enabled' : 'Disabled') + ' inactivity auto-close with idle threshold ' +
        (await getAdvancedSettings(guild.id)).inactivity.idleHours + ' hours and grace period ' +
        (await getAdvancedSettings(guild.id)).inactivity.graceHours + ' hours.');
      await showInactivitySettings(interaction, enabled
        ? '✅ Inactivity automation is enabled.'
        : '✅ Inactivity automation is disabled and outstanding grace periods were cleared.');
      return true;
    }

    if (id === 'sf:settings:inactivity:departments') {
      const settings = await getAdvancedSettings(guild.id);
      const deptText = settings.inactivity.exemptDepartmentIds.join(', ');
      const input = new TextInputBuilder()
        .setCustomId('departments')
        .setLabel('Comma-separated department IDs (max 25)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000);
      if (deptText) input.setValue(deptText);
      await openModal(interaction, 'sf:settings:modal:inactivity-departments', 'Department Exemptions', [input]);
      return true;
    }

    if (id === 'sf:settings:inactivity:edit') {
      const settings = await getAdvancedSettings(guild.id);
      await openModal(interaction, 'sf:settings:modal:inactivity', 'Ticket Inactivity', [
        new TextInputBuilder().setCustomId('idle').setLabel('Idle hours before warning (1–720)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.inactivity.idleHours)),
        new TextInputBuilder().setCustomId('grace').setLabel('Grace hours after warning (1–168)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.inactivity.graceHours)),
      ]);
      return true;
    }

    if (id === 'sf:settings:retention:edit') {
      const settings = await getAdvancedSettings(guild.id);
      await openModal(interaction, 'sf:settings:modal:retention', 'Ticket Retention', [
        new TextInputBuilder().setCustomId('closed').setLabel('Closed ticket days (0–365; 0 = no timer)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.retention.closedDays)),
        new TextInputBuilder().setCustomId('archive').setLabel('Archived ticket days (0–365; 0 = no timer)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.retention.archiveDays)),
      ]);
      return true;
    }

    if (id === 'sf:settings:appearance') {
      await showAppearance(interaction);
      return true;
    }

    if (id === 'sf:settings:theme') {
      await showThemeSettings(interaction);
      return true;
    }

    if (id === 'sf:settings:appearance:edit') {
      const settings = await getAdvancedSettings(guild.id);
      await openModal(interaction, 'sf:settings:modal:appearance', 'Panel Appearance', [
        new TextInputBuilder().setCustomId('title').setLabel('Panel title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256).setValue(settings.appearance.panelTitle),
        new TextInputBuilder().setCustomId('description').setLabel('Panel description').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500).setValue(settings.appearance.panelDescription),
        new TextInputBuilder().setCustomId('footer').setLabel('Panel footer').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2048).setValue(settings.appearance.panelFooter),
      ]);
      return true;
    }

    if (id === 'sf:settings:usecases') {
      await showUseCases(interaction);
      return true;
    }

    if (id.startsWith('sf:settings:usecases:add:')) {
      const key = id.slice('sf:settings:usecases:add:'.length);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const added = await addUseCasePreset(guild.id, key);
        await syncPanel(guild);
        await refreshSettingsChannel(guild);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('✅ Use Case Added')
              .setDescription('Added **' + added.name + '** with ' + added.tagNames.length + ' starter tags: ' + added.tagNames.join(', ') + '. Its Discord category will be created when the first ticket is opened in this department.'),
          ],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
        });
        await auditSettingsAction(guild, interaction, 'USE_CASE_ADDED', 'Added use case department ' + added.name + ' with ' + added.tagNames.length + ' starter tags. Its Discord category will be provisioned when the first ticket is created.');
      } catch (error) {
        await interaction.editReply('❌ ' + (error instanceof Error ? error.message : 'Could not add that use case.')).catch(() => undefined);
      }
      return true;
    }

    if (id.startsWith('sf:settings:retention:approve:')) {
      const scope = id.endsWith(':closed') ? 'closed' : 'archive';
      await interaction.deferUpdate();

      try {
        const deleted = await approveRetentionDeletion(guild, scope, interaction.user.id);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('✅ Retention Deletion Approved')
              .setDescription(
                'Deleted **' + deleted + '** eligible ' +
                (scope === 'closed' ? 'closed' : 'archived') +
                ' ticket(s).',
              ),
          ],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
        });
        await auditSettingsAction(
          guild,
          interaction,
          'RETENTION_APPROVED',
          'Approved deletion of ' + deleted + ' eligible ' + scope + ' ticket(s).',
        );
      } catch (error) {
        await interaction.editReply(
          '❌ ' + (error instanceof Error ? error.message : 'Retention approval failed.'),
        );
      }
      return true;
    }

    if (id.startsWith('sf:settings:retention:decline:')) {
      const scope = id.endsWith(':closed') ? 'closed' : 'archive';
      await interaction.deferUpdate();

      try {
        await declineRetentionDeletion(guild, scope, interaction.user.id);
        const settings = await getAdvancedSettings(guild.id);
        const days = scope === 'closed'
          ? settings.retention.closedDays
          : settings.retention.archiveDays;

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('✋ Retention Deletion Cancelled')
              .setDescription(
                'Deletion was cancelled. Choose what happens next:\n\n' +
                '1. **Change the deletion period** so the current rule no longer applies.\n\n' +
                '2. **Review Eligible Chats** to inspect which chats are currently eligible. No deletion occurs during review.',
              ),
          ],
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId('sf:settings:retention:change-after-decline:' + scope)
                .setLabel('Change Deletion Period')
                .setEmoji('🕒')
                .setStyle(ButtonStyle.Primary),
              new ButtonBuilder()
                .setCustomId('sf:settings:retention:review:' + scope)
                .setLabel('Review Eligible Chats')
                .setEmoji('🔎')
                .setStyle(ButtonStyle.Secondary),
            ),
          ],
        });

        await auditSettingsAction(
          guild,
          interaction,
          'RETENTION_DECLINED',
          'Declined pending ' + scope + ' retention deletion request.',
        );
      } catch (error) {
        await interaction.editReply(
          '❌ ' + (error instanceof Error ? error.message : 'Retention cancellation failed.'),
        );
      }
      return true;
    }

    if (id.startsWith('sf:settings:retention:change-after-decline:')) {
      const settings = await getAdvancedSettings(guild.id);
      await openModal(interaction, 'sf:settings:modal:retention', 'Ticket Retention', [
        new TextInputBuilder()
          .setCustomId('closed')
          .setLabel('Closed ticket days (0–365; 0 = no timer)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(settings.retention.closedDays)),
        new TextInputBuilder()
          .setCustomId('archive')
          .setLabel('Archived ticket days (0–365; 0 = no timer)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(settings.retention.archiveDays)),
      ]);
      return true;
    }

    if (id.startsWith('sf:settings:retention:review:')) {
      const scope = id.endsWith(':closed') ? 'closed' : 'archive';
      await interaction.deferUpdate();

      try {
        const settings = await getAdvancedSettings(guild.id);
        const eligible = await getEligibleRetentionTickets(guild, scope);
        const label = scope === 'closed' ? 'closed' : 'archived';

        const lines = eligible.length
          ? eligible
              .slice(0, 25)
              .map((channel) => {
                const topic = channel.topic ?? '';
                const number = getField(topic, 'number') ?? 'unknown';
                const timestamp = getField(
                  topic,
                  scope === 'closed' ? 'closed_at' : 'archived_at',
                );
                return '• **#' + number + '** ' + channel.toString() +
                  (timestamp ? ' • eligible since <t:' + Math.floor(Date.parse(timestamp) / 1000) + ':d>' : '');
              })
              .join('\n')
          : 'No chats are currently eligible under this rule.';

        const suffix = eligible.length > 25
          ? '\n\n…and ' + (eligible.length - 25) + ' more.'
          : '';

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🔎 Retention Review • ' + (scope === 'closed' ? 'Closed' : 'Archive'))
              .setDescription(
                'This is a read-only review of the **' + eligible.length + '** currently eligible ' + label + ' chat(s) under the **' +
                (scope === 'closed' ? settings.retention.closedDays : settings.retention.archiveDays) +
                '-day** policy. No chat was deleted by this review.\n\n' + lines + suffix,
              ),
          ],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
        });

        await auditSettingsAction(
          guild,
          interaction,
          'RETENTION_REVIEWED',
          'Reviewed ' + eligible.length + ' eligible ' + scope + ' ticket(s) without deletion.',
        );
      } catch (error) {
        await interaction.editReply(
          '❌ ' + (error instanceof Error ? error.message : 'Retention review failed.'),
        );
      }
      return true;
    }

    if (id === 'sf:settings:storage') {
      await showStorage(interaction);
      return true;
    }

    if (id === 'sf:settings:storage:add:claimed' || id === 'sf:settings:storage:add:pending') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const status = id.endsWith(':claimed') ? 'claimed' : 'pending';
      const category = await ensureOptionalStatusCategory(guild, status);
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ Category Added')
            .setDescription('The **' + (status === 'claimed' ? 'Claimed tickets' : 'Pending tickets') + '** category is now available at ' + category + '.'),
        ],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'STATUS_CATEGORY_ADDED', 'Added ' + status + ' ticket category ' + category.name + '.');
      return true;
    }

    if (id === 'sf:settings:repair') {
      await showRepairSystem(interaction);
      return true;
    }

    if (id === 'sf:settings:setup' || id === 'sf:settings:restore' || id === 'sf:settings:setup-restore') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const restoreMode = id !== 'sf:settings:setup';
        const result = await runSupportForgeSetup(guild, restoreMode);
        await interaction.editReply(
          '✅ **ResolvX ' + (restoreMode ? 'restored' : 'setup/repair completed') + ' successfully.**\n\n' +
          'Container: <#' + result.supportCategoryId + '>\n' +
          'Department categories: **' + result.departmentCount + '**\n' +
          (result.legacyOpenCategoryId ? 'Legacy Open bucket: <#' + result.legacyOpenCategoryId + '>\n' : '') +
          'The support panel, audit channel, Settings, transcripts, and department categories were checked and repaired.'
        );
      } catch (error) {
        await interaction.editReply('❌ ResolvX could not complete setup/restore: ' + (error instanceof Error ? error.message : 'Unknown error.'));
      }
      return true;
    }

    if (id === 'sf:settings:repair:all') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await runSupportForgeRepair(guild);
        const deployment = await requestGitHubDeployment().catch((error) => ({
          requested: false,
          reason: error instanceof Error ? error.message : 'GitHub deployment request failed.',
        }));
        await refreshSettingsChannel(guild);
        const repairThemeColor = getThemeColor((await getGuildConfig(guild.id)).theme);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(repairThemeColor)
              .setTitle('🛡️ Restore & Update • Complete')
              .setDescription(
                'The existing PostgreSQL-backed configuration and ticket records were retained. ResolvX has reconciled its managed categories, core channels, settings, transcript archive, audit panel, support panel, and department categories.\n\n' +
                'Recovered missing ticket records from surviving channel metadata: **' + result.recoveredTickets + '**.\n\n' +
                (deployment.requested
                  ? '🚀 **Code deployment queued.** ' + deployment.reason
                  : '⚠️ **Discord recovery completed, but code deployment was not queued.** ' + deployment.reason),
              )
              .setFooter({ text: 'Deleted Discord messages cannot be recreated by the Discord API.' })
              .setTimestamp(),
          ],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
        });
        await auditSettingsAction(guild, interaction, 'RESTORE_AND_UPDATE', 'Reconciled ResolvX infrastructure; deployment requested=' + deployment.requested + '; recovered ticket records=' + result.recoveredTickets + '.');
      } catch (error) {
        console.error('❌ Restore & Update failed:', error);
        await interaction.editReply('❌ Restore & Update stopped before completion: ' + (error instanceof Error ? error.message : 'Unknown error. Existing database records were not intentionally reset.'));
      }
      return true;
    }

    if (id === 'sf:settings:repair:normal') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const recoveredTickets = await normalRepair(guild);
        await refreshSettingsChannel(guild);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('✅ Normal Repair Complete')
              .setDescription(
                'ResolvX infrastructure has been checked and repaired where required.' +
                (recoveredTickets ? '\n\nRecovered **' + recoveredTickets + '** missing durable ticket record(s) from existing ticket-channel metadata.' : '\n\nAll existing ResolvX ticket channels already had durable records.'),
              ),
          ],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
        });
        await auditSettingsAction(guild, interaction, 'NORMAL_REPAIR', 'Normal Repair completed successfully. Recovered ' + recoveredTickets + ' missing durable ticket record(s).');
      } catch (error) {
        console.error('❌ Normal Repair failed:', error);
        await interaction.editReply('❌ Normal Repair could not be completed. Check the bot console for details.');
      }
      return true;
    }

    if (id === 'sf:settings:repair:storage' || id === 'sf:settings:storage:repair') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await storageRepair(guild);
        await refreshSettingsChannel(guild);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('✅ Storage Repair Complete')
              .setDescription('Closed and Archive storage categories and their persisted references have been checked and repaired where required.'),
          ],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
        });
        await auditSettingsAction(guild, interaction, 'STORAGE_REPAIR', 'Storage Repair completed successfully.');
      } catch (error) {
        console.error('❌ Storage Repair failed:', error);
        await interaction.editReply('❌ Storage Repair could not be completed. Check the bot console for details.');
      }
      return true;
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'sf:settings:language:select') {
      const selected = interaction.values[0];
      if (!isSupportedLocale(selected)) {
        await reject(interaction, translate((await getAdvancedSettings(guild.id)).locale, 'settings.locale.unknown'));
        return true;
      }
      await updateAdvancedSettings(guild.id, (settings) => { settings.locale = selected; });
      await refreshSettingsChannel(guild);
      await auditSettingsAction(guild, interaction, 'SERVER_LANGUAGE_CHANGED',
        'Changed the server language to ' + selected + ' (' + getLocaleLabel(selected) + ').');
      await showLanguageSettings(interaction);
      await interaction.followUp({
        content: translate(selected, 'settings.locale.saved', { locale: getLocaleLabel(selected) }),
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined);
      return true;
    }

    if (interaction.customId === SETTINGS_LAYOUT_PREFIX + ':reorder-select') {
      const key = interaction.values[0];
      if (!key || !(SETTINGS_DASHBOARD_BUTTON_KEYS as readonly string[]).includes(key)) {
        await reject(interaction, 'Choose a valid Settings control to reorder.');
        return true;
      }
      await showSettingsDashboardOrder(interaction, key as SettingsDashboardButtonKey);
      return true;
    }
    if (interaction.customId === 'sf:settings:tags:remove:select') {
      const departmentId = interaction.values[0];
      const config = await getGuildConfig(guild.id);
      const department = config.departments[departmentId];

      if (!department) {
        await reject(interaction, '❌ Routing tag not found.');
        return true;
      }

      const remaining = Object.values(config.departments).filter((item) => item.id !== departmentId);
      if (remaining.length === 0) {
        await reject(interaction, '❌ At least one routing tag / department must remain configured.');
        return true;
      }

      const activeTickets: string[] = [];
      for (const channel of guild.channels.cache.values()) {
        if (
          channel.type !== ChannelType.GuildText ||
          !channel.topic?.startsWith('supportforge:ticket') ||
          getField(channel.topic, 'department') !== departmentId
        ) {
          continue;
        }

        const status =
          (await getPersistedTicketStatus(channel.id)) ??
          getTicketStatus(channel.topic);

        if (['open', 'claimed', 'pending', 'reopened'].includes(status)) {
          activeTickets.push(channel.id);
        }
      }

      if (activeTickets.length) {
        await reject(
          interaction,
          '❌ Cannot remove **' + department.name + '** while it has **' + activeTickets.length + '** active ticket(s). Reassign or close them first.',
        );
        return true;
      }

      await updateGuildConfig(guild.id, (current) => {
        const department = current.departments[departmentId];
        if (department?.categoryId) {
          current.retiredCategoryIds = Array.from(new Set([
            ...(current.retiredCategoryIds ?? []),
            department.categoryId,
          ]));
        }
        delete current.departments[departmentId];
      });
      await syncPanel(guild);
      await refreshSettingsChannel(guild);
      await showTags(interaction);
      await auditSettingsAction(guild, interaction, 'TAG_REMOVED', 'Removed routing tag / department ' + department.name + '. Its Discord category was retained.');
      return true;
    }

    if (interaction.customId === 'sf:settings:departments:remove:select') {
      const departmentId = interaction.values[0];
      const config = await getGuildConfig(guild.id);
      const department = config.departments[departmentId];

      if (!department) {
        await reject(interaction, '❌ Department not found.');
        return true;
      }

      const active = Object.values(config.departments).filter((item) => item.id !== departmentId);
      if (active.length === 0) {
        await reject(interaction, '❌ Keep at least one ticket department configured.');
        return true;
      }

      const activeTickets = [...guild.channels.cache.values()].filter(
        (channel): channel is import('discord.js').TextChannel =>
          channel.type === ChannelType.GuildText &&
          (channel.topic ?? '').startsWith('supportforge:ticket') &&
          getField(channel.topic ?? '', 'department') === departmentId,
      );

      for (const channel of activeTickets) {
        const status =
          (await getPersistedTicketStatus(channel.id)) ??
          getTicketStatus(channel.topic ?? '');

        if (['open', 'claimed', 'pending', 'reopened'].includes(status)) {
          await reject(
            interaction,
            '❌ Cannot remove **' + department.name + '** while it has active ticket(s). Reassign or close them first.',
          );
          return true;
        }
      }

      const removedDepartmentName = department.name;
      await updateGuildConfig(guild.id, (current) => {
        const item = current.departments[departmentId];
        if (item?.categoryId) {
          current.retiredCategoryIds = Array.from(new Set([
            ...(current.retiredCategoryIds ?? []),
            item.categoryId,
          ]));
        }
        delete current.departments[departmentId];
      });
      await syncPanel(guild);
      await refreshSettingsChannel(guild);
      await showDepartments(interaction);
      await auditSettingsAction(guild, interaction, 'DEPARTMENT_REMOVED', 'Removed department ' + removedDepartmentName + '. Its Discord category was retained.');
      return true;
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'sf:settings:department:select') {
      await showDepartmentManager(interaction, interaction.values[0]);
      return true;
    }
    if (interaction.customId.startsWith('sf:settings:tag:select:')) {
      const departmentId = interaction.customId.slice('sf:settings:tag:select:'.length);
      const tagId = interaction.values[0];
      await showTagActions(interaction, departmentId, tagId);
      return true;
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'sf:settings:modal:panel') {
      const visual = Number(interaction.fields.getTextInputValue('visual'));
      const messages = Number(interaction.fields.getTextInputValue('messages'));
      const minimum = Number(interaction.fields.getTextInputValue('minimum'));

      if (
        !Number.isInteger(visual) || visual < 6 || visual > 40 ||
        !Number.isInteger(messages) || messages < 5 || messages > 30 ||
        !Number.isInteger(minimum) || minimum < 3 || minimum > 20
      ) {
        await reject(interaction, '❌ Use valid whole numbers within the displayed ranges.');
        return true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateAdvancedSettings(guild.id, (settings) => {
        settings.panelActivity.visualLineBudget = visual;
        settings.panelActivity.messageBudget = messages;
        settings.panelActivity.minimumMessagesBeforeMove = minimum;
      });
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('✅ Panel Updated').setDescription('Panel thresholds have been saved.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'PANEL_SETTINGS_CHANGED', `Visual budget=${visual}, message cap=${messages}, minimum messages=${minimum}.`);
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:team') {
      const maxModerators = Number(interaction.fields.getTextInputValue('maxModerators'));
      if (!Number.isInteger(maxModerators) || maxModerators < 1 || maxModerators > 3) {
        await reject(interaction, '❌ The moderator limit must be a whole number from 1 to 3.');
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateAdvancedSettings(guild.id, (settings) => { settings.ticketDefaults.maxClaimedModerators = maxModerators; });
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('✅ Team & Voice Updated').setDescription('Tickets may now have up to **' + maxModerators + '** simultaneous moderators. Private voice capacity is **' + (maxModerators + 1) + '**.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'TEAM_LIMIT_CHANGED', 'Maximum simultaneous ticket moderators changed to ' + maxModerators + '.');
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:report-rules') {
      const ticketThreshold = Number(interaction.fields.getTextInputValue('tickets'));
      const serverThreshold = Number(interaction.fields.getTextInputValue('server'));
      const channelThreshold = Number(interaction.fields.getTextInputValue('channel'));
      const rawChannel = interaction.fields.getTextInputValue('channelId').trim();
      const channelMention = rawChannel.match(/^<#(\d+)>$/);
      const channelId = channelMention?.[1] ?? (/^\d{15,25}$/.test(rawChannel) ? rawChannel : null);

      if (![ticketThreshold, serverThreshold, channelThreshold].every((value) => Number.isInteger(value) && value >= 0 && value <= 100000) || (channelThreshold > 0 && !channelId)) {
        await reject(interaction, '❌ Thresholds must be whole numbers from 0 to 100000. A channel must be supplied when channel restriction is enabled.');
        return true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const now = new Date().toISOString();
      await updateAdvancedSettings(guild.id, (settings) => {
        for (const rule of Object.values(settings.reports.flagRules)) rule.enabled = false;
        const ensureRule = (id: string, action: 'tickets' | 'server' | 'channel', threshold: number, targetChannelId: string | null) => {
          if (threshold <= 0) return;
          const existing = settings.reports.flagRules[id];
          settings.reports.flagRules[id] = existing ?? { id, threshold, action, channelId: targetChannelId, enabled: true, createdAt: now, updatedAt: now };
          settings.reports.flagRules[id].threshold = threshold;
          settings.reports.flagRules[id].action = action;
          settings.reports.flagRules[id].channelId = targetChannelId;
          settings.reports.flagRules[id].enabled = true;
          settings.reports.flagRules[id].updatedAt = now;
        };
        ensureRule('tickets-default', 'tickets', ticketThreshold, null);
        ensureRule('server-default', 'server', serverThreshold, null);
        ensureRule('channel-default', 'channel', channelThreshold, channelId);
      });
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('✅ Report Flag Rules Updated').setDescription('Automatic actions now trigger at the configured flag thresholds. Set a threshold to **0** to disable that action.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'REPORT_RULES_CHANGED', 'Updated automatic report flag thresholds and actions.');
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:defaults') {
      const priority = interaction.fields.getTextInputValue('priority').trim().toLowerCase() as TicketPriority;
      if (!['low', 'normal', 'high', 'urgent', 'critical'].includes(priority)) {
        await reject(interaction, '❌ Priority must be low, normal, high, urgent, or critical.');
        return true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateAdvancedSettings(guild.id, (settings) => {
        settings.ticketDefaults.priority = priority;
      });
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('✅ Ticket Defaults Updated').setDescription('Default priority is now **' + priority + '**.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'TICKET_DEFAULTS_CHANGED', 'Default ticket priority changed to ' + priority + '.');
      return true;
    }

    if (interaction.customId.startsWith('sf:settings:modal:report-subcategory:add:')) {
      const categoryId = interaction.customId.slice('sf:settings:modal:report-subcategory:add:'.length);
      const name = interaction.fields.getTextInputValue('name').trim().replace(/\s+/g, ' ');
      if (!name) { await reject(interaction, '❌ Subcategory name cannot be empty.'); return true; }
      const subId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      if (!subId) { await reject(interaction, '❌ Subcategory name must contain letters or numbers.'); return true; }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateAdvancedSettings(guild.id, (settings) => {
        const category = settings.reports.categories[categoryId];
        if (!category) return;
        if (category.subcategories[subId]) throw new Error('A report subcategory with that name already exists.');
        category.subcategories[subId] = { id: subId, name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      }).catch(async (error) => { throw error; });
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('✅ Report Subcategory Added').setDescription('Added **' + name + '**.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'REPORT_SUBCATEGORY_ADDED', 'Added report subcategory ' + name + '.');
      return true;
    }

    if (interaction.customId.startsWith('sf:settings:modal:report-subcategory:edit:')) {
      const parts = interaction.customId.split(':'); const categoryId = parts[5] ?? ''; const subcategoryId = parts[6] ?? '';
      const sub = (await getAdvancedSettings(guild.id)).reports.categories[categoryId]?.subcategories[subcategoryId];
      if (!sub) { await reject(interaction, '❌ Report subcategory not found.'); return true; }
      const name = interaction.fields.getTextInputValue('name').trim().replace(/\s+/g, ' ');
      if (!name) { await reject(interaction, '❌ Subcategory name cannot be empty.'); return true; }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateAdvancedSettings(guild.id, (settings) => { const item = settings.reports.categories[categoryId]?.subcategories[subcategoryId]; if (item) { item.name = name; item.updatedAt = new Date().toISOString(); } });
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('✅ Report Subcategory Updated').setDescription('Renamed the report subcategory to **' + name + '**.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      return true;
    }

    if (interaction.customId.startsWith('sf:settings:modal:tag:add:')) {
      const departmentId = interaction.customId.slice('sf:settings:modal:tag:add:'.length);
      const name = interaction.fields.getTextInputValue('name').trim().replace(/\s+/g, ' ');
      const config = await getGuildConfig(guild.id);
      const department = config.departments[departmentId];
      if (!department) { await reject(interaction, '❌ Department not found.'); return true; }
      if (!name) { await reject(interaction, '❌ Tag name cannot be empty.'); return true; }
      if (Object.values(department.tags ?? {}).some((tag) => tag.name.toLowerCase() === name.toLowerCase())) {
        await reject(interaction, '❌ A tag with that name already exists in this department.'); return true;
      }
      const tagId = newTagId();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateGuildConfig(guild.id, (current) => {
        const d = current.departments[departmentId];
        if (d) {
          d.tags ??= {};
          d.tags[tagId] = { id: tagId, name, createdAt: new Date().toISOString() };
        }
      });
      await syncPanel(guild); await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('✅ Tag Added').setDescription('**' + name + '** is now a subcategory of **' + department.name + '**. No Discord category was created.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'TAG_ADDED', 'Added tag ' + name + ' under department ' + department.name + '.');
      return true;
    }

    if (interaction.customId.startsWith('sf:settings:modal:tag:edit:')) {
      const parts = interaction.customId.split(':');
      const departmentId = parts[4] ?? ''; const tagId = parts[5] ?? '';
      const config = await getGuildConfig(guild.id);
      const department = config.departments[departmentId]; const tag = department?.tags?.[tagId];
      if (!department || !tag) { await reject(interaction, '❌ Tag not found.'); return true; }
      const name = interaction.fields.getTextInputValue('name').trim().replace(/\s+/g, ' ');
      if (!name) { await reject(interaction, '❌ Tag name cannot be empty.'); return true; }
      if (Object.values(department.tags).some((item) => item.id !== tagId && item.name.toLowerCase() === name.toLowerCase())) { await reject(interaction, '❌ Another tag in this department already uses that name.'); return true; }
      const oldName = tag.name;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateGuildConfig(guild.id, (current) => { const item = current.departments[departmentId]?.tags?.[tagId]; if (item) item.name = name; });
      await syncPanel(guild); await refreshSettingsChannel(guild);
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Tag Updated').setDescription('Renamed **' + oldName + '** to **' + name + '**.')], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())] });
      await auditSettingsAction(guild, interaction, 'TAG_CHANGED', 'Renamed tag ' + oldName + ' to ' + name + ' under department ' + department.name + '.');
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:department:add') {
      const name = interaction.fields.getTextInputValue('name').trim().replace(/\s+/g, ' ');
      const rawStaff = interaction.fields.getTextInputValue('staff').trim();
      const staffMention = rawStaff.match(/^<@&(\d+)>$/);
      const staffRoleId = staffMention?.[1] ?? (/^\d{15,25}$/.test(rawStaff) ? rawStaff : null);
      const config = await getGuildConfig(guild.id);
      if (!name) { await reject(interaction, '❌ Department name cannot be empty.'); return true; }
      if (Object.values(config.departments).some((d) => d.name.toLowerCase() === name.toLowerCase())) { await reject(interaction, '❌ A department with that name already exists.'); return true; }
      if (staffRoleId) {
        const role = guild.roles.cache.get(staffRoleId);
        if (!role || role.managed || role.id === guild.roles.everyone.id) { await reject(interaction, '❌ The supplied staff role is invalid.'); return true; }
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const id = newDepartmentId(); const tagId = newTagId(); const now = new Date().toISOString();
      await updateGuildConfig(guild.id, (current) => {
        current.departments[id] = { id, name, staffRoleId, categoryId: null, tags: { [tagId]: { id: tagId, name: 'General', createdAt: now } }, createdAt: now };
      });
      await syncPanel(guild); await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ Department Added')
            .setDescription('**' + name + '** was added. Its Discord category will be created when the first ticket is opened in this department.'),
        ],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'DEPARTMENT_ADDED', 'Added department ' + name + '. Its Discord category will be provisioned when the first ticket is created.');
      return true;
    }

    if (interaction.customId.startsWith('sf:settings:modal:department:edit:')) {
      const departmentId = interaction.customId.slice('sf:settings:modal:department:edit:'.length);
      const name = interaction.fields.getTextInputValue('name').trim().replace(/\s+/g, ' ');
      const rawStaff = interaction.fields.getTextInputValue('staff').trim();
      const staffMention = rawStaff.match(/^<@&(\d+)>$/);
      const staffRoleId = staffMention?.[1] ?? (/^\d{15,25}$/.test(rawStaff) ? rawStaff : null);
      const config = await getGuildConfig(guild.id); const department = config.departments[departmentId];
      if (!department) { await reject(interaction, '❌ Department not found.'); return true; }
      if (!name) { await reject(interaction, '❌ Department name cannot be empty.'); return true; }
      if (Object.values(config.departments).some((d) => d.id !== departmentId && d.name.toLowerCase() === name.toLowerCase())) { await reject(interaction, '❌ Another department already uses that name.'); return true; }
      if (staffRoleId) {
        const role = guild.roles.cache.get(staffRoleId);
        if (!role || role.managed || role.id === guild.roles.everyone.id) { await reject(interaction, '❌ The supplied staff role is invalid.'); return true; }
      }
      const oldName = department.name;
      const oldStaffRoleId = department.staffRoleId;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const category = department.categoryId
        ? guild.channels.cache.get(department.categoryId)
        : null;
      if (category?.type === ChannelType.GuildCategory) {
        await category.edit({
          name: ('ResolvX.' + name).slice(0, 100),
          reason: 'ResolvX department rename',
        });
      }
      await updateGuildConfig(guild.id, (current) => {
        const d = current.departments[departmentId];
        if (d) {
          d.name = name;
          d.staffRoleId = staffRoleId;
        }
      });
      await migrateDepartmentStaffRole(
        guild,
        departmentId,
        oldStaffRoleId,
        staffRoleId,
      );
      await syncPanel(guild);
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ Department Updated')
            .setDescription(
              'Renamed **' + oldName + '** to **' + name +
              '**. Its category, tags, and existing ticket staff access were updated.',
            ),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()),
        ],
      });
      await auditSettingsAction(
        guild,
        interaction,
        'DEPARTMENT_CHANGED',
        'Renamed department ' + oldName + ' to ' + name +
        '. Existing ticket staff role access migrated from ' +
        (oldStaffRoleId ?? 'none') + ' to ' + (staffRoleId ?? 'none') + '.',
      );
      return true;
    }

    if (
      interaction.customId === 'sf:settings:modal:support-hours' ||
      interaction.customId.startsWith('sf:settings:modal:support-hours:')
    ) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const scope = parseSupportHoursSettingsScope(interaction.customId.split(':'), 4);
      const context = supportHoursContext(scope);
      const timezone = interaction.fields.getTextInputValue('timezone').trim();
      const scheduleText = interaction.fields.getTextInputValue('schedule');
      let weeklySchedule: ReturnType<typeof parseSupportHoursWeeklySchedule>;
      try {
        weeklySchedule = parseSupportHoursWeeklySchedule(scheduleText);
      } catch (error) {
        await reject(interaction, error instanceof Error ? error.message : 'The weekly schedule is invalid.');
        return true;
      }
      const current = await getSupportHoursPolicy(guild.id, scope.scopeType, scope.scopeId);
      const policies = await getSupportHoursPolicies(guild.id);
      const effective = resolveEffectiveSupportHoursPolicy(policies, context);
      try {
        const saved = await saveSupportHoursPolicy(guild.id, {
          ...(current ?? effective ?? createDefaultSupportHoursPolicy(scope.scopeType, scope.scopeId)),
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          timezone,
          weeklySchedule,
          updatedBy: interaction.user.id,
        });
        await refreshSettingsChannel(guild);
        const scopeLabel = scope.scopeType === 'guild'
          ? 'server-default'
          : scope.scopeType + ' ' + scope.scopeId;
        await auditSettingsAction(guild, interaction, 'SUPPORT_HOURS_CHANGED', 'Updated ' + scopeLabel + ' weekly schedule in ' + saved.timezone + '; policy version=' + saved.version + '.');
        await interaction.editReply({
          content: '✅ ' + scopeLabel.charAt(0).toUpperCase() + scopeLabel.slice(1) + ' support schedule saved. Enforcement is ' + (saved.enabled ? 'enabled' : 'disabled') + '.',
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('sf:settings:support-hours:view:' + scope.scopeType + ':' + (scope.scopeId ?? '-')).setLabel('Open Support Hours').setEmoji('🕒').setStyle(ButtonStyle.Primary),
            backButton(),
          )],
        });
      } catch (error) {
        await reject(interaction, error instanceof Error ? error.message : 'Could not save that support-hours schedule.');
      }
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:inactivity-departments') {
      const rawDepartmentIds = interaction.fields.getTextInputValue('departments');
      const departmentIds = [...new Set(rawDepartmentIds.split(',').map((value) => value.trim()).filter(Boolean))];
      if (departmentIds.length > 25) {
        await reject(interaction, 'Choose no more than 25 department IDs.');
        return true;
      }
      const config = await getGuildConfig(guild.id);
      const missing = departmentIds.filter((departmentId) => !config.departments[departmentId]);
      if (missing.length) {
        await reject(interaction, 'These department IDs are not configured in this server: ' + missing.join(', '));
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateAdvancedSettings(guild.id, (settings) => {
        settings.inactivity.exemptDepartmentIds = departmentIds;
        settings.inactivity.generation = Math.min(2147483647, settings.inactivity.generation + 1);
      });
      await clearTicketInactivityWarningsForGuild(guild);
      await refreshSettingsChannel(guild);
      await auditSettingsAction(guild, interaction, 'TICKET_INACTIVITY_EXEMPT_DEPARTMENTS_CHANGED',
        'Set inactivity-exempt department IDs to ' + (departmentIds.join(', ') || 'none') + '.');
      await interaction.editReply({
        content: '✅ Department inactivity exemptions saved.',
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('sf:settings:inactivity').setLabel('Open Inactivity Settings').setEmoji('⏳').setStyle(ButtonStyle.Primary),
          backButton(),
        )],
      });
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:inactivity') {
      const idleHours = Number(interaction.fields.getTextInputValue('idle'));
      const graceHours = Number(interaction.fields.getTextInputValue('grace'));
      if (!Number.isInteger(idleHours) || idleHours < 1 || idleHours > 720 ||
          !Number.isInteger(graceHours) || graceHours < 1 || graceHours > 168) {
        await reject(interaction, 'Idle time must be 1–720 whole hours and grace time must be 1–168 whole hours.');
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateAdvancedSettings(guild.id, (settings) => {
        settings.inactivity.idleHours = idleHours;
        settings.inactivity.graceHours = graceHours;
        settings.inactivity.generation = Math.min(2147483647, settings.inactivity.generation + 1);
      });
      await clearTicketInactivityWarningsForGuild(guild);
      await refreshSettingsChannel(guild);
      await auditSettingsAction(guild, interaction, 'TICKET_INACTIVITY_THRESHOLDS_CHANGED',
        'Set inactivity warning threshold to ' + idleHours + ' hours and grace period to ' + graceHours + ' hours.');
      await interaction.editReply({
        content: '✅ Inactivity thresholds saved: warn after ' + idleHours + ' idle hours, then allow ' + graceHours + ' additional hours before closing.',
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('sf:settings:inactivity').setLabel('Open Inactivity Settings').setEmoji('⏳').setStyle(ButtonStyle.Primary),
          backButton(),
        )],
      });
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:retention') {
      const closed = Number(interaction.fields.getTextInputValue('closed'));
      const archive = Number(interaction.fields.getTextInputValue('archive'));

      if (
        !Number.isInteger(closed) || closed < 0 || closed > 365 ||
        !Number.isInteger(archive) || archive < 0 || archive > 365
      ) {
        await reject(interaction, '❌ Retention values must be whole numbers from 0 to 365.');
        return true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateAdvancedSettings(guild.id, (settings) => {
        settings.retention.closedDays = closed;
        settings.retention.archiveDays = archive;
        settings.retention.closedEffectiveFrom = null;
        settings.retention.archiveEffectiveFrom = null;
        settings.retention.pendingApprovals.closed = null;
        settings.retention.pendingApprovals.archive = null;
      });
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('✅ Retention Updated').setDescription('Closed: **' + (closed === 0 ? 'No timer (365-day maximum)' : closed + ' days') + '** • Archive: **' + (archive === 0 ? 'No timer (365-day maximum)' : archive + ' days') + '**.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'RETENTION_CHANGED', 'Closed retention=' + closed + ' days; archive retention=' + archive + ' days.');
      void runRetentionSweepForGuild(guild, { requestApproval: true });
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:reset') {
      const confirmation = interaction.fields.getTextInputValue('confirmation').trim().toUpperCase();

      if (confirmation !== 'DELETE SUPPORT FORGE') {
        await reject(interaction, '❌ Final confirmation did not match. Type **DELETE SUPPORT FORGE** exactly. No data was deleted.');
        return true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const accumulateAuditData =
        pendingResetAuditChoice.get(guild.id) ?? false;

      try {
        /*
         * A factory reset can delete the Settings channel that hosted the
         * interaction which opened this modal. Therefore the ephemeral
         * @original response is not a safe place to send the final result.
         * Use a webhook follow-up instead, which is independent of the
         * deleted ResolvX channel.
         */
        await interaction.editReply({
          content:
            '⏳ **ResolvX reset is being completed.** All ResolvX-managed infrastructure and stored data are being removed. The final confirmation will be sent separately after the destructive operation finishes.',
        });

        const resetResult = await performFactoryReset(
          guild,
          accumulateAuditData,
        );

        if (!resetResult.complete) {
          const failures = resetResult.failed
            .slice(0, 5)
            .map(
              (failure) =>
                '• ' +
                failure.name +
                ' (' +
                failure.id +
                '): ' +
                failure.error,
            )
            .join('\n');

          await interaction.editReply({
            content:
              '⚠️ **ResolvX reset was only partially completed.**\n' +
              'Some managed resources could not be deleted, so ResolvX preserved its state for a safe retry.\n\n' +
              (failures || 'No detailed failure information was returned.') +
              (resetResult.failed.length > 5
                ? '\n\n…and ' +
                  (resetResult.failed.length - 5) +
                  ' more.'
                : ''),
          }).catch(() => undefined);
          return true;
        }

        pendingResetAuditChoice.delete(guild.id);

        /*
         * The reset intentionally destroys the Settings channel that hosted
         * this interaction. Do not rely on the interaction webhook for a
         * post-reset follow-up: Discord can return 10008 Unknown Message once
         * the hosting infrastructure has disappeared. Send the completion
         * notice through the user's DM instead.
         */
        await interaction.user.send({
          content:
            '✅ ResolvX has been completely reset. All ResolvX-managed messages, channels, categories, and stored data were deleted.',
        }).catch((deliveryError) => {
          console.warn(
            '⚠️ Factory reset completed, but the completion DM could not be delivered:',
            deliveryError,
          );
        });
      } catch (error) {
        console.error('❌ ResolvX factory reset failed:', error);

        await interaction.editReply({
          content:
            '❌ The complete reset encountered an error. Check the bot console for details.',
        }).catch(() => undefined);
      }
      return true;
    }

    if (interaction.customId.startsWith('sf:settings:modal:dashboard-button:')) {
      const rawKey = interaction.customId.slice('sf:settings:modal:dashboard-button:'.length);
      if (!(SETTINGS_DASHBOARD_BUTTON_KEYS as readonly string[]).includes(rawKey)) {
        await reject(interaction, 'That Settings control is not supported.');
        return true;
      }
      const key = rawKey as SettingsDashboardButtonKey;
      const submittedLabel = interaction.fields.getTextInputValue('label').trim();
      const submittedEmoji = interaction.fields.getTextInputValue('emoji').trim();
      if (!submittedLabel || submittedLabel.length > 80) {
        await reject(interaction, 'Button label must contain 1–80 characters.');
        return true;
      }
      const label = submittedLabel.toLowerCase() === 'default'
        ? SETTINGS_LAYOUT_LABELS[key]
        : submittedLabel;
      let emoji: string | null;
      if (submittedEmoji.toLowerCase() === 'none') {
        emoji = null;
      } else if (submittedEmoji.toLowerCase() === 'default' || !submittedEmoji) {
        emoji = SETTINGS_LAYOUT_DEFAULT_EMOJIS[key];
      } else {
        try {
          emoji = normalizeDiscordEmoji(submittedEmoji, 'Settings button emoji') ?? null;
        } catch (error) {
          await reject(interaction, error instanceof Error ? error.message : 'Enter a valid Unicode or Discord custom emoji.');
          return true;
        }
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateAdvancedSettings(guild.id, (settings) => {
        if (label === SETTINGS_LAYOUT_LABELS[key] && emoji === SETTINGS_LAYOUT_DEFAULT_EMOJIS[key]) {
          delete settings.settingsDashboard.buttonCustomizations[key];
        } else {
          settings.settingsDashboard.buttonCustomizations[key] = { label, emoji };
        }
      });
      await refreshSettingsChannel(guild);
      await auditSettingsAction(guild, interaction, 'SETTINGS_DASHBOARD_BUTTON_CUSTOMIZED', 'Customized the label or emoji for Settings control "' + SETTINGS_LAYOUT_LABELS[key] + '".');
      await interaction.editReply({
        content: '✅ Settings control updated. The persistent dashboard has been refreshed.',
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(SETTINGS_LAYOUT_PREFIX + ':home').setLabel('Return to Settings Layout').setEmoji('🧰').setStyle(ButtonStyle.Primary),
          backButton(),
        )],
      });
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:dashboard-builder') {
      const title = interaction.fields.getTextInputValue('title').trim();
      const description = interaction.fields.getTextInputValue('description').trim();
      const footer = interaction.fields.getTextInputValue('footer').trim();
      if (!title) {
        await reject(interaction, 'Dashboard title cannot be empty.');
        return true;
      }
      if (title.length > 256 || description.length > 4000 || footer.length > 1800) {
        await reject(interaction, 'Dashboard title, description or footer exceeds the supported Discord limit.');
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateAdvancedSettings(guild.id, (settings) => {
        settings.settingsDashboard.title = title;
        // Empty description intentionally falls back to the built-in helper text.
        settings.settingsDashboard.description = description;
        settings.settingsDashboard.footer = footer || 'ResolvX • Settings Dashboard';
      });
      await refreshSettingsChannel(guild);
      await auditSettingsAction(guild, interaction, 'SETTINGS_DASHBOARD_BRANDING_CHANGED', 'Updated the per-server Settings dashboard title, description or footer.');
      await interaction.editReply({
        content: '✅ Settings dashboard branding saved and refreshed for this server.',
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(SETTINGS_LAYOUT_PREFIX + ':home').setLabel('Open Layout Builder').setEmoji('🧰').setStyle(ButtonStyle.Primary),
          backButton(),
        )],
      });
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:appearance') {
      const title = interaction.fields.getTextInputValue('title').trim();
      const description = interaction.fields.getTextInputValue('description').trim();
      const footer = interaction.fields.getTextInputValue('footer').trim();

      if (!title || !description || !footer) {
        await reject(interaction, '❌ Panel appearance fields cannot be empty.');
        return true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await updateAdvancedSettings(guild.id, (settings) => {
        settings.appearance.panelTitle = title;
        settings.appearance.panelDescription = description;
        settings.appearance.panelFooter = footer;
      });
      await syncPanel(guild);
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('✅ Appearance Updated').setDescription('Panel title, description, and footer were saved and the support panel was refreshed.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'APPEARANCE_CHANGED', 'Updated the ResolvX panel appearance.');
      return true;
    }
  }

  return false;
}

async function showHomeAfterUpdate(interaction: ButtonInteraction): Promise<void> {
  await showHome(interaction);
}

async function showRepairSystem(interaction: ButtonInteraction): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const locale = settings.locale;
  const themeColor = getThemeColor(config.theme);
  await renderSettingsView(
    interaction,
    [
      new EmbedBuilder()
        .setColor(themeColor)
        .setTitle('🛠️ ' + translate(locale, 'settings.repair.title'))
        .setDescription(translate(locale, 'settings.repair.description')),
    ],
    [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('sf:settings:repair:all')
          .setLabel(translate(locale, 'settings.repair.action.restoreUpdate'))
          .setEmoji('🚀').setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('sf:settings:repair:normal')
          .setLabel(translate(locale, 'settings.repair.action.normal'))
          .setEmoji('🔧').setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('sf:settings:repair:storage')
          .setLabel(translate(locale, 'settings.repair.action.storage'))
          .setEmoji('🗄️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('sf:settings:setup')
          .setLabel(translate(locale, 'settings.repair.action.setup'))
          .setEmoji('🧭').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('sf:settings:restore')
          .setLabel(translate(locale, 'settings.repair.action.restore'))
          .setEmoji('♻️').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('sf:settings:recovery:channels')
          .setLabel(translate(locale, 'settings.repair.action.restoreChannel'))
          .setEmoji('♻️').setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('sf:settings:recovery:review')
          .setLabel(translate(locale, 'settings.repair.action.deletionReview'))
          .setEmoji('🛡️').setStyle(ButtonStyle.Primary),
        backButton(),
      ),
    ],
  );
}

async function normalRepair(guild: Guild): Promise<number> {
  const result = await runSupportForgeRepair(guild);
  return result.recoveredTickets;
}

async function storageRepair(guild: Guild): Promise<void> {
  await ensureClosedCategory(guild);
  await ensureArchiveCategory(guild);
}
