import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { initializePersistence } from '../core/persistence/provider';
import { getGuildConfig } from './configService';

export const MAX_TICKET_FORM_FIELDS = 3;
export const TICKET_FORM_MODAL_TTL_MS = 15 * 60_000;

export const TICKET_FORM_FIELD_TYPES = [
  'short_text',
  'long_text',
  'number',
  'decimal',
  'url',
  'email',
  'date',
  'dropdown',
  'multi_select',
  'checkbox',
  'discord_user',
  'discord_role',
  'attachment',
] as const;

export type TicketFormFieldType = (typeof TICKET_FORM_FIELD_TYPES)[number];

export interface TicketFormField {
  id: string;
  label: string;
  type: TicketFormFieldType;
  required: boolean;
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  choices?: string[];
  pattern?: string;
  maxBytes?: number;
  allowedMimeTypes?: string[];
}

export interface TicketFormSchema {
  fields: TicketFormField[];
}

export interface TicketForm {
  id: string;
  guildId: string;
  name: string;
  departmentId: string;
  tagId: string | null;
  currentVersion: number;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketFormVersion extends TicketForm {
  version: number;
  fields: TicketFormField[];
  snapshot: {
    id: string;
    name: string;
    departmentId: string;
    tagId: string | null;
    version: number;
    fields: TicketFormField[];
  };
}

interface TicketFormRow extends QueryResultRow {
  id: string;
  guild_id: string;
  name: string;
  department_id: string;
  tag_id: string | null;
  current_version: number;
  active: boolean;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  version?: number;
  schema?: unknown;
  snapshot?: unknown;
}

interface SubmissionRow extends QueryResultRow {
  interaction_id: string;
  guild_id: string;
  form_id: string;
  form_version: number;
  submitted_by: string;
  answers: unknown;
  ticket_id: string | null;
  channel_id: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToForm(row: TicketFormRow): TicketForm {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    departmentId: row.department_id,
    tagId: row.tag_id,
    currentVersion: Number(row.current_version),
    active: row.active,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function readSchema(value: unknown): TicketFormSchema {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error('The stored ticket form schema is malformed.', { cause: error });
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The stored ticket form schema must be an object.');
  }
  const record = raw as Record<string, unknown>;
  const fields = record.fields;
  if (!Array.isArray(fields)) {
    throw new Error('The stored ticket form schema is missing its fields array.');
  }
  return { fields: fields as TicketFormField[] };
}

function fieldType(value: unknown): value is TicketFormFieldType {
  return typeof value === 'string' &&
    (TICKET_FORM_FIELD_TYPES as readonly string[]).includes(value);
}

function rejectUnsafePattern(pattern: string): void {
  if (pattern.length > 128) {
    throw new Error('A field pattern cannot exceed 128 characters.');
  }
  // User-defined expressions run on the bot event loop. Reject common nested
  // repetition patterns that can cause catastrophic backtracking.
  if (
    /\([^)]*[+*{][^)]*\)[+*{]/.test(pattern) ||
    /(?:\.\*|\.\+){2}/.test(pattern) ||
    /\\[1-9]/.test(pattern)
  ) {
    throw new Error('That pattern uses unsupported or potentially unsafe repetition.');
  }
  try {
    new RegExp(pattern);
  } catch {
    throw new Error('The field pattern is not a valid regular expression.');
  }
}

/**
 * Parse and normalize the JSON configuration used by /supportforge form.
 * The two built-in ticket fields plus at most three custom fields fit Discord's
 * five-input modal limit. All client input is validated again on submission.
 */
export function parseTicketFormFields(input: string | unknown): TicketFormField[] {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input) as unknown;
    } catch (error) {
      throw new Error('Fields must be valid JSON. Supply a JSON array of field objects.', { cause: error });
    }
  }

  const candidate =
    Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).fields)
        ? (raw as Record<string, unknown>).fields
        : null;

  if (!candidate) {
    throw new Error('Fields must be a JSON array, or an object containing a fields array.');
  }
  if (candidate.length < 1 || candidate.length > MAX_TICKET_FORM_FIELDS) {
    throw new Error('A ticket form must contain between 1 and ' + MAX_TICKET_FORM_FIELDS + ' custom fields. Discord allows five modal inputs total, including Subject and Description.');
  }

  const seen = new Set<string>();
  return candidate.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Field ' + (index + 1) + ' must be a JSON object.');
    }
    const value = entry as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const label = typeof value.label === 'string' ? value.label.trim() : '';
    if (!/^[a-z][a-z0-9_]{0,27}$/.test(id)) {
      throw new Error('Field ' + (index + 1) + ' needs an id using 1–28 lowercase letters, numbers, or underscores, starting with a letter.');
    }
    if (seen.has(id)) throw new Error('Duplicate form field id: ' + id + '.');
    seen.add(id);
    if (!label || label.length > 45) {
      throw new Error('Field ' + id + ' needs a label between 1 and 45 characters.');
    }
    if (!fieldType(value.type)) {
      throw new Error('Field ' + id + ' has an unsupported type. Supported types: ' + TICKET_FORM_FIELD_TYPES.join(', ') + '.');
    }

    const required = value.required === undefined ? false : value.required;
    if (typeof required !== 'boolean') {
      throw new Error('Field ' + id + ' property "required" must be true or false.');
    }

    const placeholder = typeof value.placeholder === 'string' ? value.placeholder.trim() : undefined;
    if (placeholder && placeholder.length > 100) {
      throw new Error('Field ' + id + ' placeholder cannot exceed 100 characters.');
    }

    const defaultMax = value.type === 'long_text' ? 1_500 : 100;
    const minLength = value.minLength === undefined ? 0 : value.minLength;
    const maxLength = value.maxLength === undefined ? defaultMax : value.maxLength;
    if (!Number.isInteger(minLength) || (minLength as number) < 0 ||
        !Number.isInteger(maxLength) || (maxLength as number) < 1 || (maxLength as number) > 4_000 ||
        (minLength as number) > (maxLength as number)) {
      throw new Error('Field ' + id + ' must use valid minLength/maxLength limits (0–4000, with maxLength at least 1).');
    }

    const min = value.min === undefined ? undefined : value.min;
    const max = value.max === undefined ? undefined : value.max;
    if ((min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) ||
        (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max)))) {
      throw new Error('Field ' + id + ' numeric min/max must be finite numbers.');
    }
    if (min !== undefined && max !== undefined && (min as number) > (max as number)) {
      throw new Error('Field ' + id + ' minimum cannot exceed maximum.');
    }
    if ((min !== undefined || max !== undefined) && value.type !== 'number' && value.type !== 'decimal') {
      throw new Error('Field ' + id + ' can use min/max only with number or decimal types.');
    }

    let choices: string[] | undefined;
    if (value.type === 'dropdown' || value.type === 'multi_select') {
      if (!Array.isArray(value.choices) || value.choices.length < 1 || value.choices.length > 25) {
        throw new Error('Field ' + id + ' requires between 1 and 25 choices.');
      }
      choices = value.choices.map((choice) => {
        if (typeof choice !== 'string' || !choice.trim() || choice.trim().length > 100) {
          throw new Error('Every choice for field ' + id + ' must contain 1–100 characters.');
        }
        return choice.trim();
      });
      if (new Set(choices.map((choice) => choice.toLowerCase())).size !== choices.length) {
        throw new Error('Field ' + id + ' contains duplicate choices.');
      }
    } else if (value.choices !== undefined) {
      throw new Error('Field ' + id + ' can define choices only for dropdown or multi_select.');
    }

    const pattern = typeof value.pattern === 'string' ? value.pattern : undefined;
    if (pattern !== undefined) {
      if (value.type !== 'short_text' && value.type !== 'long_text') {
        throw new Error('Field ' + id + ' can define pattern only for short_text or long_text.');
      }
      rejectUnsafePattern(pattern);
    }

    let maxBytes: number | undefined;
    let allowedMimeTypes: string[] | undefined;
    if (value.type === 'attachment') {
      maxBytes = value.maxBytes === undefined ? 8 * 1024 * 1024 : value.maxBytes as number;
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 25 * 1024 * 1024) {
        throw new Error('Attachment field ' + id + ' maxBytes must be an integer between 1 byte and 25 MiB.');
      }
      const rawTypes = value.allowedMimeTypes === undefined
        ? ['image/*', 'application/pdf']
        : value.allowedMimeTypes;
      if (!Array.isArray(rawTypes) || rawTypes.length < 1 || rawTypes.length > 20) {
        throw new Error('Attachment field ' + id + ' must allow 1–20 MIME types.');
      }
      allowedMimeTypes = rawTypes.map((mime) => {
        if (typeof mime !== 'string') throw new Error('Allowed MIME types for ' + id + ' must be strings.');
        const normalized = mime.trim().toLowerCase();
        if (!/^[a-z0-9!#    const pattern = typeof value.pattern === 'string' ? value.pattern : undefined;
    if (pattern !== undefined) {
      if (value.type !== 'short_text' && value.type !== 'long_text') {
        throw new Error('Field ' + id + ' can define pattern only for short_text or long_text.');
      }
      rejectUnsafePattern(pattern);
    }

    return {
      id,
      label,
      type: value.type,
      required,
      ...(placeholder ? { placeholder } : {}),
      minLength: minLength as number,
      maxLength: maxLength as number,
      ...(min !== undefined ? { min: min as number } : {}),
      ...(max !== undefined ? { max: max as number } : {}),
      ...(choices ? { choices } : {}),
      ...(pattern !== undefined ? { pattern } : {}),
    };^_.+-]+\/(?:[a-z0-9!#    const pattern = typeof value.pattern === 'string' ? value.pattern : undefined;
    if (pattern !== undefined) {
      if (value.type !== 'short_text' && value.type !== 'long_text') {
        throw new Error('Field ' + id + ' can define pattern only for short_text or long_text.');
      }
      rejectUnsafePattern(pattern);
    }

    return {
      id,
      label,
      type: value.type,
      required,
      ...(placeholder ? { placeholder } : {}),
      minLength: minLength as number,
      maxLength: maxLength as number,
      ...(min !== undefined ? { min: min as number } : {}),
      ...(max !== undefined ? { max: max as number } : {}),
      ...(choices ? { choices } : {}),
      ...(pattern !== undefined ? { pattern } : {}),
    };^_.+-]+|\*)$/.test(normalized) || normalized.startsWith('*/')) {
          throw new Error('Invalid MIME type "' + mime + '" in attachment field ' + id + '. Use values such as image/* or application/pdf.');
        }
        return normalized;
      });
    } else if (value.maxBytes !== undefined || value.allowedMimeTypes !== undefined) {
      throw new Error('Attachment size/type settings can only be used with attachment fields.');
    }

    return {
      id,
      label,
      type: value.type,
      required,
      ...(placeholder ? { placeholder } : {}),
      minLength: minLength as number,
      maxLength: maxLength as number,
      ...(min !== undefined ? { min: min as number } : {}),
      ...(max !== undefined ? { max: max as number } : {}),
      ...(choices ? { choices } : {}),
      ...(pattern !== undefined ? { pattern } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(allowedMimeTypes ? { allowedMimeTypes } : {}),
    };
  });
}

function normalizedChoice(value: string, choices: string[]): string | undefined {
  return choices.find((choice) => choice.toLowerCase() === value.toLowerCase());
}

export interface TicketFormAttachmentAnswer {
  id: string;
  url: string;
  name: string;
  size: number;
  contentType: string | null;
}

function mimeTypeAllowed(contentType: string, allowed: string[]): boolean {
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
  return allowed.some((entry) => entry === normalized ||
    (entry.endsWith('/*') && normalized.startsWith(entry.slice(0, -1))));
}

/** Strictly validate every submitted answer on the server, regardless of UI component validation. */
export function validateTicketFormAnswers(
  fields: TicketFormField[],
  rawAnswers: Record<string, unknown>,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = rawAnswers[field.id];
    const blank = raw === undefined || raw === null ||
      (typeof raw === 'string' && raw.trim().length === 0) ||
      (Array.isArray(raw) && raw.length === 0);
    if (blank) {
      if (field.required) throw new Error('"' + field.label + '" is required.');
      continue;
    }

    switch (field.type) {
      case 'short_text':
      case 'long_text': {
        if (typeof raw !== 'string') throw new Error('"' + field.label + '" must be text.');
        const value = raw.trim();
        if (value.length < (field.minLength ?? 0)) {
          throw new Error('"' + field.label + '" must contain at least ' + (field.minLength ?? 0) + ' characters.');
        }
        if (value.length > (field.maxLength ?? (field.type === 'long_text' ? 1_500 : 100))) {
          throw new Error('"' + field.label + '" must not exceed ' + (field.maxLength ?? 100) + ' characters.');
        }
        if (field.pattern && !new RegExp(field.pattern).test(value)) {
          throw new Error('"' + field.label + '" does not match the required format.');
        }
        answers[field.id] = value;
        break;
      }
      case 'number':
      case 'decimal': {
        if (typeof raw !== 'string' && typeof raw !== 'number') throw new Error('"' + field.label + '" must be numeric.');
        const number = typeof raw === 'number' ? raw : Number(raw.trim());
        if (!Number.isFinite(number) || (field.type === 'number' && !Number.isInteger(number))) {
          throw new Error('"' + field.label + '" must be a valid ' + (field.type === 'number' ? 'whole number' : 'decimal number') + '.');
        }
        if (field.min !== undefined && number < field.min) throw new Error('"' + field.label + '" must be at least ' + field.min + '.');
        if (field.max !== undefined && number > field.max) throw new Error('"' + field.label + '" must be at most ' + field.max + '.');
        answers[field.id] = number;
        break;
      }
      case 'url': {
        if (typeof raw !== 'string') throw new Error('"' + field.label + '" must be a URL.');
        let url: URL;
        try { url = new URL(raw.trim()); } catch { throw new Error('"' + field.label + '" must be a valid URL.'); }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('"' + field.label + '" must use HTTP or HTTPS.');
        answers[field.id] = url.toString();
        break;
      }
      case 'email': {
        if (typeof raw !== 'string') throw new Error('"' + field.label + '" must be an email address.');
        const value = raw.trim();
        if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          throw new Error('"' + field.label + '" must be a valid email address.');
        }
        answers[field.id] = value;
        break;
      }
      case 'date': {
        if (typeof raw !== 'string') throw new Error('"' + field.label + '" must be a date.');
        const value = raw.trim();
        const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? new Date(value + 'T00:00:00.000Z')
          : null;
        if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== value) {
          throw new Error('"' + field.label + '" must use a real date in YYYY-MM-DD format.');
        }
        answers[field.id] = value;
        break;
      }
      case 'dropdown': {
        if (typeof raw !== 'string' && !Array.isArray(raw)) throw new Error('"' + field.label + '" must be one configured option.');
        const submitted = Array.isArray(raw) ? raw : [raw];
        if (submitted.length !== 1 || typeof submitted[0] !== 'string') {
          throw new Error('Choose exactly one option for "' + field.label + '".');
        }
        const choice = normalizedChoice(submitted[0], field.choices ?? []);
        if (!choice) throw new Error('Choose one of the configured options for "' + field.label + '": ' + (field.choices ?? []).join(', ') + '.');
        answers[field.id] = choice;
        break;
      }
      case 'multi_select': {
        if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
          throw new Error('"' + field.label + '" must be selected from the configured options.');
        }
        const selected = raw.map((entry) => normalizedChoice(entry as string, field.choices ?? []));
        if (selected.some((entry) => !entry)) {
          throw new Error('Use only configured options for "' + field.label + '": ' + (field.choices ?? []).join(', ') + '.');
        }
        const unique = Array.from(new Set(selected as string[]));
        if (unique.length !== selected.length) throw new Error('Do not select duplicate options for "' + field.label + '".');
        answers[field.id] = unique;
        break;
      }
      case 'checkbox': {
        if (typeof raw === 'boolean') {
          answers[field.id] = raw;
          break;
        }
        if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
          throw new Error('"' + field.label + '" must be answered with a checkbox.');
        }
        answers[field.id] = raw.includes('checked');
        break;
      }
      case 'discord_user':
      case 'discord_role': {
        if (!Array.isArray(raw) || raw.length !== 1 || typeof raw[0] !== 'string' || !/^\d{17,20}$/.test(raw[0])) {
          throw new Error('"' + field.label + '" must select exactly one valid Discord ' + (field.type === 'discord_user' ? 'user' : 'role') + '.');
        }
        answers[field.id] = raw[0];
        break;
      }
      case 'attachment': {
        if (!Array.isArray(raw) || raw.length !== 1 || !raw[0] || typeof raw[0] !== 'object') {
          throw new Error('"' + field.label + '" must upload exactly one file.');
        }
        const file = raw[0] as Partial<TicketFormAttachmentAnswer>;
        if (typeof file.id !== 'string' || typeof file.url !== 'string' ||
            typeof file.name !== 'string' || typeof file.size !== 'number' ||
            !Number.isFinite(file.size) || file.size < 0 ||
            typeof file.contentType !== 'string' || !file.contentType.trim()) {
          throw new Error('The uploaded file for "' + field.label + '" did not include verifiable file metadata.');
        }
        if (file.size > (field.maxBytes ?? 8 * 1024 * 1024)) {
          throw new Error('"' + field.label + '" must be no larger than ' + Math.floor((field.maxBytes ?? 8 * 1024 * 1024) / (1024 * 1024)) + ' MiB.');
        }
        if (!mimeTypeAllowed(file.contentType, field.allowedMimeTypes ?? ['image/*', 'application/pdf'])) {
          throw new Error('The file type for "' + field.label + '" is not allowed. Accepted types: ' + (field.allowedMimeTypes ?? ['image/*', 'application/pdf']).join(', ') + '.');
        }
        if (!/^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\//i.test(file.url)) {
          throw new Error('The uploaded file for "' + field.label + '" did not come from a trusted Discord attachment host.');
        }
        answers[field.id] = {
          id: file.id,
          url: file.url,
          name: file.name.slice(0, 255),
          size: file.size,
          contentType: file.contentType.split(';', 1)[0].toLowerCase(),
        } satisfies TicketFormAttachmentAnswer;
        break;
      }
    }
  }
  return answers;
}

function mapVersion(row: TicketFormRow, version: number, schemaRaw: unknown, snapshotRaw?: unknown): TicketFormVersion {
  const form = rowToForm(row);
  const fields = readSchema(schemaRaw).fields;
  let snapshot = snapshotRaw;
  if (typeof snapshot === 'string') {
    try { snapshot = JSON.parse(snapshot) as unknown; } catch { throw new Error('The stored ticket form snapshot is malformed.'); }
  }
  const value = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot as TicketFormVersion['snapshot']
    : {
        id: form.id,
        name: form.name,
        departmentId: form.departmentId,
        tagId: form.tagId,
        version,
        fields,
      };
  return { ...form, version, fields, snapshot: value };
}

function snapshotFor(form: Pick<TicketForm, 'id' | 'name' | 'departmentId' | 'tagId'>, version: number, fields: TicketFormField[]): TicketFormVersion['snapshot'] {
  return {
    id: form.id,
    name: form.name,
    departmentId: form.departmentId,
    tagId: form.tagId,
    version,
    fields: fields.map((field) => ({ ...field, ...(field.choices ? { choices: [...field.choices] } : {}) })),
  };
}

async function ensureValidMapping(guildId: string, departmentId: string, tagId: string | null): Promise<void> {
  const config = await getGuildConfig(guildId);
  const department = config.departments[departmentId];
  if (!department) throw new Error('That department no longer exists. Choose an existing department id from /supportforge form list.');
  if (tagId && !department.tags?.[tagId]) {
    throw new Error('That tag does not belong to the selected department. Use "*" for all tags or provide a tag id belonging to this department.');
  }
}

async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  await initializePersistence();
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const FORM_COLUMNS = 'id, guild_id, name, department_id, tag_id, current_version, active, created_by, created_at, updated_at';

export async function createTicketForm(args: {
  guildId: string;
  name: string;
  departmentId: string;
  tagId: string | null;
  fields: TicketFormField[];
  actorId: string;
}): Promise<TicketFormVersion> {
  const name = args.name.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80) throw new Error('A form name must contain 1–80 characters.');
  const fields = parseTicketFormFields(args.fields);
  await ensureValidMapping(args.guildId, args.departmentId, args.tagId);
  const id = randomUUID();
  const now = new Date().toISOString();
  return transaction(async (client) => {
    await client.query(
      'INSERT INTO ticket_forms (id, guild_id, name, department_id, tag_id, current_version, active, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,1,FALSE,$6,$7,$7)',
      [id, args.guildId, name, args.departmentId, args.tagId, args.actorId, now],
    );
    const formBase = {
      id, guildId: args.guildId, name, departmentId: args.departmentId, tagId: args.tagId,
    };
    const snapshot = snapshotFor(formBase, 1, fields);
    await client.query(
      'INSERT INTO ticket_form_versions (form_id, version, schema, snapshot, created_by, created_at) VALUES ($1,1,$2::jsonb,$3::jsonb,$4,$5)',
      [id, JSON.stringify({ fields }), JSON.stringify(snapshot), args.actorId, now],
    );
    const row = await client.query<TicketFormRow>('SELECT ' + FORM_COLUMNS + ' FROM ticket_forms WHERE id=$1', [id]);
    return mapVersion(row.rows[0], 1, { fields }, snapshot);
  });
}

export async function listTicketForms(guildId: string): Promise<TicketFormVersion[]> {
  await initializePersistence();
  const result = await getPostgresPool().query<TicketFormRow>(
    'SELECT f.id, f.guild_id, f.name, f.department_id, f.tag_id, f.current_version, f.active, f.created_by, f.created_at, f.updated_at, v.version, v.schema, v.snapshot ' +
    'FROM ticket_forms f JOIN ticket_form_versions v ON v.form_id=f.id AND v.version=f.current_version ' +
    'WHERE f.guild_id=$1 ORDER BY f.created_at DESC',
    [guildId],
  );
  return result.rows.map((row) => mapVersion(row, Number(row.version), row.schema, row.snapshot));
}

export async function updateTicketFormFields(args: {
  guildId: string;
  formId: string;
  fields: TicketFormField[];
  actorId: string;
}): Promise<TicketFormVersion> {
  const fields = parseTicketFormFields(args.fields);
  await initializePersistence();
  const pool = getPostgresPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<TicketFormRow>(
      'SELECT ' + FORM_COLUMNS + ' FROM ticket_forms WHERE guild_id=$1 AND id=$2 FOR UPDATE',
      [args.guildId, args.formId],
    );
    const row = selected.rows[0];
    if (!row) throw new Error('Ticket form not found in this server.');
    await ensureValidMapping(args.guildId, row.department_id, row.tag_id);
    const version = Number(row.current_version) + 1;
    const snapshot = snapshotFor({
      id: row.id, name: row.name, departmentId: row.department_id, tagId: row.tag_id,
    }, version, fields);
    await client.query(
      'INSERT INTO ticket_form_versions (form_id, version, schema, snapshot, created_by, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,NOW())',
      [row.id, version, JSON.stringify({ fields }), JSON.stringify(snapshot), args.actorId],
    );
    await client.query(
      'UPDATE ticket_forms SET current_version=$2, updated_at=NOW() WHERE id=$1 AND guild_id=$3',
      [row.id, version, args.guildId],
    );
    await client.query('COMMIT');
    return mapVersion({ ...row, current_version: version, updated_at: new Date() }, version, { fields }, snapshot);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function setTicketFormActive(args: {
  guildId: string;
  formId: string;
  active: boolean;
}): Promise<TicketForm> {
  await initializePersistence();
  try {
    const result = await getPostgresPool().query<TicketFormRow>(
      'UPDATE ticket_forms SET active=$3, updated_at=NOW() WHERE guild_id=$1 AND id=$2 RETURNING ' + FORM_COLUMNS,
      [args.guildId, args.formId, args.active],
    );
    if (!result.rows[0]) throw new Error('Ticket form not found in this server.');
    return rowToForm(result.rows[0]);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505') {
      throw new Error('Another active form is already assigned to that department/tag mapping. Disable it first.');
    }
    throw error;
  }
}

export async function getActiveTicketFormForRouting(
  guildId: string,
  departmentId: string,
  tagId: string,
): Promise<TicketFormVersion | undefined> {
  await initializePersistence();
  const result = await getPostgresPool().query<TicketFormRow>(
    'SELECT f.id, f.guild_id, f.name, f.department_id, f.tag_id, f.current_version, f.active, f.created_by, f.created_at, f.updated_at, v.version, v.schema, v.snapshot ' +
    'FROM ticket_forms f JOIN ticket_form_versions v ON v.form_id=f.id AND v.version=f.current_version ' +
    'WHERE f.guild_id=$1 AND f.department_id=$2 AND (f.tag_id=$3 OR f.tag_id IS NULL) AND f.active=TRUE ' +
    'ORDER BY CASE WHEN f.tag_id=$3 THEN 0 ELSE 1 END, f.updated_at DESC LIMIT 1',
    [guildId, departmentId, tagId],
  );
  const row = result.rows[0];
  return row ? mapVersion(row, Number(row.version), row.schema, row.snapshot) : undefined;
}

/** Reject stale or expired modal submissions instead of silently using edited form fields. */
export async function getTicketFormForSubmission(args: {
  guildId: string;
  departmentId: string;
  tagId: string;
  formId: string;
  version: number;
}): Promise<TicketFormVersion> {
  await initializePersistence();
  const result = await getPostgresPool().query<TicketFormRow>(
    'SELECT f.id, f.guild_id, f.name, f.department_id, f.tag_id, f.current_version, f.active, f.created_by, f.created_at, f.updated_at, v.version, v.schema, v.snapshot ' +
    'FROM ticket_forms f JOIN ticket_form_versions v ON v.form_id=f.id AND v.version=$3 ' +
    'WHERE f.guild_id=$1 AND f.id=$2 AND f.department_id=$4 AND (f.tag_id=$5 OR f.tag_id IS NULL) AND f.active=TRUE AND f.current_version=$3',
    [args.guildId, args.formId, args.version, args.departmentId, args.tagId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('This ticket form changed, was disabled, or no longer matches this department/tag. Reopen the support panel and submit the current form.');
  }
  return mapVersion(row, Number(row.version), row.schema, row.snapshot);
}

export async function recordTicketFormSubmissionDraft(args: {
  interactionId: string;
  guildId: string;
  form: TicketFormVersion;
  submittedBy: string;
  answers: Record<string, unknown>;
}): Promise<void> {
  await initializePersistence();
  const inserted = await getPostgresPool().query(
    'INSERT INTO ticket_form_submissions (interaction_id, guild_id, form_id, form_version, submitted_by, form_snapshot, answers, status, submitted_at) ' +
    'VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,\'pending\',NOW()) ON CONFLICT (interaction_id) DO NOTHING RETURNING interaction_id',
    [args.interactionId, args.guildId, args.form.id, args.form.version, args.submittedBy, JSON.stringify(args.form.snapshot), JSON.stringify(args.answers)],
  );
  if ((inserted.rowCount ?? 0) > 0) return;

  const existing = await getPostgresPool().query<SubmissionRow>(
    'SELECT interaction_id, guild_id, form_id, form_version, submitted_by, answers, ticket_id, channel_id FROM ticket_form_submissions WHERE interaction_id=$1',
    [args.interactionId],
  );
  const row = existing.rows[0];
  if (!row || row.guild_id !== args.guildId || row.form_id !== args.form.id ||
      Number(row.form_version) !== args.form.version || row.submitted_by !== args.submittedBy ||
      canonicalJson(row.answers) !== canonicalJson(args.answers)) {
    throw new Error('This form submission identifier already exists with different data.');
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value as Record<string, unknown>).sort().map((key) =>
      JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key]),
    ).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'undefined';
}

export async function setTicketFormSubmissionChannel(interactionId: string, channelId: string): Promise<void> {
  await initializePersistence();
  const result = await getPostgresPool().query(
    'UPDATE ticket_form_submissions SET channel_id=$2 WHERE interaction_id=$1 AND (channel_id IS NULL OR channel_id=$2)',
    [interactionId, channelId],
  );
  if ((result.rowCount ?? 0) === 0) throw new Error('Ticket form submission could not be associated with its new channel.');
}

export async function attachTicketFormSubmission(args: {
  interactionId: string;
  ticketId: string;
  channelId: string;
}): Promise<void> {
  await initializePersistence();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await getPostgresPool().query(
        'UPDATE ticket_form_submissions SET ticket_id=$2, channel_id=$3, status=\'attached\', attached_at=COALESCE(attached_at,NOW()), last_error=NULL ' +
        'WHERE interaction_id=$1 AND (ticket_id IS NULL OR ticket_id=$2)',
        [args.interactionId, args.ticketId, args.channelId],
      );
      if ((result.rowCount ?? 0) !== 1) {
        throw new Error('Form response could not be attached to its ticket. The pending response remains stored for recovery.');
      }
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
}

export async function markTicketFormSubmissionFailure(interactionId: string, safeReason: string): Promise<void> {
  await initializePersistence();
  await getPostgresPool().query(
    'UPDATE ticket_form_submissions SET status=\'failed\', last_error=$2 WHERE interaction_id=$1 AND status <> \'attached\'',
    [interactionId, safeReason.slice(0, 300)],
  );
}

/** Reconcile a persisted form response whose Discord channel/ticket setup later failed. */
export async function recoverPendingTicketFormSubmissions(): Promise<number> {
  await initializePersistence();
  const result = await getPostgresPool().query(
    'UPDATE ticket_form_submissions s SET ticket_id=t.id, channel_id=t.channel_id, status=\'attached\', attached_at=COALESCE(s.attached_at,NOW()), last_error=NULL ' +
    'FROM tickets t WHERE s.guild_id=t.guild_id AND s.ticket_id IS NULL AND s.status IN (\'pending\',\'failed\') ' +
    'AND (s.channel_id=t.channel_id OR s.interaction_id=t.metadata->>\'formSubmissionInteractionId\')',
  );
  return result.rowCount ?? 0;
}

export function startTicketFormSubmissionRecovery(intervalMs = 60_000): () => void {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void recoverPendingTicketFormSubmissions()
      .then((count) => {
        if (count > 0) console.info('Recovered ' + count + ' pending SupportForge form submission(s).');
      })
      .catch((error) => console.warn('SupportForge form submission recovery is temporarily unavailable:', error instanceof Error ? error.message : 'unknown database error'))
      .finally(() => { running = false; });
  };
  tick();
  const timer = setInterval(tick, Math.max(10_000, intervalMs));
  return () => clearInterval(timer);
}
