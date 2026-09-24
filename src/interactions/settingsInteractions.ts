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
  ensureContainer,
  ensurePanelChannel,
  ensureTranscriptChannel,
  syncPanel,
} from '../commands/supportforge';

const SETTINGS_TOPIC_PREFIX = 'supportforge:settings';

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

async function showHome(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const settings = await getAdvancedSettings(interaction.guild!.id);
  const config = await getGuildConfig(interaction.guild!.id);

  const embed = new EmbedBuilder()
    .setTitle('⚙️ SupportForge Settings')
    .setDescription(
      'Everything here is controlled with buttons and small forms. ' +
      'The settings slash-command family has been removed so the configuration surface stays inside Discord instead of turning chat into a control panel.',
    )
    .addFields(
      {
        name: '🎛️ Panel',
        value: settings.panelActivity.enabled
          ? 'Automatic positioning is enabled.'
          : 'Automatic positioning is disabled.',
        inline: true,
      },
      {
        name: '🏷️ Tags',
        value: Object.keys(settings.customTags).length + ' custom tags',
        inline: true,
      },
      {
        name: '📂 Departments',
        value: Object.keys(config.departments).length + ' departments',
        inline: true,
      },
      {
        name: '🧹 Retention',
        value:
          'Closed: ' +
          (settings.retention.closedDays || 'Never') +
          ' • Archive: ' +
          (settings.retention.archiveDays || 'Never'),
        inline: false,
      },
    );

  await interaction.editReply({
    embeds: [embed],
    components: buildSettingsDashboardComponents(),
  });
}

async function showPanelSettings(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('🎛️ Panel Settings')
        .setDescription(
          'Control when the ticket control panel automatically moves downward. ' +
          'Discord does not expose a bot-readable viewport, so SupportForge uses activity and visual-occupancy estimates.',
        )
        .addFields({
          name: 'Current configuration',
          value:
            'Automatic movement: **' + (settings.panelActivity.enabled ? 'Enabled' : 'Disabled') + '**\n' +
            'Visual budget: **' + settings.panelActivity.visualLineBudget + ' lines**\n' +
            'Message cap: **' + settings.panelActivity.messageBudget + '**\n' +
            'Minimum messages: **' + settings.panelActivity.minimumMessagesBeforeMove + '**',
        }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('sf:settings:panel:toggle')
          .setLabel(settings.panelActivity.enabled ? 'Disable Auto Move' : 'Enable Auto Move')
          .setEmoji(settings.panelActivity.enabled ? '⏸️' : '▶️')
          .setStyle(settings.panelActivity.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('sf:settings:panel:thresholds')
          .setLabel('Edit Thresholds')
          .setEmoji('📏')
          .setStyle(ButtonStyle.Primary),
        backButton(),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function showDefaults(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('🎟️ Ticket Defaults')
        .setDescription('Set the defaults applied when a new ticket is created.')
        .addFields({
          name: 'Default priority',
          value: '**' + settings.ticketDefaults.priority + '**',
        }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('sf:settings:defaults:edit')
          .setLabel('Change Default Priority')
          .setEmoji('⚡')
          .setStyle(ButtonStyle.Primary),
        backButton(),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function showTags(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const tags = Object.values(settings.customTags);

  const embed = new EmbedBuilder()
    .setTitle('🏷️ Custom Ticket Tags')
    .setDescription(
      tags.length
        ? tags.map((tag) => tag.emoji + ' **' + tag.name + '**' + (tag.description ? ' • ' + tag.description : '')).join('\n')
        : 'No custom tags are configured yet.',
    );

  await interaction.reply({
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('sf:settings:tags:add')
          .setLabel('Add Tag')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('sf:settings:tags:remove')
          .setLabel('Remove Tag')
          .setEmoji('➖')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(tags.length === 0),
        backButton(),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function showDepartments(interaction: ButtonInteraction): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const departments = Object.values(config.departments).sort((a, b) => a.name.localeCompare(b.name));

  const lines = departments.length
    ? departments.map((department) =>
        '• **' + department.name + '** — ' +
        (department.staffRoleId ? '<@&' + department.staffRoleId + '>' : 'Administrators only'),
      ).join('\n')
    : 'No departments configured.';

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('📂 Ticket Departments')
        .setDescription(lines)
        .setFooter({ text: 'Departments are the server-defined support use cases.' }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('sf:settings:departments:add')
          .setLabel('Add Department')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('sf:settings:departments:remove')
          .setLabel('Remove Department')
          .setEmoji('➖')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(departments.length === 0),
        backButton(),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function showRetention(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('🧹 Ticket Retention')
        .setDescription(
          'Set how long closed and archived tickets remain before automatic deletion. ' +
          'A value of **0** means never delete.',
        )
        .addFields(
          {
            name: 'Closed',
            value: settings.retention.closedDays === 0 ? 'Never delete' : settings.retention.closedDays + ' days',
            inline: true,
          },
          {
            name: 'Archived',
            value: settings.retention.archiveDays === 0 ? 'Never delete' : settings.retention.archiveDays + ' days',
            inline: true,
          },
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('sf:settings:retention:edit')
          .setLabel('Edit Retention')
          .setEmoji('🕒')
          .setStyle(ButtonStyle.Primary),
        backButton(),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function showAppearance(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('🎨 Panel Appearance')
        .setDescription('Customize the main support panel without editing source code.')
        .addFields(
          { name: 'Title', value: settings.appearance.panelTitle, inline: false },
          { name: 'Description', value: settings.appearance.panelDescription, inline: false },
          { name: 'Footer', value: settings.appearance.panelFooter, inline: false },
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('sf:settings:appearance:edit')
          .setLabel('Edit Appearance')
          .setEmoji('✏️')
          .setStyle(ButtonStyle.Primary),
        backButton(),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function showStorage(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);

  const closed = settings.closedCategoryId
    ? '<#' + settings.closedCategoryId + '>'
    : 'Not created';

  const archive = settings.archiveCategoryId
    ? '<#' + settings.archiveCategoryId + '>'
    : 'Not created';

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('🗄️ Ticket Storage')
        .setDescription(
          'SupportForge keeps active tickets separate from historical storage. ' +
          'There is intentionally no Billing-specific storage layer; each server can create whatever departments and channel structure it needs.',
        )
        .addFields(
          { name: 'Closed', value: closed, inline: true },
          { name: 'Archive', value: archive, inline: true },
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('sf:settings:storage:repair')
          .setLabel('Repair Storage')
          .setEmoji('🛠️')
          .setStyle(ButtonStyle.Primary),
        backButton(),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function openModal(
  interaction: ButtonInteraction,
  customId: string,
  title: string,
  inputs: TextInputBuilder[],
): Promise<void> {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);

  for (const input of inputs) {
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
  }

  await interaction.showModal(modal);
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

    if (id === 'sf:settings:home' || id === 'sf:settings:refresh') {
      await showHome(interaction);
      return true;
    }

    if (id === 'sf:settings:panel') {
      await showPanelSettings(interaction);
      return true;
    }

    if (id === 'sf:settings:panel:toggle') {
      await interaction.deferUpdate();
      await updateAdvancedSettings(guild.id, (settings) => {
        settings.panelActivity.enabled = !settings.panelActivity.enabled;
      });
      await refreshSettingsChannel(guild);
      await showHomeAfterUpdate(interaction);
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
      await openModal(interaction, 'sf:settings:modal:tag:add', 'Add Custom Tag', [
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
      await interaction.followUp({
        content: removed ? '✅ Custom tag removed.' : '❌ That tag no longer exists.',
        flags: MessageFlags.Ephemeral,
      });
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
      await interaction.followUp({
        content: '✅ Department **' + department.name + '** removed.',
        flags: MessageFlags.Ephemeral,
      });
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
      await interaction.editReply('✅ Panel thresholds updated.');
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
      await interaction.editReply('✅ Default ticket priority updated to **' + priority + '**.');
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
        await interaction.editReply('✅ Added custom tag ' + tag.emoji + ' **' + tag.name + '**.');
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

      await updateGuildConfig(guild.id, (current) => {
        current.departments[id] = {
          id,
          name,
          staffRoleId,
          createdAt: new Date().toISOString(),
        };
      });

      await syncPanel(guild);
      await refreshSettingsChannel(guild);
      await interaction.editReply('✅ Department **' + name + '** added.');
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
      await interaction.editReply('✅ Retention settings updated.');
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
      await interaction.editReply('✅ Panel appearance updated and the support panel has been refreshed.');
      return true;
    }
  }

  return false;
}

async function showHomeAfterUpdate(interaction: ButtonInteraction): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const config = await getGuildConfig(interaction.guild!.id);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle('⚙️ SupportForge Settings')
        .setDescription('Settings updated successfully.')
        .addFields(
          { name: 'Panel', value: settings.panelActivity.enabled ? 'Automatic movement enabled' : 'Automatic movement disabled', inline: true },
          { name: 'Tags', value: String(Object.keys(settings.customTags).length), inline: true },
          { name: 'Departments', value: String(Object.keys(config.departments).length), inline: true },
        ),
    ],
    components: buildSettingsDashboardComponents(),
  });
}

async function repairSystem(guild: Guild): Promise<void> {
  const supportCategory = await ensureContainer(guild);
  await ensureTranscriptChannel(guild, supportCategory.id);
  await ensurePanelChannel(guild, supportCategory.id);
  await ensureClosedCategory(guild);
  await ensureArchiveCategory(guild);
  await syncPanel(guild);
}
