import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Guild,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import { getGuildConfig } from '../services/configService';
import { logSettingsEvent } from '../services/auditLogService';
import {
  applyTicketFormTemplate,
  createTicketForm,
  createTicketFormTemplate,
  deleteTicketFormTemplate,
  listTicketFormTemplates,
  listTicketForms,
  parseTicketFormFields,
  setTicketFormActive,
  updateTicketFormFields,
} from '../services/ticketFormService';

type FormSettingsInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;
type ViewComponents = Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>>;

const PREFIX = 'sf:settings:forms:';
const PAGE_SIZE = 10;
const SCHEMA_PAGE_LENGTH = 1450;

function button(id: string, label: string, style = ButtonStyle.Secondary, emoji?: string, disabled = false): ButtonBuilder {
  const result = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  if (emoji) result.setEmoji(emoji);
  return result;
}

function buttonRow(...items: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...items);
}

function selectRow(menu: StringSelectMenuBuilder): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

async function prepare(interaction: FormSettingsInteraction): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  if (interaction.isButton() && interaction.message.flags.has(MessageFlags.Ephemeral)) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

async function render(interaction: FormSettingsInteraction, content: string, components: ViewComponents = []): Promise<void> {
  await interaction.editReply({ content, embeds: [], components });
}

async function showFailure(interaction: FormSettingsInteraction, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : 'Unknown error.';
  const components = [buttonRow(
    button(PREFIX + 'home', 'Ticket Forms Home', ButtonStyle.Primary, '🧾'),
    button('sf:settings:home', 'Return to Settings', ButtonStyle.Secondary, '↩️'),
  )];
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: '❌ ' + detail, embeds: [], components }).catch(() => undefined);
  } else {
    await interaction.reply({ content: '❌ ' + detail, components, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

function textInput(
  id: string,
  label: string,
  style: TextInputStyle,
  options: { placeholder?: string; maxLength?: number; value?: string } = {},
): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(true);
  if (options.placeholder) input.setPlaceholder(options.placeholder);
  if (options.maxLength !== undefined) input.setMaxLength(options.maxLength);
  if (options.value !== undefined) input.setValue(options.value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function schemaInput(): ActionRowBuilder<TextInputBuilder> {
  return textInput('fields-json', 'Fields JSON schema', TextInputStyle.Paragraph, {
    maxLength: 4000,
    placeholder: '[{"id":"order_id","label":"Order ID","type":"short_text","required":true}]',
  });
}

async function openCreateModal(interaction: ButtonInteraction): Promise<void> {
  await interaction.showModal(new ModalBuilder().setCustomId(PREFIX + 'modal:create').setTitle('Create Ticket Form').addComponents(
    textInput('name', 'Form name', TextInputStyle.Short, { maxLength: 80, placeholder: 'Order Support' }),
    textInput('department-id', 'Department ID', TextInputStyle.Short, { maxLength: 28, placeholder: 'Copy from Routing IDs' }),
    textInput('tag-id', 'Tag ID or * for all tags', TextInputStyle.Short, { maxLength: 28, placeholder: '* or a tag ID from Routing IDs' }),
    schemaInput(),
  ));
}

async function openUpdateModal(interaction: ButtonInteraction, formId: string): Promise<void> {
  await interaction.showModal(new ModalBuilder().setCustomId(PREFIX + 'modal:update:' + formId).setTitle('Create New Form Version').addComponents(
    schemaInput(),
  ));
}

async function openSaveTemplateModal(interaction: ButtonInteraction): Promise<void> {
  await interaction.showModal(new ModalBuilder().setCustomId(PREFIX + 'modal:template-save').setTitle('Save Form Template').addComponents(
    textInput('name', 'Template name', TextInputStyle.Short, { maxLength: 80, placeholder: 'Order Support Questions' }),
    schemaInput(),
  ));
}

async function openApplyTemplateModal(interaction: ButtonInteraction, templateId: string): Promise<void> {
  await interaction.showModal(new ModalBuilder().setCustomId(PREFIX + 'modal:template-apply:' + templateId).setTitle('Create Form From Template').addComponents(
    textInput('name', 'New form name', TextInputStyle.Short, { maxLength: 80, placeholder: 'Order Support' }),
    textInput('department-id', 'Department ID', TextInputStyle.Short, { maxLength: 28, placeholder: 'Copy from Routing IDs' }),
    textInput('tag-id', 'Tag ID or * for all tags', TextInputStyle.Short, { maxLength: 28, placeholder: '* or a tag ID from Routing IDs' }),
  ));
}

async function home(interaction: FormSettingsInteraction): Promise<void> {
  await render(interaction,
    '**🧾 Ticket Forms & Templates**\n\n' +
    'Manage the same versioned forms available through /supportforge form commands. Both the slash commands and this Settings panel use the same validation and Neon PostgreSQL records.\n\n' +
    '**Forms:** list, create, create a new immutable schema version, activate, and deactivate.\n' +
    '**Templates:** save reusable schemas, list them, create forms from them, and delete templates without changing forms already created.\n\n' +
    'The Settings modal accepts up to 4,000 characters of field JSON. Use the slash command for longer schemas.',
    [
      buttonRow(
        button(PREFIX + 'list:page:1', 'List & Manage Forms', ButtonStyle.Primary, '📋'),
        button(PREFIX + 'modal:create', 'Create Form', ButtonStyle.Success, '➕'),
        button(PREFIX + 'templates:page:1', 'Templates', ButtonStyle.Secondary, '🧩'),
        button(PREFIX + 'routing:page:1', 'Routing IDs', ButtonStyle.Secondary, '🪪'),
        button('sf:settings:home', 'Settings', ButtonStyle.Secondary, '↩️'),
      ),
      buttonRow(button(PREFIX + 'guide', 'Field Schema Guide', ButtonStyle.Secondary, '📘')),
    ],
  );
}

async function schemaGuide(interaction: FormSettingsInteraction): Promise<void> {
  await render(interaction,
    '**Ticket Form Field Schema Guide**\n\n' +
    'Paste a JSON array. Every field needs a unique lowercase id, a label, a supported type, and required set to true or false. Steps are normalized by the form service; each step can contain at most three custom fields.\n\n' +
    'JSON example:\n{\n  "fields": [\n    {\n      "id": "order_id",\n      "label": "Order ID",\n      "type": "short_text",\n      "required": true,\n      "placeholder": "Enter your order ID"\n    }\n  ]\n}\n\n' +
    '**Supported types:** short_text, long_text, number, decimal, url, email, date, dropdown, multi_select, checkbox, discord_user, discord_role, attachment.\n\n' +
    'Choice-based fields can include a choices string array. The service validates field IDs, types, choices, limits, conditions, and routing mappings before saving.',
    [buttonRow(
      button(PREFIX + 'home', 'Back to Ticket Forms', ButtonStyle.Primary, '↩️'),
      button('sf:settings:home', 'Return to Settings', ButtonStyle.Secondary, '⚙️'),
    )],
  );
}

function pageSlice<T>(items: T[], requestedPage: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), pages);
  return { items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), page, pages };
}

async function formsPage(interaction: FormSettingsInteraction, guildId: string, requestedPage: number, notice = ''): Promise<void> {
  const forms = await listTicketForms(guildId);
  const page = pageSlice(forms, requestedPage);
  const components: ViewComponents = [];
  if (page.items.length) {
    components.push(selectRow(new StringSelectMenuBuilder().setCustomId(PREFIX + 'pick-form').setPlaceholder('Choose a form to manage').addOptions(
      page.items.map((form) => ({
        label: form.name.slice(0, 100),
        value: form.id,
        description: ((form.active ? 'ACTIVE' : 'Inactive') + ' · v' + form.version + ' · ' + form.fields.length + ' field(s)').slice(0, 100),
      })),
    )));
  }

  const lines = page.items.map((form) =>
    '• **' + form.name + '** · ' + form.id + ' · v' + form.version + ' · ' +
    (form.active ? '**ACTIVE**' : 'inactive') + ' · department ' + form.departmentId + ' · tag ' +
    (form.tagId ?? '*') + ' · ' + form.fields.length + ' field(s)',
  );
  components.push(buttonRow(
    button(PREFIX + 'modal:create', 'Create Form', ButtonStyle.Success, '➕'),
    button(PREFIX + 'templates:page:1', 'Templates', ButtonStyle.Secondary, '🧩'),
    button(PREFIX + 'routing:page:1', 'Routing IDs', ButtonStyle.Secondary, '🪪'),
    button('sf:settings:home', 'Settings', ButtonStyle.Secondary, '↩️'),
  ));
  if (page.pages > 1) {
    components.push(buttonRow(
      button(PREFIX + 'list:page:' + (page.page - 1), 'Previous', ButtonStyle.Secondary, '◀️', page.page <= 1),
      button(PREFIX + 'list:page:' + (page.page + 1), 'Next', ButtonStyle.Secondary, '▶️', page.page >= page.pages),
    ));
  }

  await render(interaction,
    (notice ? notice + '\n\n' : '') + '**Ticket Forms · Page ' + page.page + ' / ' + page.pages + '**\n' +
    'Select a form to update its schema or activate/deactivate it.\n\n' +
    (lines.length ? lines.join('\n') : 'No ticket forms are configured yet. Use **Create Form** to start.'),
    components,
  );
}

async function formDetail(interaction: FormSettingsInteraction, guildId: string, formId: string, notice = ''): Promise<void> {
  const form = (await listTicketForms(guildId)).find((item) => item.id === formId);
  if (!form) throw new Error('Ticket form not found in this server. Refresh the form list and try again.');
  const fields = form.fields.slice(0, 12).map((field, index) =>
    (index + 1) + '. **' + field.label + '** · ' + field.id + ' · ' + field.type + ' · ' +
    (field.required ? 'required' : 'optional') + ' · step ' + field.step,
  );
  if (form.fields.length > 12) fields.push('…and ' + (form.fields.length - 12) + ' more field(s).');

  await render(interaction,
    (notice ? notice + '\n\n' : '') + '**' + form.name + '**\n' +
    'ID: ' + form.id + '\nVersion: **' + form.version + '** · Status: **' + (form.active ? 'ACTIVE' : 'Inactive') + '**\n' +
    'Department ID: ' + form.departmentId + ' · Tag ID: ' + (form.tagId ?? '*') + '\n\n' +
    '**Current fields (' + form.fields.length + '):**\n' + (fields.length ? fields.join('\n') : 'No fields configured.') +
    '\n\nUpdating the schema creates a new immutable version. Earlier versions and historical submissions remain unchanged.',
    [buttonRow(
      button(PREFIX + 'update:' + form.id, 'Update Schema', ButtonStyle.Primary, '✏️'),
      button(PREFIX + 'schema:' + form.id + ':page:1', 'View Schema JSON', ButtonStyle.Secondary, '🧾'),
      button(PREFIX + 'toggle:' + (form.active ? 'deactivate' : 'activate') + ':' + form.id,
        form.active ? 'Deactivate' : 'Activate',
        form.active ? ButtonStyle.Danger : ButtonStyle.Success,
        form.active ? '⏸️' : '▶️'),
      button(PREFIX + 'list:page:1', 'Back to Forms', ButtonStyle.Secondary, '↩️'),
    )],
  );
}

async function schemaPage(interaction: FormSettingsInteraction, guildId: string, formId: string, requestedPage: number): Promise<void> {
  const form = (await listTicketForms(guildId)).find((item) => item.id === formId);
  if (!form) throw new Error('Ticket form not found in this server.');
  const schema = JSON.stringify({ fields: form.fields }, null, 2);
  const pages = Math.max(1, Math.ceil(schema.length / SCHEMA_PAGE_LENGTH));
  const page = Math.min(Math.max(1, requestedPage), pages);
  const chunk = schema.slice((page - 1) * SCHEMA_PAGE_LENGTH, page * SCHEMA_PAGE_LENGTH);
  const nav: ButtonBuilder[] = [];
  if (pages > 1) {
    nav.push(button(PREFIX + 'schema:' + formId + ':page:' + (page - 1), 'Previous', ButtonStyle.Secondary, '◀️', page <= 1));
    nav.push(button(PREFIX + 'schema:' + formId + ':page:' + (page + 1), 'Next', ButtonStyle.Secondary, '▶️', page >= pages));
  }
  nav.push(button(PREFIX + 'form:' + formId, 'Back to Form', ButtonStyle.Primary, '↩️'));
  await render(interaction,
    '**Current schema for ' + form.name + ' · Page ' + page + ' / ' + pages + '**\n' +
    (pages > 1 ? 'For long schemas, copy the JSON text from each page in order without the surrounding markers.\n\n' : '') +
    'JSON:\n' + chunk,
    [buttonRow(...nav)],
  );
}

async function templatesPage(interaction: FormSettingsInteraction, guildId: string, requestedPage: number, notice = ''): Promise<void> {
  const templates = await listTicketFormTemplates(guildId);
  const page = pageSlice(templates, requestedPage);
  const components: ViewComponents = [];
  if (page.items.length) {
    components.push(selectRow(new StringSelectMenuBuilder().setCustomId(PREFIX + 'pick-template').setPlaceholder('Choose a template to manage').addOptions(
      page.items.map((template) => ({
        label: template.name.slice(0, 100),
        value: template.id,
        description: (template.fields.length + ' custom field(s)').slice(0, 100),
      })),
    )));
  }
  const lines = page.items.map((template) =>
    '• **' + template.name + '** · ' + template.id + ' · ' + template.fields.length + ' field(s)',
  );
  components.push(buttonRow(
    button(PREFIX + 'modal:template-save', 'Save Template', ButtonStyle.Success, '➕'),
    button(PREFIX + 'routing:page:1', 'Routing IDs', ButtonStyle.Secondary, '🪪'),
    button(PREFIX + 'home', 'Forms Home', ButtonStyle.Secondary, '↩️'),
    button('sf:settings:home', 'Settings', ButtonStyle.Secondary, '⚙️'),
  ));
  if (page.pages > 1) {
    components.push(buttonRow(
      button(PREFIX + 'templates:page:' + (page.page - 1), 'Previous', ButtonStyle.Secondary, '◀️', page.page <= 1),
      button(PREFIX + 'templates:page:' + (page.page + 1), 'Next', ButtonStyle.Secondary, '▶️', page.page >= page.pages),
    ));
  }
  await render(interaction,
    (notice ? notice + '\n\n' : '') + '**Form Templates · Page ' + page.page + ' / ' + page.pages + '**\n' +
    'Select a template to apply it to a department or delete the template. Forms already created from a template are independent.\n\n' +
    (lines.length ? lines.join('\n') : 'No templates have been saved yet. Use **Save Template** to create one.'),
    components,
  );
}

async function templateDetail(interaction: FormSettingsInteraction, guildId: string, templateId: string): Promise<void> {
  const template = (await listTicketFormTemplates(guildId)).find((item) => item.id === templateId);
  if (!template) throw new Error('Template not found in this server. Refresh the template list and try again.');
  const fields = template.fields.slice(0, 12).map((field, index) =>
    (index + 1) + '. **' + field.label + '** · ' + field.id + ' · ' + field.type,
  );
  if (template.fields.length > 12) fields.push('…and ' + (template.fields.length - 12) + ' more field(s).');
  await render(interaction,
    '**Template: ' + template.name + '**\nID: ' + template.id + '\nFields: **' + template.fields.length + '**\n\n' +
    (fields.length ? fields.join('\n') : 'No fields in this template.') +
    '\n\nApplying creates a new inactive form with its own version history. Deleting this template will not alter created forms.',
    [buttonRow(
      button(PREFIX + 'template:apply:' + template.id, 'Apply Template', ButtonStyle.Success, '🧩'),
      button(PREFIX + 'template:delete:' + template.id, 'Delete Template', ButtonStyle.Danger, '🗑️'),
      button(PREFIX + 'templates:page:1', 'Back to Templates', ButtonStyle.Secondary, '↩️'),
    )],
  );
}

async function confirmTemplateDelete(interaction: FormSettingsInteraction, templateId: string): Promise<void> {
  await render(interaction,
    '**Delete this saved template?**\n\nOnly the reusable template will be deleted. Forms already created from it, their version history, and historical submissions will remain unchanged.',
    [buttonRow(
      button(PREFIX + 'template-delete-confirm:' + templateId, 'Confirm Delete', ButtonStyle.Danger, '🗑️'),
      button(PREFIX + 'template:' + templateId, 'Cancel', ButtonStyle.Secondary, '↩️'),
    )],
  );
}

async function routingPage(interaction: FormSettingsInteraction, guildId: string, requestedPage: number): Promise<void> {
  const config = await getGuildConfig(guildId);
  const items = Object.values(config.departments).flatMap((department) => [
    { label: 'Department: ' + department.name, id: department.id, detail: 'Department ID' },
    ...Object.values(department.tags ?? {}).map((tag) => ({
      label: department.name + ' · ' + tag.name,
      id: tag.id,
      detail: 'Tag ID · department ' + department.id,
    })),
  ]);
  const page = pageSlice(items, requestedPage);
  const lines = page.items.map((item) => '• **' + item.label + '**\n  ' + item.detail + ': ' + item.id);
  const components: ViewComponents = [];
  if (page.pages > 1) {
    components.push(buttonRow(
      button(PREFIX + 'routing:page:' + (page.page - 1), 'Previous', ButtonStyle.Secondary, '◀️', page.page <= 1),
      button(PREFIX + 'routing:page:' + (page.page + 1), 'Next', ButtonStyle.Secondary, '▶️', page.page >= page.pages),
    ));
  }
  components.push(buttonRow(
    button(PREFIX + 'list:page:1', 'Forms', ButtonStyle.Primary, '📋'),
    button(PREFIX + 'templates:page:1', 'Templates', ButtonStyle.Secondary, '🧩'),
    button(PREFIX + 'home', 'Forms Home', ButtonStyle.Secondary, '↩️'),
    button('sf:settings:home', 'Settings', ButtonStyle.Secondary, '⚙️'),
  ));
  await render(interaction,
    '**Department & Tag Routing IDs · Page ' + page.page + ' / ' + page.pages + '**\n' +
    'Use these exact IDs in a form mapping. For tag-id, use a tag ID from the same department or * for every tag in that department.\n\n' +
    (lines.length ? lines.join('\n') : 'No departments are configured yet. Add a department and its tags in Settings first.'),
    components,
  );
}

function auditFormAction(guild: Guild, actorId: string, actorName: string, action: string, detail: string): void {
  void getGuildConfig(guild.id).then((config) => {
    if (!config.supportCategoryId) return;
    return logSettingsEvent(guild, config.supportCategoryId, { action, actorId, actorName, detail });
  }).catch((error) => console.warn('Ticket form Settings audit logging failed:', error));
}

async function submitModal(interaction: ModalSubmitInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new Error('This form can only be managed from a server.');
  const actorId = interaction.user.id;
  const actorName = interaction.user.tag;
  const id = interaction.customId;

  if (id === PREFIX + 'modal:create') {
    const name = interaction.fields.getTextInputValue('name').trim();
    const departmentId = interaction.fields.getTextInputValue('department-id').trim();
    const suppliedTagId = interaction.fields.getTextInputValue('tag-id').trim();
    const tagId = suppliedTagId === '*' ? null : suppliedTagId;
    const form = await createTicketForm({
      guildId: guild.id, name, departmentId, tagId,
      fields: parseTicketFormFields(interaction.fields.getTextInputValue('fields-json')), actorId,
    });
    auditFormAction(guild, actorId, actorName, 'TICKET_FORM_CREATED',
      'Created form ' + form.id + ' version 1 for department ' + departmentId + ' and tag ' + (tagId ?? '*') + '.');
    await formsPage(interaction, guild.id, 1, '✅ Created inactive form ' + form.name + ' · ID ' + form.id + ' · version 1.');
    return;
  }

  if (id === PREFIX + 'modal:template-save') {
    const template = await createTicketFormTemplate({
      guildId: guild.id,
      name: interaction.fields.getTextInputValue('name').trim(),
      fields: parseTicketFormFields(interaction.fields.getTextInputValue('fields-json')),
      actorId,
    });
    auditFormAction(guild, actorId, actorName, 'TICKET_FORM_TEMPLATE_SAVED',
      'Saved template ' + template.id + ' with ' + template.fields.length + ' field(s).');
    await templatesPage(interaction, guild.id, 1, '✅ Saved template ' + template.name + ' · ID ' + template.id + '.');
    return;
  }

  if (id.startsWith(PREFIX + 'modal:update:')) {
    const formId = id.slice((PREFIX + 'modal:update:').length);
    const form = await updateTicketFormFields({
      guildId: guild.id, formId,
      fields: parseTicketFormFields(interaction.fields.getTextInputValue('fields-json')),
      actorId,
    });
    auditFormAction(guild, actorId, actorName, 'TICKET_FORM_VERSION_CREATED',
      'Created version ' + form.version + ' of form ' + form.id + '.');
    await formDetail(interaction, guild.id, form.id, '✅ Created immutable version ' + form.version + '.');
    return;
  }

  if (id.startsWith(PREFIX + 'modal:template-apply:')) {
    const templateId = id.slice((PREFIX + 'modal:template-apply:').length);
    const name = interaction.fields.getTextInputValue('name').trim();
    const departmentId = interaction.fields.getTextInputValue('department-id').trim();
    const suppliedTagId = interaction.fields.getTextInputValue('tag-id').trim();
    const tagId = suppliedTagId === '*' ? null : suppliedTagId;
    const form = await applyTicketFormTemplate({
      guildId: guild.id, templateId, name, departmentId, tagId, actorId,
    });
    auditFormAction(guild, actorId, actorName, 'TICKET_FORM_TEMPLATE_APPLIED',
      'Applied template ' + templateId + ' to form ' + form.id + '.');
    await formsPage(interaction, guild.id, 1,
      '✅ Created inactive form ' + form.name + ' from template ' + templateId + ' · new form ID ' + form.id + '.');
    return;
  }

  throw new Error('Unsupported ticket form modal action.');
}

export async function handleTicketFormSettingsInteraction(interaction: FormSettingsInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(PREFIX)) return false;
  const guild = interaction.guild;
  if (!guild) return true;

  try {
    const id = interaction.customId;

    // A modal must be opened before acknowledging its button interaction.
    if (interaction.isButton() && id === PREFIX + 'modal:create') {
      await openCreateModal(interaction);
      return true;
    }
    if (interaction.isButton() && id === PREFIX + 'modal:template-save') {
      await openSaveTemplateModal(interaction);
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'update:')) {
      await openUpdateModal(interaction, id.slice((PREFIX + 'update:').length));
      return true;
    }
    if (interaction.isButton() && id.startsWith(PREFIX + 'template:apply:')) {
      await openApplyTemplateModal(interaction, id.slice((PREFIX + 'template:apply:').length));
      return true;
    }

    if (interaction.isModalSubmit()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await submitModal(interaction);
      return true;
    }

    await prepare(interaction);
    const guildId = guild.id;

    if (interaction.isStringSelectMenu()) {
      if (id === PREFIX + 'pick-form') {
        await formDetail(interaction, guildId, interaction.values[0]);
        return true;
      }
      if (id === PREFIX + 'pick-template') {
        await templateDetail(interaction, guildId, interaction.values[0]);
        return true;
      }
      throw new Error('Unsupported ticket form selection.');
    }

    if (!interaction.isButton()) return true;

    if (id === PREFIX + 'home') {
      await home(interaction);
      return true;
    }
    if (id === PREFIX + 'guide') {
      await schemaGuide(interaction);
      return true;
    }
    if (id.startsWith(PREFIX + 'list:page:')) {
      const page = Number(id.slice((PREFIX + 'list:page:').length));
      await formsPage(interaction, guildId, Number.isFinite(page) ? page : 1);
      return true;
    }
    if (id.startsWith(PREFIX + 'templates:page:')) {
      const page = Number(id.slice((PREFIX + 'templates:page:').length));
      await templatesPage(interaction, guildId, Number.isFinite(page) ? page : 1);
      return true;
    }
    if (id.startsWith(PREFIX + 'routing:page:')) {
      const page = Number(id.slice((PREFIX + 'routing:page:').length));
      await routingPage(interaction, guildId, Number.isFinite(page) ? page : 1);
      return true;
    }
    if (id.startsWith(PREFIX + 'toggle:')) {
      const parts = id.slice((PREFIX + 'toggle:').length).split(':');
      const action = parts[0];
      const formId = parts.slice(1).join(':');
      if (action !== 'activate' && action !== 'deactivate') throw new Error('Unsupported form status action.');
      const form = await setTicketFormActive({ guildId, formId, active: action === 'activate' });
      auditFormAction(guild, interaction.user.id, interaction.user.tag,
        action === 'activate' ? 'TICKET_FORM_ACTIVATED' : 'TICKET_FORM_DEACTIVATED',
        (action === 'activate' ? 'Activated' : 'Deactivated') + ' form ' + form.id + ' version ' + form.currentVersion + '.');
      await formDetail(interaction, guildId, form.id,
        (action === 'activate' ? '✅ Activated ' : '✅ Deactivated ') + form.name + '.');
      return true;
    }
    if (id.startsWith(PREFIX + 'schema:')) {
      const rest = id.slice((PREFIX + 'schema:').length);
      const separator = rest.lastIndexOf(':page:');
      if (separator < 0) throw new Error('Invalid schema page.');
      const formId = rest.slice(0, separator);
      const page = Number(rest.slice(separator + ':page:'.length));
      await schemaPage(interaction, guildId, formId, Number.isFinite(page) ? page : 1);
      return true;
    }
    if (id.startsWith(PREFIX + 'form:')) {
      await formDetail(interaction, guildId, id.slice((PREFIX + 'form:').length));
      return true;
    }
    if (id.startsWith(PREFIX + 'template:delete:')) {
      await confirmTemplateDelete(interaction, id.slice((PREFIX + 'template:delete:').length));
      return true;
    }
    if (id.startsWith(PREFIX + 'template-delete-confirm:')) {
      const templateId = id.slice((PREFIX + 'template-delete-confirm:').length);
      await deleteTicketFormTemplate(guildId, templateId);
      auditFormAction(interaction.guild, interaction.user.id, interaction.user.tag,
        'TICKET_FORM_TEMPLATE_DELETED', 'Deleted template ' + templateId + '.');
      await templatesPage(interaction, guildId, 1,
        '✅ Deleted template ' + templateId + '. Existing forms and historical submissions are unchanged.');
      return true;
    }
    if (id.startsWith(PREFIX + 'template:')) {
      await templateDetail(interaction, guildId, id.slice((PREFIX + 'template:').length));
      return true;
    }

    throw new Error('Unsupported Ticket Forms action.');
  } catch (error) {
    await showFailure(interaction, error);
    return true;
  }
}
