import { translate } from './translationService';
import type { TranslationKey } from './locales/en-US';

const COPY_KEYS: Record<string, TranslationKey> = {
  'Ticket Forms & Templates': 'forms.settings.home.title',
  'Manage the same versioned forms available through /supportforge form commands. Both the slash commands and this Settings panel use the same validation and Neon PostgreSQL records.': 'forms.settings.home.description',
  '**Forms:** list, inspect details, view paginated schema JSON, read the field guide, create, version, activate, and deactivate.': 'forms.settings.home.forms',
  '**Templates:** save reusable schemas, list and inspect them, create forms from them, and delete templates without changing forms already created.': 'forms.settings.home.templates',
  'The Settings modal accepts up to 4,000 characters of field JSON. Use the slash command for longer schemas.': 'forms.settings.home.modalLimit',
  'Ticket Form Field Schema Guide': 'forms.settings.guide.title',
  'Paste a JSON array. Every field needs a unique lowercase id, a label, a supported type, and required set to true or false. Steps are normalized by the form service; each step can contain at most three custom fields.': 'forms.settings.guide.intro',
  'JSON example:': 'forms.settings.guide.jsonExample',
  '**Supported types:** short_text, long_text, number, decimal, url, email, date, dropdown, multi_select, checkbox, discord_user, discord_role, attachment.': 'forms.settings.guide.types',
  'Choice-based fields can include a choices string array. The service validates field IDs, types, choices, limits, conditions, and routing mappings before saving.': 'forms.settings.guide.choices',
  'Guided Form Builder · 1 of 3': 'forms.settings.builder.one.title',
  'Start with the department for this form. You will then choose a tag and add one or two questions. No JSON required.': 'forms.settings.builder.one.body',
  'Choose a department below.': 'forms.settings.builder.one.choose',
  'No departments are configured yet. Create one in Settings → Departments, then return here.': 'forms.settings.builder.one.none',
  'Only the first 25 departments are shown here. Use the advanced command for larger setups.': 'forms.settings.builder.one.limit',
  'Choose the department that receives these tickets': 'forms.settings.builder.one.placeholder',
  'Guided Form Builder · 2 of 3': 'forms.settings.builder.two.title',
  'Choose whether this form applies to all tags or one tag.': 'forms.settings.builder.two.body',
  'The guided builder creates simple text questions. Use Advanced Schema for dropdowns, attachments, conditional questions, and custom validation.': 'forms.settings.builder.two.help',
  'Choose a tag or all tags': 'forms.settings.builder.two.placeholder',
  'All tags in {name}': 'forms.settings.builder.two.allTags',
  'Use this form for every tag in the department.': 'forms.settings.builder.two.allTagsDescription',
  'Use this form only for this tag.': 'forms.settings.builder.two.tagDescription',
  'Guided Form Builder · 3 of 3': 'forms.settings.builder.three.title',
  'Add a form name and up to two questions. Subject and description are collected automatically. The new form starts inactive so you can review it before routing live tickets.': 'forms.settings.builder.three.body',
  'Ticket Forms · Page': 'forms.settings.list.title',
  'Select a form to update its schema or activate/deactivate it.': 'forms.settings.list.description',
  'No ticket forms are configured yet. Use **Create Form** to start.': 'forms.settings.list.empty',
  '**Current fields ({count}):**': 'forms.settings.detail.currentFields',
  'No fields configured.': 'forms.settings.detail.noFields',
  'Updating the schema creates a new immutable version. Earlier versions and historical submissions remain unchanged.': 'forms.settings.detail.updateNotice',
  '…and {count} more field(s).': 'forms.settings.detail.moreFields',
  'For long schemas, copy the JSON text from each page in order without the surrounding markers.': 'forms.settings.schema.longHint',
  'JSON:': 'forms.settings.schema.jsonLabel',
  'Form Templates · Page': 'forms.settings.templates.title',
  'Select a template to apply it to a department or delete the template. Forms already created from a template are independent.': 'forms.settings.templates.description',
  'No templates have been saved yet. Use **Save Template** to create one.': 'forms.settings.templates.empty',
  'No fields in this template.': 'forms.settings.template.noFields',
  'Applying creates a new inactive form with its own version history. Deleting this template will not alter created forms.': 'forms.settings.template.description',
  'Delete this saved template?': 'forms.settings.template.deleteTitle',
  'Only the reusable template will be deleted. Forms already created from it, their version history, and historical submissions will remain unchanged.': 'forms.settings.template.deleteDescription',
  'Department & Tag Routing IDs · Page': 'forms.settings.routing.title',
  'Use these exact IDs in a form mapping. For tag-id, use a tag ID from the same department or * for every tag in that department.': 'forms.settings.routing.description',
  'No departments are configured yet. Add a department and its tags in Settings first.': 'forms.settings.routing.noDepartments',
  'Could not complete that action': 'forms.settings.error.failureTitle',
  'Unknown error.': 'forms.settings.error.unknown',
  'ResolvX • Forms & Templates': 'forms.settings.embed.author',
  'Use the controls below to continue.': 'forms.settings.embed.continue',
  'List & Manage Forms': 'forms.settings.button.list',
  'Create Form': 'forms.settings.button.create',
  'Templates': 'forms.settings.button.templates',
  'Routing IDs': 'forms.settings.button.routing',
  'Settings': 'forms.settings.button.settings',
  'Guided Form Builder': 'forms.settings.button.guided',
  'Advanced Schema Guide': 'forms.settings.button.guide',
  'Back to Ticket Forms': 'forms.settings.button.backForms',
  'Return to Settings': 'forms.settings.button.returnSettings',
  'Choose a form to manage': 'forms.settings.button.chooseForm',
  'Choose a template to manage': 'forms.settings.button.chooseTemplate',
  'Advanced Schema': 'forms.settings.button.advancedSchema',
  'Guided Builder': 'forms.settings.button.guidedBuilder',
  'Previous': 'forms.settings.button.previous',
  'Next': 'forms.settings.button.next',
  'Back to Form': 'forms.settings.button.backToForm',
  'Update Schema': 'forms.settings.button.updateSchema',
  'View Schema JSON': 'forms.settings.button.viewSchema',
  'Activate': 'forms.settings.button.activate',
  'Deactivate': 'forms.settings.button.deactivate',
  'Back to Forms': 'forms.settings.button.backFormsShort',
  'Save Template': 'forms.settings.button.saveTemplate',
  'Forms Home': 'forms.settings.button.formsHome',
  'Apply Template': 'forms.settings.button.applyTemplate',
  'Delete Template': 'forms.settings.button.deleteTemplate',
  'Back to Templates': 'forms.settings.button.backTemplates',
  'Confirm Delete': 'forms.settings.button.confirmDelete',
  'Cancel': 'forms.settings.button.cancel',
  'Forms': 'forms.settings.button.forms',
  'Ticket Forms Home': 'forms.settings.button.backTicketFormsHome',
  'This form builder can only be used inside a server.': 'forms.settings.error.serverOnly',
  'This form can only be managed from a server.': 'forms.settings.error.serverOnly',
  'Only server administrators or members with Manage Server can manage ticket forms and templates.': 'forms.settings.error.adminOnly',
  'That department no longer exists. Start the guided builder again.': 'forms.settings.error.departmentMissing',
  'That tag no longer exists. Start the guided builder again.': 'forms.settings.error.tagMissing',
  'Ticket form not found in this server. Refresh the form list and try again.': 'forms.settings.error.formMissing',
  'Template not found in this server. Refresh the template list and try again.': 'forms.settings.error.templateMissing',
  'The guided builder route is invalid. Start again.': 'forms.settings.error.invalidBuilderRoute',
  'The guided form route is invalid. Start the builder again.': 'forms.settings.error.invalidGuidedRoute',
  'Unsupported Ticket Forms action.': 'forms.settings.error.unsupportedAction',
};

export function localizeFormSettingsText(locale: string, value: string): string {
  const boldOnly = value.match(/^\*\*(.{1,240}?)\*\*$/);
  if (boldOnly && COPY_KEYS[boldOnly[1]]) return '**' + translate(locale, COPY_KEYS[boldOnly[1]]) + '**';

  const exact = COPY_KEYS[value];
  if (exact) return translate(locale, exact);

  const pageTitle = value.match(/^\*\*Ticket Forms · Page (\d+) \/ (\d+)\*\*$/);
  if (pageTitle) return '**' + translate(locale, 'forms.settings.list.title', { page: pageTitle[1], pages: pageTitle[2] }) + '**';

  const templatePage = value.match(/^\*\*Form Templates · Page (\d+) \/ (\d+)\*\*$/);
  if (templatePage) return '**' + translate(locale, 'forms.settings.templates.title', { page: templatePage[1], pages: templatePage[2] }) + '**';

  const routingPage = value.match(/^\*\*Department & Tag Routing IDs · Page (\d+) \/ (\d+)\*\*$/);
  if (routingPage) return '**' + translate(locale, 'forms.settings.routing.title', { page: routingPage[1], pages: routingPage[2] }) + '**';

  const schemaPage = value.match(/^\*\*Current schema for (.+) · Page (\d+) \/ (\d+)\*\*$/);
  if (schemaPage) return '**' + translate(locale, 'forms.settings.schema.title', { name: schemaPage[1], page: schemaPage[2], pages: schemaPage[3] }) + '**';

  const guidedDepartment = value.match(/^Department: \*\*(.*)\*\*$/);
  if (guidedDepartment) return translate(locale, 'forms.settings.builder.two.department', { name: guidedDepartment[1] });

  const destination = value.match(/^Destination: \*\*(.*)\*\*$/);
  if (destination) return translate(locale, 'forms.settings.builder.three.destination', { department: destination[1] });

  const tag = value.match(/^Tag: \*\*(.*)\*\*$/);
  if (tag) return translate(locale, 'forms.settings.builder.three.tag', { tag: tag[1] });

  const template = value.match(/^\*\*Template: (.*)\*\*$/);
  if (template) return '**' + translate(locale, 'forms.settings.template.title', { name: template[1] }) + '**';

  const currentFields = value.match(/^\*\*Current fields \((\d+)\):\*\*$/);
  if (currentFields) return translate(locale, 'forms.settings.detail.currentFields', { count: currentFields[1] });

  const idLine = value.match(/^ID: (.+)$/);
  if (idLine) return translate(locale, 'forms.settings.detail.id', { id: idLine[1] });

  const versionStatus = value.match(/^Version: \*\*(\d+)\*\* · Status: \*\*(ACTIVE|Inactive)\*\*$/);
  if (versionStatus) {
    const status = versionStatus[2] === 'ACTIVE' ? translate(locale, 'forms.settings.detail.statusActive') : translate(locale, 'forms.settings.detail.statusInactive');
    return translate(locale, 'forms.settings.detail.versionStatus', { version: versionStatus[1], status });
  }

  const routing = value.match(/^Department ID: (.+) · Tag ID: (.+)$/);
  if (routing) return translate(locale, 'forms.settings.detail.routing', { department: routing[1], tag: routing[2] });

  const templateFields = value.match(/^Fields: \*\*(\d+)\*\*$/);
  if (templateFields) return translate(locale, 'forms.settings.template.fieldCount', { count: templateFields[1] });

  const formListItem = value.match(/^• \*\*(.*?)\*\* · (.+) · v(\d+) · \*\*(ACTIVE|inactive)\*\* · department (.+) · tag (.+) · (\d+) field\(s\)$/);
  if (formListItem) {
    const status = formListItem[4] === 'ACTIVE'
      ? translate(locale, 'forms.settings.detail.statusActive')
      : translate(locale, 'forms.settings.detail.statusInactive');
    return translate(locale, 'forms.settings.list.item', {
      name: formListItem[1], id: formListItem[2], version: formListItem[3],
      status, department: formListItem[5], tag: formListItem[6], count: formListItem[7],
    });
  }

  const formField = value.match(/^(\d+)\. \*\*(.*?)\*\* · (.+) · (.+) · (required|optional) · step (\d+)$/);
  if (formField) return translate(locale, 'forms.settings.detail.field', {
    index: formField[1], label: formField[2], id: formField[3], type: formField[4],
    status: translate(locale, formField[5] === 'required' ? 'forms.settings.detail.required' : 'forms.settings.detail.optional'),
    step: formField[6],
  });

  const templateListItem = value.match(/^• \*\*(.*?)\*\* · (.+) · (\d+) field\(s\)$/);
  if (templateListItem) return translate(locale, 'forms.settings.templates.item', {
    name: templateListItem[1], id: templateListItem[2], count: templateListItem[3],
  });

  const templateField = value.match(/^(\d+)\. \*\*(.*?)\*\* · (.+) · (.+)$/);
  if (templateField) return translate(locale, 'forms.settings.template.field', {
    index: templateField[1], label: templateField[2], id: templateField[3], type: templateField[4],
  });

  const genericPage = value.match(/^Page (\d+) \/ (\d+)$/);
  if (genericPage) return translate(locale, 'forms.settings.pageIndicator', { page: genericPage[1], pages: genericPage[2] });

  return value;
}

export function localizeFormSettingsMessage(locale: string, message: string): string {
  return message.split('\n').map((line) => localizeFormSettingsText(locale, line)).join('\n');
}
