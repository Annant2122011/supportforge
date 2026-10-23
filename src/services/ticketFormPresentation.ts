export interface TicketFormHomeMetrics {
  totalForms: number;
  activeForms: number;
  totalTemplates: number;
  departmentCount: number;
  tagCount: number;
}

export interface TicketFormHomeField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface TicketFormHomePresentation {
  description: string;
  fields: TicketFormHomeField[];
}

function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Build the compact summary used by the Forms & Templates Settings dashboard. */
export function buildTicketFormHomePresentation(metrics: TicketFormHomeMetrics): TicketFormHomePresentation {
  const totalForms = safeCount(metrics.totalForms);
  const activeForms = Math.min(totalForms, safeCount(metrics.activeForms));
  const totalTemplates = safeCount(metrics.totalTemplates);
  const departmentCount = safeCount(metrics.departmentCount);
  const tagCount = safeCount(metrics.tagCount);

  return {
    description: [
      'Create forms for the information your support team needs. Use the guided builder for straightforward questions, or Advanced Schema for dropdowns, conditional fields, attachment rules, and custom validation.',
      '',
      '**Suggested workflow**',
      '1. Build the questions and choose department/tag routing.',
      '2. Review the schema and routing IDs.',
      '3. Activate the form only after you have checked it.',
      '',
      'New forms start inactive. Schema edits create a new version, preserving earlier definitions and historical submissions. Settings modals accept up to 4,000 characters of JSON; the slash command supports longer schemas.',
    ].join('\n'),
    fields: [
      { name: 'FORMS', value: '**' + totalForms + '** saved\n' + activeForms + ' active', inline: true },
      { name: 'TEMPLATES', value: '**' + totalTemplates + '** reusable schemas', inline: true },
      { name: 'ROUTING', value: '**' + departmentCount + '** departments\n' + tagCount + ' tags', inline: true },
    ],
  };
}

/** Keep large JSON schemas legible and protect Markdown fences in user-authored text. */
export function formatTicketFormSchemaPageDescription(input: { formName: string; page: number; pages: number; chunk: string }): string {
  const pages = Math.max(1, safeCount(input.pages));
  const page = Math.min(Math.max(1, safeCount(input.page)), pages);
  const backtick = String.fromCharCode(96);
  const fence = backtick.repeat(input.chunk.includes(backtick.repeat(3)) ? 4 : 3);
  const notice = pages > 1
    ? 'Multi-page schema: copy each page’s code content in order, remove the code fences, then join the fragments.\n\n'
    : 'Copy this JSON when editing the schema.\n\n';

  return '**Current schema for ' + input.formName.slice(0, 180) + ' · Page ' + page + ' / ' + pages + '**\n' +
    notice + fence + 'json\n' + input.chunk + '\n' + fence;
}
