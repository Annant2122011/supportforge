import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import { getGuildConfig } from '../services/configService';
import { getGuildTheme } from '../services/uiThemeService';
import { logSettingsEvent } from '../services/auditLogService';
import {
  addCustomPanelButton,
  buildCustomPanelComponents,
  buildCustomPanelEmbed,
  createCustomPanel,
  deleteCustomPanelButton,
  deleteCustomPanelDefinition,
  getCustomPanel,
  listCustomPanels,
  markCustomPanelPublished,
  moveCustomPanelButton,
  setCustomPanelRoleAccess,
  updateCustomPanel,
  updateCustomPanelButton,
} from '../services/panelBuilderService';
import type { SupportPanelButtonStyle } from '../services/configService';
import { listTicketForms } from '../services/ticketFormService';

type PanelSettingsInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | RoleSelectMenuInteraction
  | ModalSubmitInteraction;
type PanelComponents = Array<
  ActionRowBuilder<ButtonBuilder> |
  ActionRowBuilder<StringSelectMenuBuilder> |
  ActionRowBuilder<RoleSelectMenuBuilder>
>;
const PREFIX = 'sf:settings:panels:';
const PAGE_SIZE = 25;

function makeButton(
  id: string,
  label: string,
  style = ButtonStyle.Secondary,
  emoji?: string,
  disabled = false,
): ButtonBuilder {
  const button = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  if (emoji) button.setEmoji(emoji);
  return button;
}

function row(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

function selectRow(menu: StringSelectMenuBuilder): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function roleSelectRow(menu: RoleSelectMenuBuilder): ActionRowBuilder<RoleSelectMenuBuilder> {
  return new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu);
}

async function prepare(interaction: PanelSettingsInteraction): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  const isComponent = interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu();
  if (isComponent && interaction.message.flags.has(MessageFlags.Ephemeral)) {
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
  const theme = interaction.guild
    ? await getGuildTheme(interaction.guild.id)
    : { label: 'Midnight Indigo', color: 0x5865f2 };
  const embed = new EmbedBuilder()
    .setColor(theme.color)
    .setAuthor({ name: 'ResolveX • Custom Panel Builder' })
    .setTitle(title.slice(0, 256))
    .setDescription((description || 'Choose an action below.').slice(0, 4096))
    .setFooter({ text: theme.label + ' theme • drafts persist in Neon PostgreSQL' });
  await interaction.editReply({ content: '', embeds: [embed, ...extraEmbeds].slice(0, 10), components });
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

function readOptionalModalText(interaction: ModalSubmitInteraction, id: string): string | undefined {
  const value = interaction.fields.getTextInputValue(id).trim();
  return value || undefined;
}

function parseStyle(value: string | undefined): SupportPanelButtonStyle {
  const style = (value || 'primary').trim().toLowerCase();
  if (style !== 'primary' && style !== 'secondary' && style !== 'success' && style !== 'danger') {
    throw new Error('Button style must be primary, secondary, success, or danger.');
  }
  return style;
}

function createPanelModal(): ModalBuilder {
  return new ModalBuilder().setCustomId(PREFIX + 'modal:create').setTitle('Create Support Panel Draft')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('name').setLabel('Panel name').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('title').setLabel('Display title').setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('description').setLabel('Instructions for customers').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true),
      ),
    );
}

function updatePanelModal(panelId: string, panel: { name: string; title: string; description: string }): ModalBuilder {
  const name = new TextInputBuilder().setCustomId('name').setLabel('Panel name').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true).setValue(panel.name.slice(0, 80));
  const title = new TextInputBuilder().setCustomId('title').setLabel('Display title').setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true).setValue(panel.title.slice(0, 256));
  const description = new TextInputBuilder().setCustomId('description').setLabel('Customer instructions').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true);
  if (panel.description) description.setValue(panel.description.slice(0, 4000));
  return new ModalBuilder().setCustomId(PREFIX + 'modal:update:' + panelId).setTitle('Edit Panel Details')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(name),
      new ActionRowBuilder<TextInputBuilder>().addComponents(title),
      new ActionRowBuilder<TextInputBuilder>().addComponents(description),
    );
}

function appearancePanelModal(panel: {
  id: string;
  footer: string;
  color: string | null;
  iconUrl: string | null;
  thumbnailUrl: string | null;
  bannerUrl: string | null;
}): ModalBuilder {
  const footer = new TextInputBuilder().setCustomId('footer').setLabel('Footer (type none to clear)').setStyle(TextInputStyle.Short).setMaxLength(1000).setRequired(false);
  if (panel.footer) footer.setValue(panel.footer.slice(0, 1000));
  const color = new TextInputBuilder().setCustomId('color').setLabel('Hex color, or none for server theme').setStyle(TextInputStyle.Short).setMaxLength(7).setRequired(false).setPlaceholder('#22D3EE');
  if (panel.color) color.setValue('#' + panel.color);
  const icon = new TextInputBuilder().setCustomId('icon-url').setLabel('Small icon URL (type none to clear)').setStyle(TextInputStyle.Short).setMaxLength(1000).setRequired(false);
  if (panel.iconUrl) icon.setValue(panel.iconUrl.slice(0, 1000));
  const thumbnail = new TextInputBuilder().setCustomId('thumbnail-url').setLabel('Thumbnail URL (type none to clear)').setStyle(TextInputStyle.Short).setMaxLength(1000).setRequired(false);
  if (panel.thumbnailUrl) thumbnail.setValue(panel.thumbnailUrl.slice(0, 1000));
  const banner = new TextInputBuilder().setCustomId('banner-url').setLabel('Banner image URL (type none to clear)').setStyle(TextInputStyle.Short).setMaxLength(1000).setRequired(false);
  if (panel.bannerUrl) banner.setValue(panel.bannerUrl.slice(0, 1000));
  return new ModalBuilder().setCustomId(PREFIX + 'modal:appearance:' + panel.id).setTitle('Panel Branding')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(footer),
      new ActionRowBuilder<TextInputBuilder>().addComponents(color),
      new ActionRowBuilder<TextInputBuilder>().addComponents(icon),
      new ActionRowBuilder<TextInputBuilder>().addComponents(thumbnail),
      new ActionRowBuilder<TextInputBuilder>().addComponents(banner),
    );
}

function addDepartmentButtonModal(panelId: string, departmentId: string, departmentName: string): ModalBuilder {
  return new ModalBuilder().setCustomId(PREFIX + 'modal:add-department:' + panelId + ':' + departmentId).setTitle('Add Department Button')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('label').setLabel('Button label').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true).setValue(departmentName.slice(0, 80)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false).setPlaceholder('🎫'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('style').setLabel('Style: primary/secondary/success/danger').setStyle(TextInputStyle.Short).setMaxLength(9).setRequired(true).setValue('primary'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('tag-id').setLabel('Tag ID (blank = ask user)').setStyle(TextInputStyle.Short).setMaxLength(28).setRequired(false).setPlaceholder('Leave empty to show tag picker'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('confirmation').setLabel('Confirmation text (optional)').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false),
      ),
    );
}

function addFormButtonModal(panelId: string, formId: string, tagId: string, formName: string): ModalBuilder {
  return new ModalBuilder().setCustomId(PREFIX + 'modal:add-form:' + panelId + ':' + formId + ':' + tagId).setTitle('Add Form Button')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('label').setLabel('Button label').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true).setValue(formName.slice(0, 80)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('emoji').setLabel('Emoji (optional)').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false).setPlaceholder('📝'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('style').setLabel('Style: primary/secondary/success/danger').setStyle(TextInputStyle.Short).setMaxLength(9).setRequired(true).setValue('primary'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('confirmation').setLabel('Confirmation text (optional)').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false),
      ),
    );
}

function editButtonModal(
  panelId: string,
  button: { id: string; label: string; emoji?: string; style: SupportPanelButtonStyle; confirmationMessage: string | null },
): ModalBuilder {
  const label = new TextInputBuilder().setCustomId('label').setLabel('Button label').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true).setValue(button.label.slice(0, 80));
  const emoji = new TextInputBuilder().setCustomId('emoji').setLabel('Emoji (type none to clear)').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false);
  if (button.emoji) emoji.setValue(button.emoji.slice(0, 100));
  const style = new TextInputBuilder().setCustomId('style').setLabel('Style: primary/secondary/success/danger').setStyle(TextInputStyle.Short).setMaxLength(9).setRequired(true).setValue(button.style);
  const confirmation = new TextInputBuilder().setCustomId('confirmation').setLabel('Confirmation text (none to clear)').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false);
  if (button.confirmationMessage) confirmation.setValue(button.confirmationMessage.slice(0, 1000));
  return new ModalBuilder().setCustomId(PREFIX + 'modal:edit-button:' + panelId + ':' + button.id).setTitle('Edit Button')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(label),
      new ActionRowBuilder<TextInputBuilder>().addComponents(emoji),
      new ActionRowBuilder<TextInputBuilder>().addComponents(style),
      new ActionRowBuilder<TextInputBuilder>().addComponents(confirmation),
    );
}

function panelDraftDiffers(panel: NonNullable<Awaited<ReturnType<typeof getCustomPanel>>>): boolean {
  const published = panel.publishedConfig;
  if (!published) return Boolean(panel.publishedMessageId);
  return JSON.stringify({
    title: panel.title,
    description: panel.description,
    footer: panel.footer,
    color: panel.color,
    iconUrl: panel.iconUrl,
    thumbnailUrl: panel.thumbnailUrl,
    bannerUrl: panel.bannerUrl,
    allowedRoleIds: panel.allowedRoleIds,
    buttons: panel.buttons,
  }) !== JSON.stringify({
    title: published.title,
    description: published.description,
    footer: published.footer,
    color: published.color,
    iconUrl: published.iconUrl,
    thumbnailUrl: published.thumbnailUrl,
    bannerUrl: published.bannerUrl,
    allowedRoleIds: published.allowedRoleIds,
    buttons: published.buttons,
  });
}

async function showHome(interaction: PanelSettingsInteraction, page = 0): Promise<void> {
  const guildId = interaction.guild!.id;
  const panels = await listCustomPanels(guildId);
  const departments = Object.values((await getGuildConfig(guildId)).departments);
  const pageCount = Math.max(1, Math.ceil(panels.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visiblePanels = panels.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const components: PanelComponents = [
    row(
      makeButton(PREFIX + 'create', 'Create Panel Draft', ButtonStyle.Success, '➕'),
      makeButton(PREFIX + 'list:' + safePage, 'Refresh List', ButtonStyle.Primary, '📋'),
      makeButton('sf:settings:home', 'Back to Settings', ButtonStyle.Secondary, '↩️'),
    ),
  ];
  if (visiblePanels.length) {
    components.push(selectRow(new StringSelectMenuBuilder()
      .setCustomId(PREFIX + 'select:' + safePage)
      .setPlaceholder('Choose a saved panel to manage')
      .addOptions(visiblePanels.map((panel) => ({
        label: panel.name.slice(0, 100),
        value: panel.id,
        description: (panel.publishedMessageId ? 'Published' : 'Draft') + ' • ' + panel.buttons.length + ' button(s)',
      })))));
  }
  if (pageCount > 1) {
    components.push(row(
      makeButton(PREFIX + 'list:' + (safePage - 1), 'Previous', ButtonStyle.Secondary, '⬅️', safePage === 0),
      makeButton(PREFIX + 'list:' + (safePage + 1), 'Next', ButtonStyle.Secondary, '➡️', safePage >= pageCount - 1),
    ));
  }
  await render(
    interaction,
    'Custom Ticket Panels',
    'Create more than one branded support entry point without editing source code. Drafts, ordered buttons and role rules are saved in Neon. Choose a panel to manage its content, target buttons, access rules, preview and publishing.\n\n**Saved panels:** ' + panels.length +
      '\n**Departments:** ' + departments.length +
      '\n**List page:** ' + (safePage + 1) + ' / ' + pageCount +
      '\n\nPanel deletion removes only its definition and published message. Existing tickets are independent and never deleted.',
    components,
  );
}

async function showPanel(interaction: PanelSettingsInteraction, panelId: string): Promise<void> {
  const guild = interaction.guild!;
  const panel = await getCustomPanel(guild.id, panelId);
  if (!panel) throw new Error('Panel not found. Return to Custom Panels and refresh the list.');
  const config = await getGuildConfig(guild.id);
  const roleNames = panel.allowedRoleIds.map((id) => config.departments ? '<@&' + id + '>' : id);
  const lines = panel.buttons.length
    ? panel.buttons.map((item, index) =>
        (index + 1) + '. ' + (item.emoji ? item.emoji + ' ' : '') + '**' + item.label + '** → ' +
        (item.targetType === 'form' ? 'Form `' + item.formId + '` v' + item.formVersion : config.departments[item.departmentId]?.name ?? 'Missing department') +
        (item.tagId ? ' · tag `' + item.tagId + '`' : '') + ' · ' + item.style +
        (item.allowedRoleIds.length ? ' · restricted' : '') +
        (item.confirmationMessage ? ' · confirmation' : ''),
      ).join('\n')
    : 'No buttons yet. Add a department or a saved form button below.';
  const status = panel.publishedMessageId
    ? 'Published in <#' + panel.publishedChannelId + '>' + (panelDraftDiffers(panel) ? ' • **Draft has unpublished changes**' : ' • up to date')
    : 'Draft only';
  await render(
    interaction,
    panel.name + ' • Panel Builder',
    '**Panel ID:** `' + panel.id + '`\n**Status:** ' + status +
      '\n**Panel access:** ' + (roleNames.length ? roleNames.join(', ') : 'Everyone') +
      '\n**Draft buttons:** ' + panel.buttons.length + ' / 25\n\n**Button order**\n' + lines +
      '\n\nEdit the draft without touching the public message. Re-publish to apply new content, button order and role rules. Already-open tickets are unchanged.',
    [
      row(
        makeButton(PREFIX + 'preview:' + panel.id, 'Live Preview', ButtonStyle.Primary, '👁️'),
        makeButton(PREFIX + 'update:' + panel.id, 'Edit Details', ButtonStyle.Secondary, '✏️'),
        makeButton(PREFIX + 'appearance:' + panel.id, 'Branding', ButtonStyle.Secondary, '🎨'),
        makeButton(PREFIX + 'publish:' + panel.id, 'Publish / Update', ButtonStyle.Success, '🚀', panel.buttons.length === 0),
      ),
      row(
        makeButton(PREFIX + 'buttons:' + panel.id, 'Manage Buttons', ButtonStyle.Primary, '🧩'),
        makeButton(PREFIX + 'access:' + panel.id, 'Panel Access', ButtonStyle.Secondary, '🔐'),
        makeButton(PREFIX + 'delete:' + panel.id, 'Delete Panel', ButtonStyle.Danger, '🗑️'),
        makeButton(PREFIX + 'home', 'Panel List', ButtonStyle.Secondary, '↩️'),
      ),
    ],
  );
}

async function showButtonManager(interaction: PanelSettingsInteraction, panelId: string): Promise<void> {
  const panel = await getCustomPanel(interaction.guild!.id, panelId);
  if (!panel) throw new Error('Panel not found.');
  const components: PanelComponents = [
    row(
      makeButton(PREFIX + 'add-department:' + panelId, 'Add Department Button', ButtonStyle.Success, '🎫', panel.buttons.length >= 25),
      makeButton(PREFIX + 'add-form:' + panelId, 'Add Form Button', ButtonStyle.Primary, '📝', panel.buttons.length >= 25),
      makeButton(PREFIX + 'detail:' + panelId, 'Panel Details', ButtonStyle.Secondary, '↩️'),
    ),
  ];
  if (panel.buttons.length) {
    components.push(selectRow(new StringSelectMenuBuilder()
      .setCustomId(PREFIX + 'button-select:' + panelId)
      .setPlaceholder('Choose a button to edit, move or remove')
      .addOptions(panel.buttons.map((button) => ({
        label: button.label.slice(0, 100),
        value: button.id,
        description: (button.targetType === 'form' ? 'Form target' : 'Department target') + (button.tagId ? ' • pinned tag' : ' • choose tag'),
      })))));
  }
  await render(
    interaction,
    panel.name + ' • Button Builder',
    '**Button order controls the layout**. Move buttons up/down to reorder them. Up to 25 buttons are supported per published panel. A button can start a department flow or open a specific active form. Form buttons are pinned to a version; update the button if its form changes.\n\n**Current buttons:** ' + panel.buttons.length,
    components,
  );
}

async function showButtonDetail(interaction: PanelSettingsInteraction, panelId: string, buttonId: string): Promise<void> {
  const panel = await getCustomPanel(interaction.guild!.id, panelId);
  if (!panel) throw new Error('Panel not found.');
  const index = panel.buttons.findIndex((button) => button.id === buttonId);
  const button = panel.buttons[index];
  if (!button) throw new Error('Button not found. Return to the button builder and refresh the list.');
  const target = button.targetType === 'form'
    ? 'Form `' + button.formId + '` version ' + button.formVersion + ', tag `' + button.tagId + '`'
    : 'Department `' + button.departmentId + '`' + (button.tagId ? ', fixed tag `' + button.tagId + '`' : ', customer chooses a tag');
  await render(
    interaction,
    'Button • ' + button.label,
    '**Type:** ' + button.targetType + '\n**Target:** ' + target + '\n**Style:** ' + button.style +
      '\n**Allowed roles:** ' + (button.allowedRoleIds.length ? button.allowedRoleIds.map((id) => '<@&' + id + '>').join(', ') : 'Same as panel access') +
      '\n**Confirmation:** ' + (button.confirmationMessage ? button.confirmationMessage : 'None') +
      '\n**Order:** ' + (index + 1) + ' of ' + panel.buttons.length,
    [
      row(
        makeButton(PREFIX + 'edit-button:' + panelId + ':' + buttonId, 'Edit Button', ButtonStyle.Primary, '✏️'),
        makeButton(PREFIX + 'access-button:' + panelId + ':' + buttonId, 'Button Access', ButtonStyle.Secondary, '🔐'),
      ),
      row(
        makeButton(PREFIX + 'move-up:' + panelId + ':' + buttonId, 'Move Up', ButtonStyle.Secondary, '⬆️', index === 0),
        makeButton(PREFIX + 'move-down:' + panelId + ':' + buttonId, 'Move Down', ButtonStyle.Secondary, '⬇️', index === panel.buttons.length - 1),
        makeButton(PREFIX + 'delete-button:' + panelId + ':' + buttonId, 'Remove Button', ButtonStyle.Danger, '🗑️'),
        makeButton(PREFIX + 'buttons:' + panelId, 'Button List', ButtonStyle.Secondary, '↩️'),
      ),
    ],
  );
}

async function showDepartmentPicker(interaction: PanelSettingsInteraction, panelId: string, page = 0): Promise<void> {
  const departments = Object.values((await getGuildConfig(interaction.guild!.id)).departments).sort((a, b) => a.name.localeCompare(b.name));
  if (!departments.length) throw new Error('Create a department in Settings → Tags / Departments first.');
  const pageCount = Math.max(1, Math.ceil(departments.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = departments.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const components: PanelComponents = [
    selectRow(new StringSelectMenuBuilder().setCustomId(PREFIX + 'department-pick:' + panelId + ':' + safePage)
      .setPlaceholder('Choose the target department')
      .addOptions(visible.map((department) => ({
        label: department.name.slice(0, 100),
        value: department.id,
        description: Object.keys(department.tags ?? {}).length + ' tag(s)',
      })))),
  ];
  if (pageCount > 1) {
    components.push(row(
      makeButton(PREFIX + 'add-department:' + panelId + ':' + (safePage - 1), 'Previous', ButtonStyle.Secondary, '⬅️', safePage === 0),
      makeButton(PREFIX + 'add-department:' + panelId + ':' + (safePage + 1), 'Next', ButtonStyle.Secondary, '➡️', safePage >= pageCount - 1),
    ));
  }
  components.push(row(makeButton(PREFIX + 'buttons:' + panelId, 'Cancel', ButtonStyle.Secondary, '↩️')));
  await render(interaction, 'Add Department Button', 'Choose an existing department. You can optionally pin a tag or let customers choose one when they click the published button.\nPage ' + (safePage + 1) + ' / ' + pageCount, components);
}

async function showFormPicker(interaction: PanelSettingsInteraction, panelId: string, page = 0): Promise<void> {
  const forms = (await listTicketForms(interaction.guild!.id)).filter((form) => form.active).sort((a, b) => a.name.localeCompare(b.name));
  if (!forms.length) throw new Error('There are no active forms. Create and activate a form before adding a form-target button.');
  const pageCount = Math.max(1, Math.ceil(forms.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = forms.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const components: PanelComponents = [
    selectRow(new StringSelectMenuBuilder().setCustomId(PREFIX + 'form-pick:' + panelId + ':' + safePage)
      .setPlaceholder('Choose an active form')
      .addOptions(visible.map((form) => ({
        label: (form.name + ' · v' + form.version).slice(0, 100),
        value: form.id,
        description: (form.tagId ? 'Exact tag' : 'Wildcard form; choose a tag') + ' • ' + form.departmentId,
      })))),
  ];
  if (pageCount > 1) {
    components.push(row(
      makeButton(PREFIX + 'add-form:' + panelId + ':' + (safePage - 1), 'Previous', ButtonStyle.Secondary, '⬅️', safePage === 0),
      makeButton(PREFIX + 'add-form:' + panelId + ':' + (safePage + 1), 'Next', ButtonStyle.Secondary, '➡️', safePage >= pageCount - 1),
    ));
  }
  components.push(row(makeButton(PREFIX + 'buttons:' + panelId, 'Cancel', ButtonStyle.Secondary, '↩️')));
  await render(interaction, 'Add Form Button', 'Choose an active form. Buttons pin the current form version so the public link cannot silently change meaning after an administrator edits the form.\nPage ' + (safePage + 1) + ' / ' + pageCount, components);
}

async function showFormTagPicker(interaction: ButtonInteraction | StringSelectMenuInteraction, panelId: string, formId: string, page = 0): Promise<void> {
  const config = await getGuildConfig(interaction.guild!.id);
  const form = (await listTicketForms(interaction.guild!.id)).find((candidate) => candidate.id === formId && candidate.active);
  if (!form) throw new Error('That form was deactivated. Refresh the active form list.');
  if (form.tagId) {
    await interaction.showModal(addFormButtonModal(panelId, form.id, form.tagId, form.name));
    return;
  }
  const department = config.departments[form.departmentId];
  if (!department) throw new Error('The selected form’s department no longer exists.');
  const tags = Object.values(department.tags ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  if (!tags.length) throw new Error('The selected form’s department has no tags. Add a tag and retry.');
  const pageCount = Math.max(1, Math.ceil(tags.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = tags.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const components: PanelComponents = [
    selectRow(new StringSelectMenuBuilder().setCustomId(PREFIX + 'form-tag-pick:' + panelId + ':' + formId + ':' + safePage)
      .setPlaceholder('Choose the tag this form button should use')
      .addOptions(visible.map((tag) => ({ label: tag.name.slice(0, 100), value: tag.id })))),
  ];
  if (pageCount > 1) {
    components.push(row(
      makeButton(PREFIX + 'form-tag-page:' + panelId + ':' + formId + ':' + (safePage - 1), 'Previous', ButtonStyle.Secondary, '⬅️', safePage === 0),
      makeButton(PREFIX + 'form-tag-page:' + panelId + ':' + formId + ':' + (safePage + 1), 'Next', ButtonStyle.Secondary, '➡️', safePage >= pageCount - 1),
    ));
  }
  components.push(row(makeButton(PREFIX + 'buttons:' + panelId, 'Cancel', ButtonStyle.Secondary, '↩️')));
  await render(interaction, 'Select Form Tag', 'This form applies to all tags. Select the tag whose tickets should open this exact form.', components);
}

async function showPanelAccess(interaction: PanelSettingsInteraction, panelId: string, buttonId?: string): Promise<void> {
  const panel = await getCustomPanel(interaction.guild!.id, panelId);
  if (!panel) throw new Error('Panel not found.');
  const button = buttonId ? panel.buttons.find((candidate) => candidate.id === buttonId) : undefined;
  if (buttonId && !button) throw new Error('Button not found.');
  const roleIds = button ? button.allowedRoleIds : panel.allowedRoleIds;
  const current = roleIds.length ? roleIds.map((id) => '<@&' + id + '>').join(', ') : 'Everyone';
  const customId = button
    ? PREFIX + 'role-select-button:' + panelId + ':' + button.id
    : PREFIX + 'role-select-panel:' + panelId;
  const roleMenu = new RoleSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Select allowed roles (empty selection clears restrictions)')
    .setMinValues(0)
    .setMaxValues(25);
  await render(
    interaction,
    button ? 'Button Access Rules' : 'Panel Access Rules',
    '**Current allowed roles:** ' + current +
      '\nChoose roles below. Selection replaces the current allowed-role list. An empty selection permits everyone at this level. Panel and button rules are combined: when both are restricted, the member must satisfy both.',
    [
      roleSelectRow(roleMenu),
      row(
        makeButton(PREFIX + 'access-clear:' + panelId + (button ? ':' + button.id : ''), 'Allow Everyone', ButtonStyle.Secondary, '🌐'),
        makeButton(button ? PREFIX + 'button:' + panelId + ':' + button.id : PREFIX + 'detail:' + panelId, button ? 'Button Details' : 'Panel Details', ButtonStyle.Secondary, '↩️'),
      ),
    ],
  );
}

async function showPublishChannelPicker(
  interaction: PanelSettingsInteraction,
  panelId: string,
  page = 0,
): Promise<void> {
  await prepare(interaction);
  const panel = await getCustomPanel(interaction.guild!.id, panelId);
  if (!panel) throw new Error('Panel not found.');
  if (!panel.buttons.length) throw new Error('Add at least one button before publishing a panel.');
  const channels = [...(await interaction.guild!.channels.fetch()).values()]
    .filter((channel): channel is import('discord.js').TextChannel =>
      Boolean(channel && channel.type === 0 && channel.viewable && channel.permissionsFor(interaction.guild!.members.me!)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!channels.length) {
    throw new Error('No accessible text channels were found where ResolveX can view, send messages and embeds.');
  }
  const pageCount = Math.max(1, Math.ceil(channels.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = channels.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const components: PanelComponents = [
    selectRow(new StringSelectMenuBuilder()
      .setCustomId(PREFIX + 'channel:' + panelId)
      .setPlaceholder('Choose where to publish this panel')
      .addOptions(visible.map((channel) => ({
        label: channel.name.slice(0, 100),
        value: channel.id,
        description: 'Publish to #' + channel.name,
      })))),
  ];
  if (pageCount > 1) {
    components.push(row(
      makeButton(PREFIX + 'channels:' + panelId + ':' + (safePage - 1), 'Previous', ButtonStyle.Secondary, '⬅️', safePage === 0),
      makeButton(PREFIX + 'channels:' + panelId + ':' + (safePage + 1), 'Next', ButtonStyle.Secondary, '➡️', safePage >= pageCount - 1),
    ));
  }
  components.push(row(makeButton(PREFIX + 'detail:' + panelId, 'Cancel', ButtonStyle.Secondary, '↩️')));
  await render(
    interaction,
    'Publish Custom Panel',
    'Choose a text channel where ResolveX can view messages, post embeds and create buttons. After the new public message is saved, ResolveX attempts to remove the previous message.\n\n**Panel:** ' + panel.name + '\n**Available channels:** ' + channels.length + '\n**Page:** ' + (safePage + 1) + ' / ' + pageCount,
    components,
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
    if (interaction.isRoleSelectMenu() && id.startsWith(PREFIX + 'role-select-panel:')) {
      const panelId = id.slice((PREFIX + 'role-select-panel:').length);
      await setCustomPanelRoleAccess(guild.id, panelId, interaction.values);
      await audit(interaction, 'CUSTOM_PANEL_ACCESS_UPDATED', 'Updated published-panel draft access rules for panel ' + panelId + '.');
      await showPanel(interaction, panelId);
      return true;
    }
    if (interaction.isRoleSelectMenu() && id.startsWith(PREFIX + 'role-select-button:')) {
      const parts = id.split(':');
      const panelId = parts[4] ?? '';
      const buttonId = parts[5] ?? '';
      await setCustomPanelRoleAccess(guild.id, panelId, interaction.values, buttonId);
      await audit(interaction, 'CUSTOM_PANEL_BUTTON_ACCESS_UPDATED', 'Updated button role access rules for ' + buttonId + ' on panel ' + panelId + '.');
      await showButtonDetail(interaction, panelId, buttonId);
      return true;
    }
    if (interaction.isButton() && id === PREFIX + 'create') {
      await interaction.showModal(createPanelModal());
      return true;
    }
    if (interaction.isButton() && id === PREFIX + 'home') {
      await showHome(interaction);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'list:')) {
      const page = Number(id.slice((PREFIX + 'list:').length));
      await showHome(interaction, Number.isInteger(page) ? page : 0);
      return true;
    }
    if (interaction.isStringSelectMenu() && id.startsWith(PREFIX + 'select:')) {
      await showPanel(interaction, interaction.values[0] ?? '');
      return true;
    }
    if (interaction.isStringSelectMenu() && id.startsWith(PREFIX + 'button-select:')) {
      const panelId = id.slice((PREFIX + 'button-select:').length);
      await showButtonDetail(interaction, panelId, interaction.values[0] ?? '');
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'detail:')) {
      await showPanel(interaction, id.slice((PREFIX + 'detail:').length));
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'buttons:')) {
      await showButtonManager(interaction, id.slice((PREFIX + 'buttons:').length));
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'preview:')) {
      const panelId = id.slice((PREFIX + 'preview:').length);
      const panel = await getCustomPanel(guild.id, panelId);
      if (!panel) throw new Error('Panel not found.');
      const theme = await getGuildTheme(guild.id);
      const embed = buildCustomPanelEmbed(panel, guild.name, theme.color, true);
      const previewRows = buildCustomPanelComponents(panel, true);
      // Reserve one row for navigation. Discord permits five action rows per message.
      const visiblePreviewRows = previewRows.slice(0, 4);
      const previewNote = panel.buttons.length > 20
        ? 'Private draft preview. First 20 buttons are shown so navigation fits within Discord’s five-row limit; publishing includes all ' + panel.buttons.length + ' buttons.'
        : 'Private draft preview. Ticket buttons are disabled here and only become active after publishing.';
      await render(interaction, panel.name + ' • Live Preview', previewNote, [
        ...visiblePreviewRows,
        row(makeButton(PREFIX + 'detail:' + panel.id, 'Back to Panel Details', ButtonStyle.Secondary, '↩️')),
      ], [embed]);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'update:')) {
      const panelId = id.slice((PREFIX + 'update:').length);
      const panel = await getCustomPanel(guild.id, panelId);
      if (!panel) throw new Error('Panel not found.');
      await interaction.showModal(updatePanelModal(panelId, panel));
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'appearance:')) {
      const panelId = id.slice((PREFIX + 'appearance:').length);
      const panel = await getCustomPanel(guild.id, panelId);
      if (!panel) throw new Error('Panel not found.');
      await interaction.showModal(appearancePanelModal(panel));
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'access:')) {
      await showPanelAccess(interaction, id.slice((PREFIX + 'access:').length));
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'access-button:')) {
      const parts = id.split(':');
      await showPanelAccess(interaction, parts[4] ?? '', parts[5] ?? '');
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'access-clear:')) {
      const parts = id.split(':');
      const panelId = parts[4] ?? '';
      const buttonId = parts[5];
      await setCustomPanelRoleAccess(guild.id, panelId, [], buttonId);
      await audit(interaction, 'CUSTOM_PANEL_ACCESS_CLEARED', 'Cleared role restrictions on ' + (buttonId ? 'button ' + buttonId : 'panel') + ' in panel ' + panelId + '.');
      if (buttonId) await showButtonDetail(interaction, panelId, buttonId);
      else await showPanel(interaction, panelId);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'add-department:')) {
      const parts = id.split(':');
      await showDepartmentPicker(interaction, parts[4] ?? '', Number(parts[5] ?? '0'));
      return true;
    }
    if (interaction.isStringSelectMenu() && id.startsWith(PREFIX + 'department-pick:')) {
      const parts = id.split(':');
      const panelId = parts[4] ?? '';
      const departmentId = interaction.values[0] ?? '';
      const department = (await getGuildConfig(guild.id)).departments[departmentId];
      if (!department) throw new Error('That department no longer exists. Refresh and try again.');
      await interaction.showModal(addDepartmentButtonModal(panelId, department.id, department.name));
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'add-form:')) {
      const parts = id.split(':');
      await showFormPicker(interaction, parts[4] ?? '', Number(parts[5] ?? '0'));
      return true;
    }
    if (interaction.isStringSelectMenu() && id.startsWith(PREFIX + 'form-pick:')) {
      const parts = id.split(':');
      const panelId = parts[4] ?? '';
      const formId = interaction.values[0] ?? '';
      await showFormTagPicker(interaction, panelId, formId);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'form-tag-page:')) {
      const parts = id.split(':');
      await showFormTagPicker(interaction, parts[4] ?? '', parts[5] ?? '', Number(parts[6] ?? '0'));
      return true;
    }
    if (interaction.isStringSelectMenu() && id.startsWith(PREFIX + 'form-tag-pick:')) {
      const parts = id.split(':');
      const panelId = parts[4] ?? '';
      const formId = parts[5] ?? '';
      const tagId = interaction.values[0] ?? '';
      const form = (await listTicketForms(guild.id)).find((candidate) => candidate.id === formId && candidate.active);
      if (!form) throw new Error('The selected form is no longer active.');
      await interaction.showModal(addFormButtonModal(panelId, formId, tagId, form.name));
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'edit-button:')) {
      const parts = id.split(':');
      const panelId = parts[4] ?? '';
      const buttonId = parts[5] ?? '';
      const panel = await getCustomPanel(guild.id, panelId);
      const button = panel?.buttons.find((candidate) => candidate.id === buttonId);
      if (!button) throw new Error('Button not found.');
      await interaction.showModal(editButtonModal(panelId, button));
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'move-up:')) {
      const parts = id.split(':');
      const panelId = parts[4] ?? '';
      const buttonId = parts[5] ?? '';
      await moveCustomPanelButton(guild.id, panelId, buttonId, 'up');
      await showButtonDetail(interaction, panelId, buttonId);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'move-down:')) {
      const parts = id.split(':');
      const panelId = parts[4] ?? '';
      const buttonId = parts[5] ?? '';
      await moveCustomPanelButton(guild.id, panelId, buttonId, 'down');
      await showButtonDetail(interaction, panelId, buttonId);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'delete-button:')) {
      const parts = id.split(':');
      const panelId = parts[4] ?? '';
      const buttonId = parts[5] ?? '';
      const panel = await getCustomPanel(guild.id, panelId);
      const button = panel?.buttons.find((candidate) => candidate.id === buttonId);
      if (!button) throw new Error('Button not found.');
      await render(interaction, 'Confirm Button Removal', 'Remove **' + button.label + '** from the draft? The currently published panel will continue to show the old button until you publish the updated draft.', [
        row(makeButton(PREFIX + 'delete-button-confirm:' + panelId + ':' + buttonId, 'Confirm Remove', ButtonStyle.Danger, '🗑️'), makeButton(PREFIX + 'button:' + panelId + ':' + buttonId, 'Cancel', ButtonStyle.Secondary, '↩️')),
      ]);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'delete-button-confirm:')) {
      const parts = id.split(':');
      const panelId = parts[4] ?? '';
      const buttonId = parts[5] ?? '';
      const removed = await deleteCustomPanelButton(guild.id, panelId, buttonId);
      await audit(interaction, 'CUSTOM_PANEL_BUTTON_REMOVED', 'Removed button "' + removed.label + '" (' + buttonId + ') from panel ' + panelId + ' draft.');
      await showButtonManager(interaction, panelId);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'button:')) {
      const parts = id.split(':');
      await showButtonDetail(interaction, parts[4] ?? '', parts[5] ?? '');
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'publish:')) {
      await showPublishChannelPicker(interaction, id.slice((PREFIX + 'publish:').length), 0);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'channels:')) {
      const parts = id.split(':');
      await showPublishChannelPicker(interaction, parts[4] ?? '', Number(parts[5] ?? '0'));
      return true;
    }
    if (interaction.isStringSelectMenu() && id.startsWith(PREFIX + 'channel:')) {
      const panelId = id.slice((PREFIX + 'channel:').length);
      const targetChannelId = interaction.values[0];
      if (!targetChannelId) throw new Error('Choose a channel first.');
      const panel = await getCustomPanel(guild.id, panelId);
      if (!panel) throw new Error('Panel not found.');
      if (panel.buttons.length < 1) throw new Error('Add at least one button before publishing a panel.');
      const target = await guild.channels.fetch(targetChannelId);
      if (target?.type !== 0) throw new Error('Publish target must be a standard text channel.');
      const theme = await getGuildTheme(guild.id);
      const payload = {
        embeds: [buildCustomPanelEmbed(panel, guild.name, theme.color)],
        components: buildCustomPanelComponents(panel, false),
      };
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
      const updated = await markCustomPanelPublished(guild.id, panelId, target.id, message.id);
      let cleanupWarning = '';
      if (oldChannelId && oldMessageId && (oldChannelId !== target.id || oldMessageId !== message.id)) {
        try {
          const oldChannel = await guild.channels.fetch(oldChannelId).catch((error) => {
            if (resourceCode(error) === 10003) return null;
            throw error;
          });
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
      await audit(interaction, 'CUSTOM_PANEL_PUBLISHED', 'Published panel "' + updated.name + '" (' + updated.id + ') to channel ' + target.id + ' with ' + updated.buttons.length + ' button(s).');
      await render(interaction, 'Panel Published', '**' + updated.name + '** is now live in <#' + target.id + '>.\n\nIts buttons use the normal validated ticket pipeline, including pinned forms, confirmation prompts and role checks. Existing tickets are not affected.' + cleanupWarning, [
        row(makeButton(PREFIX + 'detail:' + panelId, 'Panel Details', ButtonStyle.Primary, '🎛️'), makeButton(PREFIX + 'home', 'Panel List', ButtonStyle.Secondary, '📋')),
      ]);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'delete:')) {
      const panelId = id.slice((PREFIX + 'delete:').length);
      const panel = await getCustomPanel(guild.id, panelId);
      if (!panel) throw new Error('Panel not found.');
      await render(interaction, 'Confirm Panel Deletion', 'Delete **' + panel.name + '** (' + panel.id + ')? This removes only the saved panel and its known published message. Tickets created from it are preserved.', [
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
      const deleted = await deleteCustomPanelDefinition(guild.id, panelId);
      await audit(interaction, 'CUSTOM_PANEL_DELETED', 'Deleted panel "' + deleted.name + '" (' + deleted.id + '); existing tickets were preserved.');
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
        buttons: [],
      });
      await audit(interaction, 'CUSTOM_PANEL_CREATED', 'Created draft panel "' + panel.name + '" (' + panel.id + ').');
      await render(interaction, 'Panel Draft Created', '**' + panel.name + '** was saved to Neon.\nPanel ID: `' + panel.id + '`\n\nNext, add one or more department/form buttons, preview the draft and publish it when ready.', [
        row(makeButton(PREFIX + 'buttons:' + panel.id, 'Build Buttons', ButtonStyle.Primary, '🧩'), makeButton(PREFIX + 'detail:' + panel.id, 'Panel Details', ButtonStyle.Secondary, '🎛️')),
      ]);
      return true;
    }
    if (interaction.isModalSubmit() && id.startsWith(PREFIX + 'modal:update:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const panelId = id.slice((PREFIX + 'modal:update:').length);
      const updated = await updateCustomPanel(guild.id, panelId, {
        name: interaction.fields.getTextInputValue('name'),
        title: interaction.fields.getTextInputValue('title'),
        description: interaction.fields.getTextInputValue('description'),
      });
      await audit(interaction, 'CUSTOM_PANEL_UPDATED', 'Updated draft panel "' + updated.name + '" (' + updated.id + ').');
      await render(interaction, 'Panel Draft Updated', '**' + updated.name + '** has been saved. The published message remains unchanged until you publish again.', [
        row(makeButton(PREFIX + 'preview:' + updated.id, 'Preview Draft', ButtonStyle.Primary, '👁️'), makeButton(PREFIX + 'detail:' + updated.id, 'Panel Details', ButtonStyle.Secondary, '🎛️')),
      ]);
      return true;
    }
    if (interaction.isModalSubmit() && id.startsWith(PREFIX + 'modal:appearance:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const panelId = id.slice((PREFIX + 'modal:appearance:').length);
      const optional = (fieldId: string): string | undefined => readOptionalModalText(interaction, fieldId);
      const nullable = (fieldId: string): string | null | undefined => {
        const value = optional(fieldId);
        if (value === undefined) return undefined;
        return value.toLowerCase() === 'none' ? null : value;
      };
      const footerValue = optional('footer');
      const updated = await updateCustomPanel(guild.id, panelId, {
        footer: footerValue === undefined ? undefined : (footerValue.toLowerCase() === 'none' ? '' : footerValue),
        color: nullable('color'),
        iconUrl: nullable('icon-url'),
        thumbnailUrl: nullable('thumbnail-url'),
        bannerUrl: nullable('banner-url'),
      });
      await audit(interaction, 'CUSTOM_PANEL_BRANDING_UPDATED', 'Updated branding for panel "' + updated.name + '" (' + updated.id + ').');
      await render(interaction, 'Panel Branding Updated', 'Saved branding for **' + updated.name + '**. The public message stays unchanged until you publish the panel again.', [
        row(makeButton(PREFIX + 'preview:' + updated.id, 'Preview Draft', ButtonStyle.Primary, '👁️'), makeButton(PREFIX + 'detail:' + updated.id, 'Panel Details', ButtonStyle.Secondary, '🎛️')),
      ]);
      return true;
    }
    if (interaction.isModalSubmit() && id.startsWith(PREFIX + 'modal:add-department:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const parts = id.split(':');
      const panelId = parts[5] ?? '';
      const departmentId = parts[6] ?? '';
      const tagInput = readOptionalModalText(interaction, 'tag-id');
      const tagId = !tagInput || tagInput === '*' ? null : tagInput;
      const confirmationInput = readOptionalModalText(interaction, 'confirmation');
      const button = await addCustomPanelButton(guild.id, panelId, {
        targetType: 'department',
        departmentId,
        tagId,
        label: interaction.fields.getTextInputValue('label'),
        emoji: readOptionalModalText(interaction, 'emoji') ?? null,
        style: parseStyle(interaction.fields.getTextInputValue('style')),
        confirmationMessage: confirmationInput?.toLowerCase() === 'none' ? null : (confirmationInput ?? null),
      });
      await audit(interaction, 'CUSTOM_PANEL_BUTTON_ADDED', 'Added department button "' + button.label + '" to panel ' + panelId + '.');
      await showButtonDetail(interaction, panelId, button.id);
      return true;
    }
    if (interaction.isModalSubmit() && id.startsWith(PREFIX + 'modal:add-form:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const parts = id.split(':');
      const panelId = parts[5] ?? '';
      const formId = parts[6] ?? '';
      const tagId = parts[7] ?? '';
      const confirmationInput = readOptionalModalText(interaction, 'confirmation');
      const button = await addCustomPanelButton(guild.id, panelId, {
        targetType: 'form',
        formId,
        tagId,
        label: interaction.fields.getTextInputValue('label'),
        emoji: readOptionalModalText(interaction, 'emoji') ?? null,
        style: parseStyle(interaction.fields.getTextInputValue('style')),
        confirmationMessage: confirmationInput?.toLowerCase() === 'none' ? null : (confirmationInput ?? null),
      });
      await audit(interaction, 'CUSTOM_PANEL_FORM_BUTTON_ADDED', 'Added form-target button "' + button.label + '" for form ' + formId + ' to panel ' + panelId + '.');
      await showButtonDetail(interaction, panelId, button.id);
      return true;
    }
    if (interaction.isModalSubmit() && id.startsWith(PREFIX + 'modal:edit-button:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const parts = id.split(':');
      const panelId = parts[5] ?? '';
      const buttonId = parts[6] ?? '';
      const emojiValue = readOptionalModalText(interaction, 'emoji');
      const confirmationValue = readOptionalModalText(interaction, 'confirmation');
      const button = await updateCustomPanelButton(guild.id, panelId, buttonId, {
        label: interaction.fields.getTextInputValue('label'),
        emoji: emojiValue?.toLowerCase() === 'none' ? null : (emojiValue ?? null),
        style: parseStyle(interaction.fields.getTextInputValue('style')),
        confirmationMessage: confirmationValue?.toLowerCase() === 'none' ? null : (confirmationValue ?? null),
      });
      await audit(interaction, 'CUSTOM_PANEL_BUTTON_UPDATED', 'Updated button "' + button.label + '" (' + buttonId + ') on panel ' + panelId + '.');
      await showButtonDetail(interaction, panelId, buttonId);
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
