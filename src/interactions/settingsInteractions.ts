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
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type ModalSubmitInteraction,
} from 'discord.js';

import {
  getGuildConfig,
  newDepartmentId,
  newTagId,
  updateGuildConfig,
} from '../services/configService';

import {
  getAdvancedSettings,
  updateAdvancedSettings,
  type TicketPriority,
} from '../services/advancedSettingsService';

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

import { logSettingsEvent } from '../services/auditLogService';
import { getField, getTicketStatus } from '../services/ticketStateService';
import { getPersistedTicketStatus } from '../services/ticketPersistenceService';
import { performFactoryReset } from '../services/factoryResetService';
import {
  approveRetentionDeletion,
  declineRetentionDeletion,
  getEligibleRetentionTickets,
  runRetentionSweepForGuild,
} from '../services/ticketRetentionService';

import {
  ensureContainer,
  ensurePanelChannel,
  ensureTranscriptChannel,
  syncPanel,
} from '../commands/supportforge';

const SETTINGS_TOPIC_PREFIX = 'supportforge:settings';

type SettingsViewInteraction = ButtonInteraction | StringSelectMenuInteraction;

function isAdministrator(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): boolean {
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

async function isDepartmentStaff(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
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

function manualQuickEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('📖 SupportForge Staff Manual • Quick Overview')
    .setDescription(
      '**1. Ticket lifecycle**\n' +
      'Open → Claimed/Pending → Closed → Archived. Reopened tickets return to the active workflow.\n\n' +
      '**2. Main staff controls**\n' +
      'Claim a ticket when you take ownership. Pending means you are waiting for information. Resume returns it to Open. Close creates the transcript and makes the ticket read-only.\n\n' +
      '**3. Priority**\n' +
      '🟣 Critical • 🔴 Urgent • 🟠 High • 🟡 Normal • 🟢 Low. Priority is shown in the ticket name and panel.\n\n' +
      '**4. Ticket tools**\n' +
      'Use Add User, Priority, Tag, Note and History from the ticket panel.\n\n' +
      '**5. Audit & Settings**\n' +
      'The audit log records important activity. Settings is button-driven. Staff can read the Manual; administrators can change configuration.\n\n' +
      '**6. Important rule**\n' +
      'Closed and archived tickets are read-only. Do not work around the lock by sending messages manually.',
    )
    .setFooter({ text: 'Private manual view • only you can see this response' })
    .setTimestamp();
}

function manualDetailedEmbeds(): EmbedBuilder[] {
  return [
    new EmbedBuilder()
      .setTitle('📖 SupportForge Staff Manual • Detailed • Page 1')
      .setDescription(
        '**Getting started**\n' +
        'SupportForge keeps ticket work private and structured. Your department role controls which support areas and audit/settings resources you can access. Use the buttons in the ticket panel instead of attempting manual channel-management actions.\n\n' +
        '**Ticket states**\n' +
        '• **Open:** Active ticket waiting for staff action.\n' +
        '• **Claimed:** A staff member has taken ownership.\n' +
        '• **Pending:** Waiting for the customer or another dependency.\n' +
        '• **Reopened:** A previously closed ticket has returned to active work.\n' +
        '• **Closed:** Transcript saved; ticket becomes read-only.\n' +
        '• **Archived:** Historical terminal state.\n\n' +
        '**Claiming and pending**\n' +
        'Claim only when you intend to own the work. Pending should be used when progress genuinely depends on a response. Resume moves a pending ticket back to Open.\n\n' +
        '**Closing**\n' +
        'SupportForge generates and uploads the transcript before committing the Closed state. If transcript creation fails, the ticket is not treated as safely closed. Reopen is available only from Closed, and Archive is the deliberate terminal historical action.',
      )
      .setFooter({ text: 'Private manual view • Page 1 of 2' })
      .setTimestamp(),
    new EmbedBuilder()
      .setTitle('📖 SupportForge Staff Manual • Detailed • Page 2')
      .setDescription(
        '**Priority & tags**\n' +
        'Priority is not cosmetic. It is displayed in the ticket name, panel color, and status area. Use the lowest accurate priority and increase it when urgency changes. Tags add searchable operational context.\n\n' +
        '**Internal notes & history**\n' +
        'Internal notes are staff-only workflow context. History reads the audit record for the ticket. Do not put customer-facing promises, passwords, tokens, or other secrets into notes.\n\n' +
        '**Panel navigation**\n' +
        'When conversation activity pushes the panel away from view, SupportForge may collapse or move it. Restore/Move Panel brings the controls back to the bottom without duplicating old panels.\n\n' +
        '**Audit log**\n' +
        'The audit log records ticket and administrative activity. Its Summarise Everything control produces a current snapshot with ticket counts, tag dates, channels, departments, priorities and additional metrics.\n\n' +
        '**Settings & priority roles**\n' +
        'Administrators can configure departments, retention, appearance, storage and optional priority roles. Priority roles are never created automatically. Claimed and Pending are status states, not extra role types.\n\n' +
        '**Retention**\n' +
        'Closed and archived tickets are not silently deleted. When a retention rule finds eligible tickets, an approval step is required. Review the eligible tickets before approving deletion.\n\n' +
        '**Safety**\n' +
        'Never bypass SupportForge permissions. Never expose private tickets. When a workflow looks stale, use the supported panel controls or ask an administrator to run Repair System.',
      )
      .setFooter({ text: 'Private manual view • Page 2 of 2' })
      .setTimestamp(),
  ];
}

function priorityRoleLabel(priority: TicketPriority): string {
  return PRIORITY_ROLE_DEFINITIONS[priority].label;
}

const pendingResetAuditChoice = new Map<string, boolean>();

const PRIORITY_ROLE_ORDER: TicketPriority[] = [
  'critical',
  'urgent',
  'high',
  'normal',
  'low',
];

/**
 * Keep SupportForge priority roles together at the top of the role hierarchy
 * that the bot can manage. Higher priority always receives the higher Discord
 * role position, regardless of the order in which roles were created.
 */
async function enforcePriorityRoleHierarchy(guild: Guild): Promise<void> {
  const settings = await getAdvancedSettings(guild.id);
  const configured = PRIORITY_ROLE_ORDER.flatMap((priority) => {
    const roleId = settings.priorityRoles[priority];
    const role = roleId ? guild.roles.cache.get(roleId) : undefined;

    return roleId && role && !role.managed
      ? [{ priority, role }]
      : [];
  });

  if (configured.length === 0) return;

  const botMember =
    guild.members.me ??
    await guild.members.fetchMe().catch(() => null);

  const botHighestRole = botMember?.roles.highest;
  if (!botHighestRole) {
    console.warn('⚠️ SupportForge could not determine its highest role; priority role ordering was skipped.');
    return;
  }

  /*
   * Discord only lets a bot manage roles below its highest role. A hierarchy
   * preference must never make the underlying priority-rule creation fail.
   * Skip roles the bot cannot edit and treat a Discord 50013 as a warning.
   */
  const manageable = configured.filter(
    (entry) =>
      entry.role.editable &&
      entry.role.position < botHighestRole.position,
  );

  if (manageable.length === 0) return;

  const highestTargetPosition = botHighestRole.position - 1;
  const lowestTargetPosition =
    highestTargetPosition - manageable.length + 1;

  if (lowestTargetPosition < 1) {
    console.warn(
      '⚠️ Not enough manageable role positions below the SupportForge bot role; priority role ordering was skipped.',
    );
    return;
  }

  const positions = manageable.map((entry, index) => ({
    role: entry.role.id,
    position: highestTargetPosition - index,
  }));

  try {
    await guild.roles.setPositions(positions);
    await guild.roles.fetch();
  } catch (error) {
    console.warn(
      '⚠️ Could not reorder SupportForge priority roles. Role creation/deletion will continue normally:',
      error,
    );
  }
}

function findPriorityRole(
  guild: Guild,
  priority: TicketPriority,
  configuredRoleId?: string,
) {
  const configured =
    configuredRoleId
      ? guild.roles.cache.get(configuredRoleId)
      : undefined;

  if (configured) return configured;

  const expectedName =
    'SupportForge • ' + PRIORITY_ROLE_DEFINITIONS[priority].label + ' Tickets';

  return guild.roles.cache.find(
    (role) =>
      !role.managed &&
      role.name === expectedName,
  );
}

async function showManual(interaction: SettingsViewInteraction): Promise<void> {
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('📖 Staff Manual')
      .setDescription(
        'A newcomer-friendly guide to SupportForge. Choose a concise overview or the full instructions. Each manual is delivered as an **ephemeral** response, so other staff do not see or accumulate your manual pages.',
      )
      .addFields(
        { name: 'Quick Overview', value: 'Core workflow and the controls you need most often.', inline: true },
        { name: 'Detailed Manual', value: 'Full lifecycle, priorities, notes, audit, settings, retention and safety guidance.', inline: true },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:manual:quick').setLabel('Display Quick Manual').setEmoji('⚡').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sf:settings:manual:detailed').setLabel('Display Detailed Manual').setEmoji('📚').setStyle(ButtonStyle.Secondary),
      backButton(),
    ),
  ]);
}

async function showManualVersion(interaction: ButtonInteraction, detailed: boolean): Promise<void> {
  await interaction.reply({
    embeds: detailed ? manualDetailedEmbeds() : [manualQuickEmbed()],
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
        'Priority roles are optional server rules. **Nothing is created automatically.** Choose a priority to create its role, or delete an existing SupportForge priority role. SupportForge will not fail the whole rule operation just because Discord refuses a role-hierarchy reorder.',
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
      '❌ SupportForge needs **Manage Roles** to create priority roles. Discord does not allow a bot to grant itself that permission.',
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
      name: 'SupportForge • ' + definition.label + ' Tickets',
      colors: {
        primaryColor: definition.color,
      },
      mentionable: false,
      reason: 'SupportForge administrator-created priority rule',
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
      '❌ SupportForge could not create that priority role. Check that the bot can Manage Roles and that its role is above the target role.',
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
          ' priority role exists. The stale SupportForge configuration was cleared.',
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
        '❌ Discord will not let SupportForge delete ' +
          role.toString() +
          '. Move the SupportForge bot role above this role and ensure it has **Manage Roles**, then try again.',
      );
      return;
    }

    await role.delete('SupportForge administrator deleted priority rule role');

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
      '❌ SupportForge could not delete that priority role. Discord may be preventing the bot from managing it because of the role hierarchy.',
    );
  }
}
function isSettingsChannel(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): boolean {
  return interaction.channel?.type === ChannelType.GuildText &&
    Boolean(interaction.channel.topic?.startsWith(SETTINGS_TOPIC_PREFIX));
}

async function reject(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, content: string): Promise<void> {
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
  components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>>,
): Promise<void> {
  const payload = { embeds, components };

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
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
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
      ),
    ],
    buildSettingsDashboardComponents(),
  );
}

async function showPanelSettings(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🎛️ Panel Settings')
      .setDescription('Automatic panel positioning uses message count and estimated visual occupancy because Discord does not expose a bot-readable viewport.')
      .addFields({
        name: 'Current configuration',
        value:
          `Automatic movement: **${settings.panelActivity.enabled ? 'Enabled' : 'Disabled'}**\n` +
          `Visual budget: **${settings.panelActivity.visualLineBudget} lines**\n` +
          `Message safety cap: **${settings.panelActivity.messageBudget}**\n` +
          `Minimum messages: **${settings.panelActivity.minimumMessagesBeforeMove}**`,
      }),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:panel:toggle').setLabel(settings.panelActivity.enabled ? 'Disable Auto Move' : 'Enable Auto Move').setEmoji(settings.panelActivity.enabled ? '⏸️' : '▶️').setStyle(settings.panelActivity.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sf:settings:panel:thresholds').setLabel('Edit Thresholds').setEmoji('📏').setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}

async function showTeamSettings(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const max = settings.ticketDefaults.maxClaimedModerators;
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('👥 Team & Voice')
      .setDescription('A ticket may be assisted by multiple moderators at the same time. The same limit controls the private voice room: **customer + configured moderator capacity**.')
      .addFields(
        { name: 'Maximum simultaneous moderators', value: '**' + max + '**', inline: true },
        { name: 'Voice capacity', value: '**' + (max + 1) + '** people', inline: true },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:team:edit').setLabel('Set Moderator Limit').setEmoji('👥').setStyle(ButtonStyle.Primary),
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
  ).join('\n\n').slice(0, 3800) || 'No report categories configured.';

  const ruleText = rules.length
    ? rules.map((rule) => '• **' + rule.threshold + ' flags** → **' + rule.action + '**' + (rule.channelId ? ' in <#' + rule.channelId + '>' : '')).join('\n')
    : 'No automatic actions configured.';

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🚩 Safety & Reports')
      .setDescription('Reports are independent of ticket use cases. Moderators choose a category and subcategory during a report; they never need to configure a use-case preset first.')
      .addFields(
        { name: 'Reporting', value: settings.reports.enabled ? '🟢 Enabled' : '🔴 Disabled', inline: true },
        { name: 'Configured categories', value: String(categories.length), inline: true },
        { name: 'Automatic flag rules', value: String(rules.length), inline: true },
        { name: 'Categories & subcategories', value: categoryText.slice(0, 1024) },
        { name: 'Automatic actions', value: ruleText.slice(0, 1024) },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:reports:toggle').setLabel(settings.reports.enabled ? 'Disable Reports' : 'Enable Reports').setEmoji(settings.reports.enabled ? '⏸️' : '▶️').setStyle(settings.reports.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sf:settings:reports:rules').setLabel('Flag Rules').setEmoji('🚩').setStyle(ButtonStyle.Primary),
      backButton(),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...categories.slice(0, 5).map((category) =>
        new ButtonBuilder().setCustomId('sf:settings:reports:category:' + category.id).setLabel(category.name.slice(0, 80)).setEmoji(category.emoji).setStyle(ButtonStyle.Secondary),
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

async function showReportSubcategorySelector(interaction: ButtonInteraction, categoryId: string): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const category = settings.reports.categories[categoryId];
  if (!category) { await reject(interaction, '❌ Report category not found.'); return; }
  await interaction.reply({
    content: 'Select the report subcategory to edit or remove.',
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId('sf:settings:reports:subcategory:pick:' + categoryId).setPlaceholder('Choose a subcategory').addOptions(Object.values(category.subcategories).slice(0, 25).map((sub) => ({ label: sub.name.slice(0, 100), value: sub.id }))),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function showDefaults(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🎟️ Ticket Defaults')
      .setDescription('Defaults are applied automatically when a new ticket is created.')
      .addFields({ name: 'Default priority', value: `⚡ **${settings.ticketDefaults.priority}**` }),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:defaults:edit').setLabel('Change Default Priority').setEmoji('⚡').setStyle(ButtonStyle.Primary),
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
  const departments = Object.values(config.departments).sort((a, b) => a.name.localeCompare(b.name));
  const lines = departments.length
    ? departments.map((d) => {
        const tags = Object.values(d.tags ?? {}).map((t) => t.name).sort().join(', ') || 'No tags';
        return '📂 **' + d.name + '** • ' + (d.categoryId ? '<#' + d.categoryId + '>' : 'Category pending') + '\n   🏷️ ' + tags;
      }).join('\n')
    : 'No departments configured.';
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('📂 Departments & Tags')
      .setDescription(lines.slice(0, 3900))
      .addFields(
        { name: 'Hierarchy', value: 'A **Department** owns one Discord category and optional staff role. **Tags are subcategories inside that department** and never create Discord categories. Tickets select one department and one tag.' },
        { name: 'AI-ready design', value: 'Premium AI can classify a ticket into a department, then choose only from that department’s tags. The model never needs to invent categories or tags.' },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:departments:add').setLabel('Add Department').setEmoji('📂').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sf:settings:departments:manage').setLabel('Manage Departments').setEmoji('⚙️').setStyle(ButtonStyle.Primary).setDisabled(!departments.length),
      backButton(),
    ),
  ]);
}

async function showDepartmentManager(interaction: SettingsViewInteraction, departmentId: string): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const d = config.departments[departmentId];
  if (!d) { await reject(interaction, '❌ Department not found.'); return; }
  const tags = Object.values(d.tags ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('⚙️ ' + d.name)
      .setDescription('**Category:** ' + (d.categoryId ? '<#' + d.categoryId + '>' : 'Pending') + '\n**Staff:** ' + (d.staffRoleId ? '<@&' + d.staffRoleId + '>' : 'Administrators only') + '\n\n**Tags:** ' + (tags.length ? tags.map((t) => '🏷️ ' + t.name).join(' • ') : 'None')),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:department:edit:' + d.id).setLabel('Edit Department').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sf:settings:tag:add:' + d.id).setLabel('Add Tag').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sf:settings:tag:manage:' + d.id).setLabel('Manage Tags').setEmoji('🏷️').setStyle(ButtonStyle.Secondary).setDisabled(!tags.length),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:department:remove:' + d.id).setLabel('Remove Department').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(Object.keys(config.departments).length <= 1),
      new ButtonBuilder().setCustomId('sf:settings:departments').setLabel('Back').setStyle(ButtonStyle.Secondary),
    ),
  ]);
}

async function showTagManager(interaction: SettingsViewInteraction, departmentId: string): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const d = config.departments[departmentId];
  if (!d) { await reject(interaction, '❌ Department not found.'); return; }
  const tags = Object.values(d.tags ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  await renderSettingsView(interaction, [
    new EmbedBuilder().setTitle('🏷️ Tags • ' + d.name).setDescription(tags.length ? 'Select a tag to edit or remove it.' : 'No tags configured.'),
  ], [
    ...(tags.length ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId('sf:settings:tag:select:' + d.id).setPlaceholder('Choose a tag').addOptions(tags.slice(0, 25).map((t) => ({ label: t.name.slice(0, 100), value: t.id, description: 'Subcategory of ' + d.name }))),
    )] : []),
    new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('sf:settings:department:manage:' + d.id).setLabel('Back to Department').setStyle(ButtonStyle.Secondary)),
  ]);
}

async function showDepartments(interaction: SettingsViewInteraction): Promise<void> {
  await showTags(interaction);
}

async function showRetention(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🧹 Retention')
      .setDescription('Set how long closed and archived tickets remain before automatic deletion. **0 means unlimited retention (never automatically delete).**')
      .addFields(
        { name: 'Closed', value: settings.retention.closedDays === 0 ? 'Unlimited' : settings.retention.closedDays + ' days', inline: true },
        { name: 'Archived', value: settings.retention.archiveDays === 0 ? 'Unlimited' : settings.retention.archiveDays + ' days', inline: true },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:retention:edit').setLabel('Edit Retention').setEmoji('🕒').setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}

async function showAppearance(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🎨 Appearance')
      .setDescription('Customize the main support panel without editing source code.')
      .addFields(
        { name: 'Title', value: settings.appearance.panelTitle.slice(0, 1024) || 'Not set' },
        { name: 'Description', value: settings.appearance.panelDescription.slice(0, 1024) || 'Not set' },
        { name: 'Footer', value: settings.appearance.panelFooter.slice(0, 1024) || 'Not set' },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:appearance:edit').setLabel('Edit Appearance').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}

async function showUseCases(interaction: ButtonInteraction): Promise<void> {
  const presets = [
    ['Technical Support', '🛠️', 'technical-support'],
    ['Sales', '💼', 'sales'],
    ['Account & Access', '🔐', 'account-access'],
    ['Partnerships', '🤝', 'partnerships'],
    ['Reports & Abuse', '🚩', 'reports-abuse'],
    ['Refunds & Returns', '↩️', 'refunds-returns'],
    ['Product Support', '📦', 'product-support'],
    ['VIP Support', '⭐', 'vip-support'],
  ];
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < presets.length; i += 4) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...presets.slice(i, i + 4).map(([name, emoji, key]) =>
        new ButtonBuilder().setCustomId('sf:settings:usecases:add:' + key).setLabel(name).setEmoji(emoji).setStyle(ButtonStyle.Secondary),
      ),
    ));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()));

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🧩 Use Cases')
      .setDescription('Optional department presets for common support operations. They create ordinary departments only, so each server keeps control of its own requirements.'),
  ], rows);
}

async function showStorage(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const claimed = await getOptionalStatusCategory(interaction.guild!, 'claimed');
  const pending = await getOptionalStatusCategory(interaction.guild!, 'pending');

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🗄️ Storage & Categories')
      .setDescription(
        'Closed tickets and Archive tickets are the only status-storage categories created by default. ' +
        'Claimed tickets and Pending tickets can be added here when extra segregation is useful.',
      )
      .addFields(
        { name: 'Closed tickets', value: settings.closedCategoryId ? (interaction.guild!.channels.cache.get(settings.closedCategoryId)?.name ?? 'Configured category') : 'Not provisioned', inline: true },
        { name: 'Archive tickets', value: settings.archiveCategoryId ? (interaction.guild!.channels.cache.get(settings.archiveCategoryId)?.name ?? 'Configured category') : 'Not provisioned', inline: true },
        { name: 'Claimed tickets', value: claimed?.name ?? 'Not added', inline: true },
        { name: 'Pending tickets', value: pending?.name ?? 'Not added', inline: true },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:storage:add:claimed').setLabel(claimed ? 'Claimed Added' : 'Add Claimed tickets').setEmoji('🙋').setStyle(ButtonStyle.Secondary).setDisabled(Boolean(claimed)),
      new ButtonBuilder().setCustomId('sf:settings:storage:add:pending').setLabel(pending ? 'Pending Added' : 'Add Pending tickets').setEmoji('⏳').setStyle(ButtonStyle.Secondary).setDisabled(Boolean(pending)),
      new ButtonBuilder().setCustomId('sf:settings:storage:repair').setLabel('Storage Repair').setEmoji('🗄️').setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}

async function showResetStepOne(interaction: ButtonInteraction): Promise<void> {
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🚨 Delete Everything • Confirmation 1 of 3')
      .setDescription(
        '**This permanently removes SupportForge data from this server.**\n\n' +
        'Before continuing, choose whether SupportForge should retain individual audit events for future summaries. Daily and overall summaries are retained either way.\n\n' +
        'SupportForge-managed ticket channels and their messages, SupportForge categories, the public ticket panel, transcript/audit/settings channels, and stored SupportForge data will be deleted.\n\n' +
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
        '**You are about to erase every SupportForge-managed channel and stored record in this server.**\n\n' +
        'Audit retention choice: **' + (accumulate ? 'Accumulate individual audit data' : 'Keep summaries only') + '**.\n\n' +
        'Daily and overall summaries will remain available after SupportForge is set up again. This choice can be changed later from the Audit Log controls.\n\n' +
        'This includes every message inside SupportForge-managed channels. SupportForge cannot undo this operation.',
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
    console.error('❌ Failed to open SupportForge settings form:', error);
    await reject(interaction, '❌ The settings form could not be opened. Please try again.');
  }
}

export async function handleSettingsInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
): Promise<boolean> {
  if (!interaction.guild) return false;

  /*
   * Acknowledge settings select menus immediately. This must happen before
   * authorization/configuration lookups because Discord expires unacknowledged
   * component interactions after a few seconds.
   */
  if (interaction.isStringSelectMenu()) {
    await interaction.deferUpdate().catch(() => undefined);
  }

  if (
    (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) &&
    (interaction.customId.startsWith('sf:settings:'))
  ) {
    if (!isSettingsChannel(interaction)) {
      await reject(interaction, '❌ SupportForge settings can only be used from the SupportForge settings channel.');
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
          : '❌ You need **Manage Server** or **Administrator** to change SupportForge settings.',
      );
      return true;
    }
  } else {
    return false;
  }

  const guild = interaction.guild;

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

  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id === 'sf:settings:home') {
      await restoreSettingsHome(interaction);
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
      await showReportSubcategorySelector(interaction, id.slice('sf:settings:reports:subcategory:select:'.length));
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
      const config = await getGuildConfig(guild.id);
      const departments = Object.values(config.departments).sort((a, b) => a.name.localeCompare(b.name));
      await interaction.reply({
        content: 'Select a department to manage its tags and routing.',
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder().setCustomId('sf:settings:department:select').setPlaceholder('Choose a department').addOptions(departments.slice(0, 25).map((d) => ({ label: d.name.slice(0, 100), value: d.id, description: Object.keys(d.tags ?? {}).length + ' tag(s)' }))),
        ), new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
        flags: MessageFlags.Ephemeral,
      });
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
      await updateGuildConfig(guild.id, (current) => {
        const item = current.departments[departmentId];
        if (item) delete item.tags[tagId];
      });
      await refreshSettingsChannel(guild); await syncPanel(guild); await showTagManager(interaction, departmentId);
      await auditSettingsAction(guild, interaction, 'TAG_REMOVED', 'Removed tag ' + d.tags[tagId].name + ' from department ' + d.name + '. Existing tickets keep their historical tag metadata.');
      return true;
    }

    if (id.startsWith('sf:settings:department:remove:')) {
      const departmentId = id.slice('sf:settings:department:remove:'.length);
      const config = await getGuildConfig(guild.id); const d = config.departments[departmentId];
      if (!d) { await reject(interaction, '❌ Department not found.'); return true; }
      if (Object.keys(config.departments).length <= 1) { await reject(interaction, '❌ At least one department must remain.'); return true; }
      const active = [...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildText && c.topic?.startsWith('supportforge:ticket') && getField(c.topic, 'department') === departmentId && ['open','claimed','pending','reopened'].includes(getField(c.topic, 'status') ?? ''));
      if (active.length) { await reject(interaction, '❌ Cannot remove this department while it has active tickets. Reassign them first.'); return true; }
      await updateGuildConfig(guild.id, (current) => { delete current.departments[departmentId]; });
      await refreshSettingsChannel(guild); await syncPanel(guild); await showTags(interaction);
      await auditSettingsAction(guild, interaction, 'DEPARTMENT_REMOVED', 'Removed department ' + d.name + '. Its Discord category was retained.');
      return true;
    }

    if (id === 'sf:settings:retention') {
      await showRetention(interaction);
      return true;
    }

    if (id === 'sf:settings:retention:edit') {
      const settings = await getAdvancedSettings(guild.id);
      await openModal(interaction, 'sf:settings:modal:retention', 'Ticket Retention', [
        new TextInputBuilder().setCustomId('closed').setLabel('Closed ticket days (0 = unlimited)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.retention.closedDays)),
        new TextInputBuilder().setCustomId('archive').setLabel('Archived ticket days (0 = unlimited)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.retention.archiveDays)),
      ]);
      return true;
    }

    if (id === 'sf:settings:appearance') {
      await showAppearance(interaction);
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
      const presetMap: Record<string, string> = {
        'technical-support': 'Technical Support',
        'sales': 'Sales',
        'account-access': 'Account & Access',
        'partnerships': 'Partnerships',
        'reports-abuse': 'Reports & Abuse',
        'refunds-returns': 'Refunds & Returns',
        'product-support': 'Product Support',
        'vip-support': 'VIP Support',
      };

      const name = presetMap[key];
      if (!name) {
        await reject(interaction, '❌ Unknown support use case.');
        return true;
      }

      const config = await getGuildConfig(guild.id);
      if (Object.values(config.departments).some((department) => department.name.toLowerCase() === name.toLowerCase())) {
        await reject(interaction, 'ℹ️ **' + name + '** is already configured.');
        return true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const departmentId = newDepartmentId();
      const tagId = newTagId();
      const now = new Date().toISOString();
      await updateGuildConfig(guild.id, (current) => {
        current.departments[departmentId] = {
          id: departmentId,
          name,
          staffRoleId: null,
          categoryId: null,
          tags: {
            [tagId]: { id: tagId, name: 'General', createdAt: now },
          },
          createdAt: now,
        };
      });

      await syncPanel(guild);
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ Use Case Added')
            .setDescription('Added **' + name + '**. Its Discord category will be created when the first ticket is opened in this department.'),
        ],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'USE_CASE_ADDED', 'Added use case department ' + name + '. Its Discord category will be provisioned when the first ticket is created.');
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
          .setLabel('Closed ticket days (0 = unlimited)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(settings.retention.closedDays)),
        new TextInputBuilder()
          .setCustomId('archive')
          .setLabel('Archived ticket days (0 = unlimited)')
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

    if (id === 'sf:settings:repair:normal') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await normalRepair(guild);
        await refreshSettingsChannel(guild);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('✅ Normal Repair Complete')
              .setDescription('SupportForge normal infrastructure has been checked and repaired where required.'),
          ],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
        });
        await auditSettingsAction(guild, interaction, 'NORMAL_REPAIR', 'Normal Repair completed successfully.');
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

      const activeTickets = [...guild.channels.cache.values()].filter((channel) =>
        channel.type === ChannelType.GuildText &&
        channel.topic?.startsWith('supportforge:ticket') &&
        getField(channel.topic, 'department') === departmentId &&
        ['open', 'claimed', 'pending', 'reopened'].includes(getField(channel.topic, 'status') ?? ''),
      );

      if (activeTickets.length) {
        await reject(
          interaction,
          '❌ Cannot remove **' + department.name + '** while it has **' + activeTickets.length + '** active ticket(s). Reassign them first.',
        );
        return true;
      }

      await updateGuildConfig(guild.id, (current) => {
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

      await updateGuildConfig(guild.id, (current) => {
        delete current.departments[departmentId];
      });
      await syncPanel(guild);
      await refreshSettingsChannel(guild);
      await showDepartments(interaction);
      await auditSettingsAction(guild, interaction, 'DEPARTMENT_REMOVED', 'Removed department ' + department.name + '. Its Discord category was retained.');
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
      const parts = interaction.customId.split(':'); const categoryId = parts[4] ?? ''; const subcategoryId = parts[5] ?? '';
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
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const category = department.categoryId ? guild.channels.cache.get(department.categoryId) : null;
      if (category?.type === ChannelType.GuildCategory) await category.edit({ name: ('SupportForge.' + name).slice(0, 100), reason: 'SupportForge department rename' });
      await updateGuildConfig(guild.id, (current) => { const d = current.departments[departmentId]; if (d) { d.name = name; d.staffRoleId = staffRoleId; } });
      await syncPanel(guild); await refreshSettingsChannel(guild);
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Department Updated').setDescription('Renamed **' + oldName + '** to **' + name + '**. Its category and tags remain attached.')], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())] });
      await auditSettingsAction(guild, interaction, 'DEPARTMENT_CHANGED', 'Renamed department ' + oldName + ' to ' + name + '.');
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:retention') {
      const closed = Number(interaction.fields.getTextInputValue('closed'));
      const archive = Number(interaction.fields.getTextInputValue('archive'));

      if (
        !Number.isInteger(closed) || closed < 0 || closed > 3650 ||
        !Number.isInteger(archive) || archive < 0 || archive > 3650
      ) {
        await reject(interaction, '❌ Retention values must be whole numbers from 0 to 3650.');
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
        embeds: [new EmbedBuilder().setTitle('✅ Retention Updated').setDescription('Closed: **' + (closed === 0 ? 'Unlimited' : closed) + '** days • Archive: **' + (archive === 0 ? 'Unlimited' : archive) + '** days.')],
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
         * deleted SupportForge channel.
         */
        await interaction.editReply({
          content:
            '⏳ **SupportForge reset is being completed.** All SupportForge-managed infrastructure and stored data are being removed. The final confirmation will be sent separately after the destructive operation finishes.',
        });

        await performFactoryReset(guild, accumulateAuditData);
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
            '✅ SupportForge has been completely reset. All SupportForge-managed messages, channels, categories, and stored data were deleted.',
        }).catch((deliveryError) => {
          console.warn(
            '⚠️ Factory reset completed, but the completion DM could not be delivered:',
            deliveryError,
          );
        });
      } catch (error) {
        console.error('❌ SupportForge factory reset failed:', error);

        await interaction.editReply({
          content:
            '❌ The complete reset encountered an error. Check the bot console for details.',
        }).catch(() => undefined);
      }
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
      await auditSettingsAction(guild, interaction, 'APPEARANCE_CHANGED', 'Updated the SupportForge panel appearance.');
      return true;
    }
  }

  return false;
}

async function showHomeAfterUpdate(interaction: ButtonInteraction): Promise<void> {
  await showHome(interaction);
}

async function showRepairSystem(interaction: ButtonInteraction): Promise<void> {
  await renderSettingsView(
    interaction,
    [
      new EmbedBuilder()
        .setTitle('🛠️ Repair System')
        .setDescription(
          'SupportForge can repair its managed infrastructure without resetting ticket data. ' +
          'Normal Repair checks the main container, panel, transcript, settings channel, and explicitly routed department categories. ' +
          'Storage Repair only verifies the Closed and Archive storage categories.',
        ),
    ],
    [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('sf:settings:repair:normal')
          .setLabel('Normal Repair')
          .setEmoji('🔧')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('sf:settings:repair:storage')
          .setLabel('Storage Repair')
          .setEmoji('🗄️')
          .setStyle(ButtonStyle.Secondary),
        backButton(),
      ),
    ],
  );
}

async function normalRepair(guild: Guild): Promise<void> {
  const supportCategory = await ensureContainer(guild);
  await ensureTranscriptChannel(guild, supportCategory.id);
  await ensurePanelChannel(guild, supportCategory.id);
  await ensureSettingsChannel(guild, supportCategory.id);
  await ensureAllDepartmentCategories(guild);
  await syncPanel(guild);
}

async function storageRepair(guild: Guild): Promise<void> {
  await ensureClosedCategory(guild);
  await ensureArchiveCategory(guild);
}
