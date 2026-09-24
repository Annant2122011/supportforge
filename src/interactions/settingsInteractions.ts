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
} from '../services/settingsChannelService';

import {
  ensureArchiveCategory,
  ensureClosedCategory,
} from '../services/ticketStorageService';

import {
  ensureAllDepartmentCategories,
  ensureDepartmentCategory,
} from '../services/departmentCategoryService';

import { logSettingsEvent } from '../services/auditLogService';

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

  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🗄️ Storage')
      .setDescription('Historical ticket storage is kept separate from active support operations.')
      .addFields(
        { name: 'Closed', value: settings.closedCategoryId ? '<#' + settings.closedCategoryId + '>' : 'Not provisioned', inline: true },
        { name: 'Archive', value: settings.archiveCategoryId ? '<#' + settings.archiveCategoryId + '>' : 'Not provisioned', inline: true },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:storage:repair').setLabel('Storage Repair').setEmoji('🗄️').setStyle(ButtonStyle.Primary),
      backButton(),
    ),
  ]);
}

async function showRepairSystem(interaction: ButtonInteraction): Promise<void> {
  await renderSettingsView(interaction, [
    new EmbedBuilder()
      .setTitle('🛠️ Repair System')
      .setDescription('Normal Repair and Storage Repair are separate operations. Choose only the area that needs attention.')
      .addFields(
        { name: 'Normal Repair', value: 'Repairs the SupportForge container, transcript channel, panel channel, settings channel, department categories, and support panel.' },
        { name: 'Storage Repair', value: 'Repairs the Closed and Archive storage categories and their persisted references only.' },
      ),
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sf:settings:repair:normal').setLabel('Normal Repair').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sf:settings:repair:storage').setLabel('Storage Repair').setEmoji('🗄️').setStyle(ButtonStyle.Secondary),
      backButton(),
    ),
  ]);
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

    if (!isAdministrator(interaction)) {
      await reject(interaction, '❌ You need **Manage Server** or **Administrator** to change SupportForge settings.');
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

    if (id === 'sf:settings:refresh') {
      await showHome(interaction);
      await auditSettingsAction(guild, interaction, 'SETTINGS_REFRESH', 'Settings dashboard refreshed.');
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

    if (id === 'sf:settings:storage') {
      await showStorage(interaction);
      return true;
    }

    if (id === 'sf:settings:storage:repair' || id === 'sf:settings:repair') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await repairSystem(guild);
      await refreshSettingsChannel(guild);
      await interaction.editReply('✅ SupportForge storage, panel, transcript, and settings infrastructure has been repaired.');
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
      });
      await refreshSettingsChannel(guild);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('✅ Retention Updated').setDescription('Closed: **' + (closed || 'Never') + '** days • Archive: **' + (archive || 'Never') + '** days.')],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
      });
      await auditSettingsAction(guild, interaction, 'RETENTION_CHANGED', 'Closed retention=' + closed + ' days; archive retention=' + archive + ' days.');
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

async function normalRepair(guild: Guild): Promise<void> {
  const supportCategory = await ensureContainer(guild);
  await ensureTranscriptChannel(guild, supportCategory.id);
  await ensurePanelChannel(guild, supportCategory.id);
  await ensureAllDepartmentCategories(guild);
  await ensureSettingsChannel(guild, supportCategory.id);
  await syncPanel(guild);
}

async function storageRepair(guild: Guild): Promise<void> {
  await ensureClosedCategory(guild);
  await ensureArchiveCategory(guild);
}
