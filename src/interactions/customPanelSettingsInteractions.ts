import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import { getGuildConfig } from '../services/configService';
import { getGuildTheme } from '../services/uiThemeService';
import { logSettingsEvent } from '../services/auditLogService';
import {
  buildCustomPanelComponents,
  buildCustomPanelEmbed,
  createCustomPanel,
  deleteCustomPanelDefinition,
  getCustomPanel,
  listCustomPanels,
  markCustomPanelPublished,
  updateCustomPanel,
} from '../services/panelBuilderService';

type PanelSettingsInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;
type PanelComponents = Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>>;
const PREFIX = 'sf:settings:panels:';

function makeButton(id: string, label: string, style = ButtonStyle.Secondary, emoji?: string): ButtonBuilder {
  const button = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (emoji) button.setEmoji(emoji);
  return button;
}

function row(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

async function prepare(interaction: PanelSettingsInteraction): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  if (interaction.isButton() && interaction.message.flags.has(MessageFlags.Ephemeral)) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

async function render(
  interaction: PanelSettingsInteraction,
  title: string,
  description: string,
  components: PanelComponents = [],
  extraEmbeds: EmbedBuilder[] = [],
): Promise<void> {
  await prepare(interaction);
  const theme = interaction.guild ? await getGuildTheme(interaction.guild.id) : { label: 'Midnight Indigo', color: 0x5865f2 };
  const embed = new EmbedBuilder()
    .setColor(theme.color)
    .setAuthor({ name: 'ResolveX • Custom Panel Builder' })
    .setTitle(title.slice(0, 256))
    .setDescription((description || 'Choose an action below.').slice(0, 4096))
    .setFooter({ text: theme.label + ' theme • drafts persist in Neon PostgreSQL' });
  await interaction.editReply({ content: '', embeds: [embed, ...extraEmbeds], components });
}

function isAdmin(interaction: PanelSettingsInteraction): boolean {
  return Boolean(
    interaction.memberPermissions?.has('Administrator') ||
    interaction.memberPermissions?.has('ManageGuild'),
  );
}

async function audit(
  interaction: PanelSettingsInteraction,
  action: string,
  detail: string,
): Promise<void> {
  if (!interaction.guild) return;
  const config = await getGuildConfig(interaction.guild.id);
  if (!config.supportCategoryId) return;
  await logSettingsEvent(interaction.guild, config.supportCategoryId, {
    action,
    actorId: interaction.user.id,
    actorName: interaction.user.tag,
    detail,
  }).catch((error) => console.warn('Custom panel UI audit failed:', error));
}

function createPanelModal(): ModalBuilder {
  const name = new TextInputBuilder().setCustomId('name').setLabel('Panel name').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true);
  const title = new TextInputBuilder().setCustomId('title').setLabel('Display title').setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true);
  const description = new TextInputBuilder().setCustomId('description').setLabel('Instructions for customers').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true);
  const buttons = new TextInputBuilder().setCustomId('buttons-json').setLabel('Ordered buttons JSON (max 25)').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true)
    .setPlaceholder('[{"departmentId":"billing","label":"Billing","emoji":"💳","style":"primary"}]');
  return new ModalBuilder().setCustomId(PREFIX + 'modal:create').setTitle('Create Custom Panel')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(name),
      new ActionRowBuilder<TextInputBuilder>().addComponents(title),
      new ActionRowBuilder<TextInputBuilder>().addComponents(description),
      new ActionRowBuilder<TextInputBuilder>().addComponents(buttons),
    );
}

function appearancePanelModal(panel: {
  id: string;
  footer: string;
  color: string | null;
  thumbnailUrl: string | null;
  bannerUrl: string | null;
}): ModalBuilder {
  const footer = new TextInputBuilder().setCustomId('footer').setLabel('Footer (type none to clear)').setStyle(TextInputStyle.Short).setMaxLength(2048).setRequired(false);
  if (panel.footer) footer.setValue(panel.footer.slice(0, 1000));
  const color = new TextInputBuilder().setCustomId('color').setLabel('Accent hex color, or none for server theme').setStyle(TextInputStyle.Short).setMaxLength(7).setRequired(false)
    .setPlaceholder('#22D3EE');
  if (panel.color) color.setValue('#' + panel.color);
  const thumbnail = new TextInputBuilder().setCustomId('thumbnail-url').setLabel('Thumbnail URL (type none to clear)').setStyle(TextInputStyle.Short).setMaxLength(1000).setRequired(false);
  if (panel.thumbnailUrl) thumbnail.setValue(panel.thumbnailUrl.slice(0, 1000));
  const banner = new TextInputBuilder().setCustomId('banner-url').setLabel('Banner image URL (type none to clear)').setStyle(TextInputStyle.Short).setMaxLength(1000).setRequired(false);
  if (panel.bannerUrl) banner.setValue(panel.bannerUrl.slice(0, 1000));
  return new ModalBuilder().setCustomId(PREFIX + 'modal:appearance:' + panel.id).setTitle('Panel Branding')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(footer),
      new ActionRowBuilder<TextInputBuilder>().addComponents(color),
      new ActionRowBuilder<TextInputBuilder>().addComponents(thumbnail),
      new ActionRowBuilder<TextInputBuilder>().addComponents(banner),
    );
}

function updatePanelModal(panelId: string): ModalBuilder {
  const name = new TextInputBuilder().setCustomId('name').setLabel('Panel name (leave blank to keep)').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(false);
  const title = new TextInputBuilder().setCustomId('title').setLabel('Display title (leave blank to keep)').setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(false);
  const description = new TextInputBuilder().setCustomId('description').setLabel('Instructions (blank keeps current)').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(false);
  const buttons = new TextInputBuilder().setCustomId('buttons-json').setLabel('New ordered buttons JSON (optional)').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(false)
    .setPlaceholder('Leave blank to keep buttons. Order in this array becomes button order.');
  return new ModalBuilder().setCustomId(PREFIX + 'modal:update:' + panelId).setTitle('Update Panel Draft')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(name),
      new ActionRowBuilder<TextInputBuilder>().addComponents(title),
      new ActionRowBuilder<TextInputBuilder>().addComponents(description),
      new ActionRowBuilder<TextInputBuilder>().addComponents(buttons),
    );
}

async function showHome(interaction: PanelSettingsInteraction): Promise<void> {
  const guildId = interaction.guild!.id;
  const panels = await listCustomPanels(guildId);
  const departments = Object.values((await getGuildConfig(guildId)).departments);
  const components: PanelComponents = [];
  components.push(row(
    makeButton(PREFIX + 'create', 'Create Panel Draft', ButtonStyle.Success, '➕'),
    makeButton(PREFIX + 'list', 'Refresh Panel List', ButtonStyle.Primary, '📋'),
    makeButton('sf:settings:home', 'Back to Settings', ButtonStyle.Secondary, '↩️'),
  ));
  if (panels.length) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(PREFIX + 'select').setPlaceholder('Choose a saved panel to manage')
        .addOptions(panels.slice(0, 25).map((panel) => ({
          label: panel.name.slice(0, 100),
          value: panel.id,
          description: (panel.publishedMessageId ? 'Published' : 'Draft') + ' • ' + panel.buttons.length + ' button(s)',
        }))),
    ));
  }
  await render(
    interaction,
    'Custom Support Panels',
    'Build more than one branded support entry point without editing code. Create a draft, inspect it privately, then publish it to a channel. Button order follows the JSON array. Each button uses the existing validated ticket-creation flow.\n\n**Saved panels:** ' + panels.length +
      '\n**Available departments:** ' + departments.length +
      '\n\nPanel deletion removes only the panel definition/message. Tickets created from it are independent and are never deleted.',
    components,
  );
}

async function showPanel(interaction: PanelSettingsInteraction, panelId: string): Promise<void> {
  const guild = interaction.guild!;
  const panel = await getCustomPanel(guild.id, panelId);
  if (!panel) throw new Error('Panel not found. Open Custom Panels and refresh the list.');
  const config = await getGuildConfig(guild.id);
  const theme = await getGuildTheme(guild.id);
  const lines = panel.buttons.map((item, index) =>
    (index + 1) + '. ' + (item.emoji ? item.emoji + ' ' : '') + '**' + item.label + '** → ' +
    (config.departments[item.departmentId]?.name ?? 'Missing department') + ' · ' + item.style,
  ).join('\n');
  const status = panel.publishedMessageId ? 'Published in <#' + panel.publishedChannelId + '>' : 'Draft only';
  await render(
    interaction,
    panel.name + ' • Panel Details',
    '**Panel ID:** `' + panel.id + '`\n**Status:** ' + status + '\n**Updated:** <t:' + Math.floor(new Date(panel.updatedAt).getTime() / 1000) + ':R>\n\n**Ordered buttons**\n' + lines +
      '\n\nUpdating the draft does not edit the public message until you publish. Already-open tickets are unchanged.',
    [
      row(
        makeButton(PREFIX + 'preview:' + panel.id, 'Live Preview', ButtonStyle.Primary, '👁️'),
        makeButton(PREFIX + 'update:' + panel.id, 'Edit Draft', ButtonStyle.Secondary, '✏️'),
        makeButton(PREFIX + 'appearance:' + panel.id, 'Branding', ButtonStyle.Secondary, '🎨'),
        makeButton(PREFIX + 'publish:' + panel.id, 'Publish / Update', ButtonStyle.Success, '🚀'),
      ),
      row(
        makeButton(PREFIX + 'delete:' + panel.id, 'Delete Panel', ButtonStyle.Danger, '🗑️'),
        makeButton(PREFIX + 'home', 'Panel List', ButtonStyle.Secondary, '↩️'),
      ),
    ],
  );
}

function resourceCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

export async function handleCustomPanelSettingsInteraction(
  interaction: PanelSettingsInteraction,
): Promise<boolean> {
  if (!interaction.customId.startsWith(PREFIX)) return false;
  if (!interaction.guild) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Custom panel management can only be used inside a server.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
    return true;
  }
  if (!isAdmin(interaction)) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'You need Manage Server or Administrator to manage custom support panels.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
    return true;
  }

  const guild = interaction.guild;
  const id = interaction.customId;
  try {
    if (interaction.isButton() && id === PREFIX + 'create') {
      await interaction.showModal(createPanelModal());
      return true;
    }
    if (interaction.isButton() && (id === PREFIX + 'home' || id === PREFIX + 'list')) {
      await showHome(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && id === PREFIX + 'select') {
      await showPanel(interaction, interaction.values[0] ?? '');
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'preview:')) {
      const panelId = id.slice((PREFIX + 'preview:').length);
      const panel = await getCustomPanel(guild.id, panelId);
      if (!panel) throw new Error('Panel not found.');
      const theme = await getGuildTheme(guild.id);
      const embed = buildCustomPanelEmbed(panel, guild.name, theme.color, true);
      const previewRows = buildCustomPanelComponents(panel, true);
      // Discord allows five action rows per message. Reserve the fifth row for
      // navigation, showing the first 20 controls when a draft has 21–25.
      const visiblePreviewRows = previewRows.slice(0, 4);
      const previewNote = panel.buttons.length > 20
        ? 'Private draft preview. The first 20 buttons are shown here so navigation fits within Discord’s five-row limit; publishing includes all ' + panel.buttons.length + ' configured buttons. Preview buttons are disabled.'
        : 'Private draft preview. Ticket buttons are disabled here and only become active after publishing.';
      await render(interaction, panel.name + ' • Live Preview', previewNote, [
        ...visiblePreviewRows,
        row(makeButton(PREFIX + 'detail:' + panel.id, 'Back to Panel Details', ButtonStyle.Secondary, '↩️')),
      ], [embed]);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'detail:')) {
      await showPanel(interaction, id.slice((PREFIX + 'detail:').length));
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'update:')) {
      const panelId = id.slice((PREFIX + 'update:').length);
      if (!await getCustomPanel(guild.id, panelId)) throw new Error('Panel not found.');
      await interaction.showModal(updatePanelModal(panelId));
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'appearance:')) {
      const panelId = id.slice((PREFIX + 'appearance:').length);
      const panel = await getCustomPanel(guild.id, panelId);
      if (!panel) throw new Error('Panel not found.');
      await interaction.showModal(appearancePanelModal(panel));
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'publish:')) {
      const panelId = id.slice((PREFIX + 'publish:').length);
      if (!await getCustomPanel(guild.id, panelId)) throw new Error('Panel not found.');
      const channels = (await guild.channels.fetch()).filter((channel) => channel?.type === 0).map((channel) => channel!).sort((a, b) => a.name.localeCompare(b.name));
      if (!channels.length) throw new Error('No standard text channels were found.');
      const select = new StringSelectMenuBuilder().setCustomId(PREFIX + 'channel:' + panelId).setPlaceholder('Choose where to publish this panel')
        .addOptions(channels.slice(0, 25).map((channel) => ({ label: channel.name.slice(0, 100), value: channel.id, description: 'Publish panel to #' + channel.name })));
      await render(interaction, 'Publish Custom Panel', 'Choose a text channel for this panel. Publishing edits its current message when possible. If you publish to a new channel, ResolveX tries to remove the previous panel message after the new one is saved.', [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        row(makeButton(PREFIX + 'detail:' + panelId, 'Cancel', ButtonStyle.Secondary, '↩️')),
      ]);
      return true;
    }
    if (interaction.isStringSelectMenu() && id.startsWith(PREFIX + 'channel:')) {
      const panelId = id.slice((PREFIX + 'channel:').length);
      const targetChannelId = interaction.values[0];
      if (!targetChannelId) throw new Error('Choose a channel first.');
      const panel = await getCustomPanel(guild.id, panelId);
      if (!panel) throw new Error('Panel not found.');
      const target = await guild.channels.fetch(targetChannelId);
      if (target?.type !== 0) throw new Error('Publish target must be a standard text channel.');
      const theme = await getGuildTheme(guild.id);
      const payload = { embeds: [buildCustomPanelEmbed(panel, guild.name, theme.color)], components: buildCustomPanelComponents(panel, false) };
      const oldChannelId = panel.publishedChannelId;
      const oldMessageId = panel.publishedMessageId;
      let message = oldChannelId === target.id && oldMessageId
        ? await target.messages.fetch(oldMessageId).catch((error) => {
            if (resourceCode(error) === 10008) return null;
            throw error;
          })
        : null;
      if (message) await message.edit(payload);
      else message = await target.send(payload);
      await markCustomPanelPublished(guild.id, panelId, target.id, message.id);
      let cleanupWarning = '';
      if (oldChannelId && oldMessageId && (oldChannelId !== target.id || oldMessageId !== message.id)) {
        try {
          const oldChannel = await guild.channels.fetch(oldChannelId);
          if (oldChannel?.type === 0) {
            const oldMessage = await oldChannel.messages.fetch(oldMessageId).catch((error) => {
              if (resourceCode(error) === 10008) return null;
              throw error;
            });
            if (oldMessage) await oldMessage.delete();
          }
        } catch {
          cleanupWarning = '\n\n⚠️ The old message could not be removed. Delete it manually to prevent duplicate entry points.';
        }
      }
      await audit(interaction, 'CUSTOM_PANEL_PUBLISHED', 'Published panel "' + panel.name + '" (' + panel.id + ') to channel ' + target.id + '.');
      await render(interaction, 'Panel Published', '**' + panel.name + '** is now live in <#' + target.id + '>.\n\nIts buttons start tickets through the standard validated creation pipeline. Existing tickets are not affected.' + cleanupWarning, [
        row(makeButton(PREFIX + 'detail:' + panel.id, 'Panel Details', ButtonStyle.Primary, '🎛️'), makeButton(PREFIX + 'home', 'Panel List', ButtonStyle.Secondary, '📋')),
      ]);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'delete:')) {
      const panelId = id.slice((PREFIX + 'delete:').length);
      const panel = await getCustomPanel(guild.id, panelId);
      if (!panel) throw new Error('Panel not found.');
      await render(interaction, 'Confirm Panel Deletion', 'Delete **' + panel.name + '** (' + panel.id + ')? This removes only the saved panel and its published message. Tickets already created from this panel are preserved.', [
        row(makeButton(PREFIX + 'delete-confirm:' + panel.id, 'Confirm Delete', ButtonStyle.Danger, '🗑️'), makeButton(PREFIX + 'detail:' + panel.id, 'Cancel', ButtonStyle.Secondary, '↩️')),
      ]);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'delete-confirm:')) {
      const panelId = id.slice((PREFIX + 'delete-confirm:').length);
      const panel = await getCustomPanel(guild.id, panelId);
      if (!panel) throw new Error('Panel not found.');
      if (panel.publishedChannelId && panel.publishedMessageId) {
        const publishedChannel = await guild.channels.fetch(panel.publishedChannelId).catch((error) => {
          // A channel may have been deleted in Discord before panel cleanup.
          // In that case the saved definition can still be safely removed.
          if (resourceCode(error) === 10003) return null;
          throw error;
        });
        if (publishedChannel?.type === 0) {
          const publishedMessage = await publishedChannel.messages.fetch(panel.publishedMessageId).catch((error) => {
            if (resourceCode(error) === 10008) return null;
            throw error;
          });
          if (publishedMessage) await publishedMessage.delete();
        }
      }
      await deleteCustomPanelDefinition(guild.id, panelId);
      await audit(interaction, 'CUSTOM_PANEL_DELETED', 'Deleted panel "' + panel.name + '" (' + panel.id + '); existing tickets were preserved.');
      await render(interaction, 'Panel Deleted', 'The panel definition and published message were removed. Tickets created from it remain untouched.', [
        row(makeButton(PREFIX + 'home', 'Back to Custom Panels', ButtonStyle.Primary, '📋'), makeButton('sf:settings:home', 'Settings', ButtonStyle.Secondary, '↩️')),
      ]);
      return true;
    }
    if (interaction.isModalSubmit() && id === PREFIX + 'modal:create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const panel = await createCustomPanel(guild.id, {
        name: interaction.fields.getTextInputValue('name'),
        title: interaction.fields.getTextInputValue('title'),
        description: interaction.fields.getTextInputValue('description'),
        buttons: interaction.fields.getTextInputValue('buttons-json'),
      });
      await audit(interaction, 'CUSTOM_PANEL_CREATED', 'Created draft panel "' + panel.name + '" (' + panel.id + ').');
      await render(interaction, 'Panel Draft Created', '**' + panel.name + '** was saved to Neon.\nPanel ID: `' + panel.id + '`\nButtons: **' + panel.buttons.length + '**\n\nPreview it privately and publish when ready.', [
        row(makeButton(PREFIX + 'preview:' + panel.id, 'Preview Draft', ButtonStyle.Primary, '👁️'), makeButton(PREFIX + 'detail:' + panel.id, 'Panel Details', ButtonStyle.Secondary, '🎛️')),
        row(makeButton(PREFIX + 'home', 'Custom Panels', ButtonStyle.Secondary, '↩️')),
      ]);
      return true;
    }
    if (interaction.isModalSubmit() && id.startsWith(PREFIX + 'modal:appearance:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const panelId = id.slice((PREFIX + 'modal:appearance:').length);
      const optional = (fieldId: string): string | undefined => {
        const value = interaction.fields.getTextInputValue(fieldId).trim();
        return value || undefined;
      };
      const nullable = (fieldId: string): string | null | undefined => {
        const value = optional(fieldId);
        if (value === undefined) return undefined;
        return value.toLowerCase() === 'none' ? null : value;
      };
      const footer = optional('footer');
      const updated = await updateCustomPanel(guild.id, panelId, {
        footer: footer === undefined ? undefined : (footer.toLowerCase() === 'none' ? '' : footer),
        color: nullable('color'),
        thumbnailUrl: nullable('thumbnail-url'),
        bannerUrl: nullable('banner-url'),
      });
      await audit(interaction, 'CUSTOM_PANEL_BRANDING_UPDATED', 'Updated branding for panel "' + updated.name + '" (' + updated.id + ').');
      await render(interaction, 'Panel Branding Updated', 'Saved branding for **' + updated.name + '**. Your published message stays unchanged until you publish the panel again.', [
        row(makeButton(PREFIX + 'preview:' + updated.id, 'Preview Draft', ButtonStyle.Primary, '👁️'), makeButton(PREFIX + 'detail:' + updated.id, 'Panel Details', ButtonStyle.Secondary, '🎛️')),
      ]);
      return true;
    }
    if (interaction.isModalSubmit() && id.startsWith(PREFIX + 'modal:update:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const panelId = id.slice((PREFIX + 'modal:update:').length);
      const readOptional = (key: string): string | undefined => {
        const value = interaction.fields.getTextInputValue(key).trim();
        return value ? value : undefined;
      };
      const updated = await updateCustomPanel(guild.id, panelId, {
        name: readOptional('name'),
        title: readOptional('title'),
        description: readOptional('description'),
        buttons: readOptional('buttons-json'),
      });
      await audit(interaction, 'CUSTOM_PANEL_UPDATED', 'Updated draft panel "' + updated.name + '" (' + updated.id + ').');
      await render(interaction, 'Panel Draft Updated', '**' + updated.name + '** has been saved. The published message remains unchanged until you publish again.', [
        row(makeButton(PREFIX + 'preview:' + updated.id, 'Preview Draft', ButtonStyle.Primary, '👁️'), makeButton(PREFIX + 'detail:' + updated.id, 'Panel Details', ButtonStyle.Secondary, '🎛️')),
      ]);
      return true;
    }
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown custom panel error.';
    const theme = await getGuildTheme(guild.id).catch(() => ({ label: 'Midnight Indigo', color: 0x5865f2 }));
    const embed = new EmbedBuilder().setColor(theme.color).setTitle('Custom Panel action failed').setDescription(message.slice(0, 4096));
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '', embeds: [embed], components: [row(makeButton(PREFIX + 'home', 'Custom Panels', ButtonStyle.Primary, '📋'))] }).catch(() => undefined);
    } else {
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
    return true;
  }
}
