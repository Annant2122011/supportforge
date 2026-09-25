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
  updateGuildConfig,
} from '../services/configService';

import {
  addCustomTag,
  getAdvancedSettings,
  removeCustomTag,
  updateAdvancedSettings,
  type TicketPriority,
} from '../services/advancedSettingsService';

import {
  buildSettingsDashboardComponents,
  refreshSettingsChannel,
  ensureSettingsChannel,
} from '../services/settingsChannelService';

import {
  ensureArchiveCategory,
  ensureClosedCategory,
  ensureOptionalStatusCategory,
  getOptionalStatusCategory,
} from '../services/ticketStorageService';

import {
  ensureAllDepartmentCategories,
  ensureDepartmentCategory,
} from '../services/departmentCategoryService';

import { logSettingsEvent } from '../services/auditLogService';
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
  high: { label: 'High', emoji: '🔴', color: 0xe74c3c },
  urgent: { label: 'Urgent', emoji: '🟠', color: 0xe67e22 },
  critical: { label: 'Critical', emoji: '🟣', color: 0x9b59b6 },
};

async function isDepartmentStaff(interaction: SettingsViewInteraction): Promise<boolean> {
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
      '🟢 Low • 🟡 Normal • 🔴 High • 🟠 Urgent • 🟣 Critical. Priority is shown in the ticket name and panel.\n\n' +
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
  const lines = (Object.keys(PRIORITY_ROLE_DEFINITIONS) as TicketPriority[]).map((priority) => {
    const roleId = settings.priorityRoles[priority];
    const role = roleId ? interaction.guild!.roles.cache.get(roleId) : undefined;
    return PRIORITY_ROLE_DEFINITIONS[priority].emoji + ' **' + PRIORITY_ROLE_DEFINITIONS[priority].label + '** • ' + (role ? role.toString() : roleId ? 'Role missing, recreate' : 'No role created');
  });

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🎨 Priority Rules & Roles')
      .setDescription(
        'Priority roles are optional server rules. **Nothing is created by default.** An administrator must explicitly choose a priority below to create its role. Claimed and Pending are intentionally excluded because they are workflow states, not new priority-role types.',
      )
      .addFields({ name: 'Current priority rules', value: lines.join('\n') }),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...(Object.keys(PRIORITY_ROLE_DEFINITIONS) as TicketPriority[]).map((priority) =>
        new ButtonBuilder()
          .setCustomId('sf:settings:rules:create:' + priority)
          .setLabel('Create ' + PRIORITY_ROLE_DEFINITIONS[priority].label + ' Role')
          .setEmoji(PRIORITY_ROLE_DEFINITIONS[priority].emoji)
          .setStyle(priority === 'high' || priority === 'urgent' || priority === 'critical' ? ButtonStyle.Danger : ButtonStyle.Secondary),
      ),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()),
  ]);
}

async function createPriorityRole(interaction: ButtonInteraction, priority: TicketPriority): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await reject(interaction, '❌ Creating priority roles requires the **Administrator** permission.');
    return;
  }

  const existingSettings = await getAdvancedSettings(interaction.guild!.id);
  const configuredRoleId = existingSettings.priorityRoles[priority];
  const configuredRole = configuredRoleId ? interaction.guild!.roles.cache.get(configuredRoleId) : undefined;

  if (configuredRole) {
    await interaction.reply({ content: 'ℹ️ The ' + priorityRoleLabel(priority) + ' priority role already exists: ' + configuredRole.toString(), flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const definition = PRIORITY_ROLE_DEFINITIONS[priority];
    const role = await interaction.guild!.roles.create({
      name: 'SupportForge • ' + definition.label + ' Tickets',
      color: definition.color,
      mentionable: false,
      reason: 'SupportForge administrator-created priority rule',
    });

    await updateAdvancedSettings(interaction.guild!.id, (settings) => {
      settings.priorityRoles[priority] = role.id;
    });
    await refreshSettingsChannel(interaction.guild!);

    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle('✅ Priority Role Created').setDescription(definition.emoji + ' **' + definition.label + '** tickets can now use ' + role.toString() + '.\n\nThe role was created only because an administrator explicitly requested it. SupportForge did not create any default priority roles.')],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
    });

    await auditSettingsAction(interaction.guild!, interaction, 'PRIORITY_ROLE_CREATED', 'Created ' + role.name + ' for ' + priority + ' priority.');
  } catch (error) {
    console.error('❌ Priority role creation failed:', error);
    await interaction.editReply('❌ SupportForge could not create that priority role. Check that the bot can Manage Roles and that its role is above the new role.');
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
    .setLabel('Back to Settings')
    .setEmoji('↩️')
    .setStyle(ButtonStyle.Secondary);
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
  const departments = Object.values(config.departments);
  const routed = departments.filter((department) => Boolean(department.categoryId)).length;

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('⚙️ SupportForge Settings')
      .setDescription(
        '**Administrative control center**\n' +
        'Use the buttons below to configure SupportForge without leaving Discord.\n\n' +
        'Changes are saved immediately and this dashboard can be refreshed at any time.',
      )
      .addFields(
        { name: '🎛️ Panel', value: (settings.panelActivity.enabled ? '🟢 Enabled' : '⚪ Disabled') + `\n${settings.panelActivity.visualLineBudget} visual lines • ${settings.panelActivity.messageBudget} message cap`, inline: true },
        { name: '🎟️ Defaults', value: `Priority: **${settings.ticketDefaults.priority}**`, inline: true },
        { name: '🏷️ Tags', value: `**${Object.keys(settings.customTags).length}** configured`, inline: true },
        { name: '📂 Departments', value: `**${departments.length}** configured\n${routed} with category`, inline: true },
        { name: '🧹 Retention', value: `Closed: **${settings.retention.closedDays || 'Never'}**\nArchive: **${settings.retention.archiveDays || 'Never'}**`, inline: true },
        { name: '🗄️ Storage', value: `Closed: ${settings.closedCategoryId ? '✅' : '❌'}\nArchive: ${settings.archiveCategoryId ? '✅' : '❌'}`, inline: true },
      )
      .setFooter({ text: 'SupportForge • Select a section to configure it' })
      .setTimestamp(),
  ], buildSettingsDashboardComponents());
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

async function showTags(interaction: SettingsViewInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const tags = Object.values(settings.customTags).sort((a, b) => a.name.localeCompare(b.name));
  const lines = tags.length
    ? tags.map((tag) => `${tag.emoji} **${tag.name}**${tag.description ? ` • ${tag.description}` : ''}`).join('\n')
    : 'No custom tags are configured yet.';

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🏷️ Custom Ticket Tags')
      .setDescription(lines.slice(0, 3900))
      .addFields({ name: 'Active tags', value: tags.length ? `${tags.length} configured tag(s)` : 'None' })
      .setFooter({ text: 'Add Tag shows the active tags as a reference inside the form.' }),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:tags:add').setLabel('Add Tag').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sf:settings:tags:remove').setLabel('Remove Tag').setEmoji('➖').setStyle(ButtonStyle.Danger).setDisabled(tags.length === 0),
      backButton(),
    ),
  ]);
}

async function showDepartments(interaction: SettingsViewInteraction): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const departments = Object.values(config.departments).sort((a, b) => a.name.localeCompare(b.name));
  const lines = departments.length
    ? departments.map((department) => `• **${department.name}** — ${department.staffRoleId ? '<@&' + department.staffRoleId + '>' : 'Administrators only'} — ${department.categoryId ? '<#' + department.categoryId + '>' : 'Category pending'}`).join('\n')
    : 'No departments configured.';

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('📂 Ticket Departments')
      .setDescription(lines.slice(0, 3900))
      .addFields({ name: 'Department categories', value: 'New departments automatically receive a **SupportForge.** category.' })
      .setFooter({ text: 'Categories are retained when departments are removed to avoid destructive history cleanup.' }),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:departments:add').setLabel('Add Department').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sf:settings:departments:remove').setLabel('Remove Department').setEmoji('➖').setStyle(ButtonStyle.Danger).setDisabled(departments.length <= 1),
      backButton(),
    ),
  ]);
}

async function showRetention(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🧹 Retention')
      .setDescription('Set how long closed and archived tickets remain before automatic deletion. **0 means never delete.**')
      .addFields(
        { name: 'Closed', value: settings.retention.closedDays === 0 ? 'Never delete' : settings.retention.closedDays + ' days', inline: true },
        { name: 'Archived', value: settings.retention.archiveDays === 0 ? 'Never delete' : settings.retention.archiveDays + ' days', inline: true },
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
        { name: 'Closed tickets', value: settings.closedCategoryId ? '<#' + settings.closedCategoryId + '>' : 'Not provisioned', inline: true },
        { name: 'Archive tickets', value: settings.archiveCategoryId ? '<#' + settings.archiveCategoryId + '>' : 'Not provisioned', inline: true },
        { name: 'Claimed tickets', value: claimed ? '<#' + claimed.id + '>' : 'Not added', inline: true },
        { name: 'Pending tickets', value: pending ? '<#' + pending.id + '>' : 'Not added', inline: true },
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
        'SupportForge-managed ticket channels and their messages, SupportForge categories, the public ticket panel, transcript/audit/settings channels, and stored SupportForge data will be deleted.\n\n' +
        'Unrelated Discord channels are not targeted.',
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:reset:confirm2').setLabel('Continue to Confirmation 2').setEmoji('⚠️').setStyle(ButtonStyle.Danger),
      backButton(),
    ),
  ]);
}

async function showResetStepTwo(interaction: ButtonInteraction): Promise<void> {
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🚨 Delete Everything • Confirmation 2 of 3')
      .setDescription(
        '**You are about to erase every SupportForge-managed channel and stored record in this server.**\n\n' +
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
            .setLabel('Type DELETE SUPPORTFORGE to continue')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('DELETE SUPPORTFORGE')
            .setMaxLength(19),
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

  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id === 'sf:settings:home') {
      await showHome(interaction);
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

    if (id.startsWith('sf:settings:rules:create:')) {
      const priority = id.slice('sf:settings:rules:create:'.length);
      if (!Object.prototype.hasOwnProperty.call(PRIORITY_ROLE_DEFINITIONS, priority)) {
        await reject(interaction, '❌ Unknown priority rule.');
        return true;
      }
      await createPriorityRole(interaction, priority as TicketPriority);
      return true;
    }

    if (id === 'sf:settings:reset') {
      await showResetStepOne(interaction);
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

    if (id === 'sf:settings:tags') {
      await showTags(interaction);
      return true;
    }

    if (id === 'sf:settings:tags:add') {
      const settings = await getAdvancedSettings(guild.id);
      const tags = Object.values(settings.customTags).sort((a, b) => a.name.localeCompare(b.name));
      const activeTags = tags.length
        ? tags.map((tag) => tag.emoji + ' ' + tag.name).join(' • ').slice(0, 900)
        : 'None configured';

      await openModal(interaction, 'sf:settings:modal:tag:add', 'Add Custom Tag', [
        new TextInputBuilder()
          .setCustomId('active')
          .setLabel('Currently active tags (reference)')
          .setPlaceholder('Reference only. Do not edit this field.')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000)
          .setValue(activeTags),
        new TextInputBuilder().setCustomId('name').setLabel('Tag name').setPlaceholder('bug, vip, refund, account...').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32),
        new TextInputBuilder().setCustomId('emoji').setLabel('Emoji').setPlaceholder('🏷️').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4),
        new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100),
      ]);
      return true;
    }

    if (id === 'sf:settings:tags:remove') {
      const settings = await getAdvancedSettings(guild.id);
      const tags = Object.values(settings.customTags);

      await interaction.reply({
        content: 'Select the tag to remove.',
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('sf:settings:tags:remove:select')
              .setPlaceholder('Choose a custom tag')
              .addOptions(
                tags.slice(0, 25).map((tag) => ({
                  label: tag.name.slice(0, 100),
                  value: tag.id,
                  description: tag.description.slice(0, 100) || 'Custom ticket tag',
                  emoji: tag.emoji,
                })),
              ),
          ),
          new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (id === 'sf:settings:departments') {
      await showDepartments(interaction);
      return true;
    }

    if (id === 'sf:settings:departments:add') {
      await openModal(interaction, 'sf:settings:modal:department:add', 'Add Department', [
        new TextInputBuilder().setCustomId('name').setLabel('Department name').setPlaceholder('Technical Support, Sales, Partnerships...').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
        new TextInputBuilder().setCustomId('staff').setLabel('Staff role ID or mention (optional)').setPlaceholder('@Support or 123456789012345678').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100),
      ]);
      return true;
    }

    if (id === 'sf:settings:departments:remove') {
      const config = await getGuildConfig(guild.id);
      const departments = Object.values(config.departments);

      await interaction.reply({
        content: 'Select the department to remove.',
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('sf:settings:departments:remove:select')
              .setPlaceholder('Choose a department')
              .addOptions(
                departments.slice(0, 25).map((department) => ({
                  label: department.name.slice(0, 100),
                  value: department.id,
                  description: department.staffRoleId ? 'Staff role configured' : 'Administrators only',
                })),
              ),
          ),
          new ActionRowBuilder<ButtonBuilder>().addComponents(backButton()),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (id === 'sf:settings:retention') {
      await showRetention(interaction);
      return true;
    }

    if (id === 'sf:settings:retention:edit') {
      const settings = await getAdvancedSettings(guild.id);
      await openModal(interaction, 'sf:settings:modal:retention', 'Ticket Retention', [
        new TextInputBuilder().setCustomId('closed').setLabel('Closed ticket days (0 = never)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.retention.closedDays)),
        new TextInputBuilder().setCustomId('archive').setLabel('Archived ticket days (0 = never)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.retention.archiveDays)),
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
      const category = await ensureDepartmentCategory(guild, {
        name,
        staffRoleId: null,
        categoryId: null,
      });

      await updateGuildConfig(guild.id, (current) => {
        current.departments[departmentId] = {
          id: departmentId,
          name,
          staffRoleId: null,
          categoryId: category.id,
          createdAt: new Date().toISOString(),
        };
      });

      await syncPanel(guild);
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('✅ Use Case Added').setDescription('Added **' + name + '** with category ' + category + '.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'USE_CASE_ADDED', 'Added use case department ' + name + ' with category ' + category.name + '.');
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
                '1. **Change the deletion period** so the current rule no longer applies.\n' +
                '2. **Confirm whether to delete chats that are ' + days + ' days old, counting from today.**',
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
          .setLabel('Closed ticket days (0 = never)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(settings.retention.closedDays)),
        new TextInputBuilder()
          .setCustomId('archive')
          .setLabel('Archived ticket days (0 = never)')
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
      const tagId = interaction.values[0];
      await interaction.deferUpdate();
      const removed = await removeCustomTag(guild.id, tagId);
      await refreshSettingsChannel(guild);
      await showTags(interaction);
      if (removed) {
        await auditSettingsAction(guild, interaction, 'TAG_REMOVED', 'Removed custom tag ' + tagId + '.');
      }
      return true;
    }

    if (interaction.customId === 'sf:settings:departments:remove:select') {
      const departmentId = interaction.values[0];
      const config = await getGuildConfig(guild.id);
      const department = config.departments[departmentId];

      if (!department) {
        await interaction.reply({ content: '❌ Department not found.', flags: MessageFlags.Ephemeral });
        return true;
      }

      const active = Object.values(config.departments).filter((item) => item.id !== departmentId);
      if (active.length === 0) {
        await interaction.reply({
          content: '❌ Keep at least one ticket department configured.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      await interaction.deferUpdate();
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

    if (interaction.customId === 'sf:settings:modal:tag:add') {
      const name = interaction.fields.getTextInputValue('name');
      const emoji = interaction.fields.getTextInputValue('emoji') || '🏷️';
      const description = interaction.fields.getTextInputValue('description') || '';

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const tag = await addCustomTag(guild.id, name, emoji, description);
        await refreshSettingsChannel(guild);
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('✅ Tag Added').setDescription('Added custom tag ' + tag.emoji + ' **' + tag.name + '**.')],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
        });
        await auditSettingsAction(guild, interaction, 'TAG_ADDED', 'Added custom tag ' + tag.name + '.');
      } catch (error) {
        await interaction.editReply('❌ ' + (error instanceof Error ? error.message : 'Could not create tag.'));
      }
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:department:add') {
      const name = interaction.fields.getTextInputValue('name').trim().replace(/\s+/g, ' ');
      const rawStaff = interaction.fields.getTextInputValue('staff').trim();
      const staffMention = rawStaff.match(/^<@&(\\d+)>$/);
      const staffRoleId = staffMention?.[1] ?? (/^\\d{15,25}$/.test(rawStaff) ? rawStaff : null);

      if (!name) {
        await reject(interaction, '❌ Department name cannot be empty.');
        return true;
      }

      const config = await getGuildConfig(guild.id);
      if (Object.values(config.departments).some((department) => department.name.toLowerCase() === name.toLowerCase())) {
        await reject(interaction, '❌ A department with that name already exists.');
        return true;
      }

      if (staffRoleId) {
        const role = guild.roles.cache.get(staffRoleId);
        if (!role || role.managed || role.id === guild.roles.everyone.id) {
          await reject(interaction, '❌ The supplied staff role is invalid.');
          return true;
        }
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const id = newDepartmentId();
      const category = await ensureDepartmentCategory(guild, {
        name,
        staffRoleId,
        categoryId: null,
      });

      await updateGuildConfig(guild.id, (current) => {
        current.departments[id] = {
          id,
          name,
          staffRoleId,
          categoryId: category.id,
          createdAt: new Date().toISOString(),
        };
      });

      await syncPanel(guild);
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('✅ Department Added').setDescription('**' + name + '** is ready.\n\nCategory: ' + category + '\nTickets for this department will use its **SupportForge.** category.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'DEPARTMENT_ADDED', 'Added department ' + name + ' with category ' + category.name + '.');
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
        embeds: [new EmbedBuilder().setTitle('✅ Retention Updated').setDescription('Closed: **' + (closed || 'Never') + '** days • Archive: **' + (archive || 'Never') + '** days.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'RETENTION_CHANGED', 'Closed retention=' + closed + ' days; archive retention=' + archive + ' days.');
      void runRetentionSweepForGuild(guild, { requestApproval: true });
      return true;
    }

    if (interaction.customId === 'sf:settings:modal:reset') {
      const confirmation = interaction.fields.getTextInputValue('confirmation').trim().toUpperCase();

      if (confirmation !== 'DELETE SUPPORTFORGE') {
        await reject(interaction, '❌ Final confirmation did not match. No data was deleted.');
        return true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        await performFactoryReset(guild);
        await interaction.editReply(
          '✅ SupportForge has been completely reset. All SupportForge-managed messages, channels, categories, and stored data were deleted.',
        );
      } catch (error) {
        console.error('❌ SupportForge factory reset failed:', error);
        await interaction.editReply(
          '❌ The complete reset encountered an error. Check the bot console for details.',
        );
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
