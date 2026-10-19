import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import {
  getGuildConfig,
  updateGuildConfig,
  type CustomSupportPanel,
  type CustomSupportPanelButton,
  type CustomSupportPanelPublishedConfig,
  type DepartmentConfig,
  type SupportPanelButtonStyle,
  type CustomSupportPanelTargetType,
} from './configService';
import { listTicketForms, type TicketFormVersion } from './ticketFormService';

export interface CustomPanelInput {
  name: string;
  title: string;
  description: string;
  footer?: string;
  color?: string | null;
  iconUrl?: string | null;
  thumbnailUrl?: string | null;
  bannerUrl?: string | null;
  buttons?: string | unknown;
}

export interface CustomPanelUpdate {
  name?: string;
  title?: string;
  description?: string;
  footer?: string;
  color?: string | null;
  iconUrl?: string | null;
  thumbnailUrl?: string | null;
  bannerUrl?: string | null;
  buttons?: string | unknown;
}

export interface CustomPanelButtonInput {
  targetType: CustomSupportPanelTargetType;
  departmentId?: string;
  formId?: string;
  tagId?: string | null;
  label: string;
  emoji?: string | null;
  style?: SupportPanelButtonStyle;
  confirmationMessage?: string | null;
  allowedRoleIds?: string[];
}

function boundedText(value: unknown, name: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(name + ' must be text.');
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > maximum) {
    throw new Error(name + ' must contain ' + (allowEmpty ? '0' : '1') + '–' + maximum + ' characters.');
  }
  return result;
}

function panelButtonId(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{4,20}$/.test(value)
    ? value
    : randomBytes(5).toString('hex');
}

export function normalizePanelColor(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Color must be a six-digit hex color such as #22D3EE.');
  const normalized = value.trim().replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(normalized)) {
    throw new Error('Color must be a six-digit hex color such as #22D3EE.');
  }
  return normalized;
}

export function normalizePanelUrl(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error(fieldName + ' must be an HTTP(S) URL no longer than 2048 characters.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(fieldName + ' must be a valid HTTP(S) URL.');
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(fieldName + ' must be a public HTTP(S) URL without embedded credentials.');
  }
  if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
    throw new Error(fieldName + ' must use a public HTTP(S) host.');
  }
  return parsed.toString();
}

function normalizeRoleIds(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 25) {
    throw new Error(name + ' must be an array of at most 25 Discord role IDs.');
  }
  const ids = value.map((id) => {
    if (typeof id !== 'string' || !/^\d{17,20}$/.test(id)) {
      throw new Error(name + ' contains an invalid Discord role ID.');
    }
    return id;
  });
  return [...new Set(ids)];
}

function getForm(
  forms: TicketFormVersion[],
  formId: unknown,
  departmentId: string | undefined,
  requestedTagId: string | null | undefined,
  departments: Record<string, DepartmentConfig>,
  index: number,
): { form: TicketFormVersion; departmentId: string; tagId: string } {
  const cleanFormId = boundedText(formId, 'Button ' + index + ' formId', 36);
  const form = forms.find((candidate) => candidate.id === cleanFormId && candidate.active);
  if (!form) {
    throw new Error('Button ' + index + ' targets a missing or inactive ticket form. Activate the form before using it on a panel.');
  }
  if (departmentId && departmentId !== form.departmentId) {
    throw new Error('Button ' + index + ' departmentId does not match the selected form.');
  }
  const department = departments[form.departmentId];
  if (!department) throw new Error('The selected form points to a department that no longer exists.');
  const tagId = requestedTagId ?? form.tagId;
  if (!tagId) {
    throw new Error('Button ' + index + ' must select a concrete tag for wildcard forms. Choose a tag from the form’s department.');
  }
  if (!department.tags?.[tagId]) {
    throw new Error('Button ' + index + ' tagId is not a tag in the form’s department.');
  }
  if (form.tagId && form.tagId !== tagId) {
    throw new Error('Button ' + index + ' tagId does not match the exact tag assigned to that form.');
  }
  return { form, departmentId: form.departmentId, tagId };
}

export function parseCustomPanelButtons(
  input: string | unknown,
  departments: Record<string, DepartmentConfig>,
  forms: TicketFormVersion[] = [],
  allowEmpty = false,
): CustomSupportPanelButton[] {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input) as unknown;
    } catch (error) {
      throw new Error('Buttons JSON must be valid JSON.', { cause: error });
    }
  }
  if (!Array.isArray(raw) || raw.length > 25 || (!allowEmpty && raw.length < 1)) {
    throw new Error('A custom panel draft can contain 0–25 buttons; publish requires at least one button.');
  }

  return raw.map((entry, index): CustomSupportPanelButton => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Button ' + (index + 1) + ' must be an object.');
    }
    const value = entry as Record<string, unknown>;
    const targetType: CustomSupportPanelTargetType = value.targetType === undefined ? 'department' : value.targetType as CustomSupportPanelTargetType;
    if (targetType !== 'department' && targetType !== 'form') {
      throw new Error('Button ' + (index + 1) + ' targetType must be department or form.');
    }
    const label = boundedText(value.label, 'Button ' + (index + 1) + ' label', 80);
    const rawStyle = value.style === undefined ? 'primary' : value.style;
    if (rawStyle !== 'primary' && rawStyle !== 'secondary' && rawStyle !== 'success' && rawStyle !== 'danger') {
      throw new Error('Button ' + (index + 1) + ' style must be primary, secondary, success, or danger.');
    }
    let emoji: string | undefined;
    if (value.emoji !== undefined && value.emoji !== null && value.emoji !== '') {
      emoji = boundedText(value.emoji, 'Button ' + (index + 1) + ' emoji', 100);
    }
    const confirmationMessage = value.confirmationMessage === undefined || value.confirmationMessage === null
      ? null
      : boundedText(value.confirmationMessage, 'Button ' + (index + 1) + ' confirmationMessage', 1000, true) || null;
    const allowedRoleIds = normalizeRoleIds(value.allowedRoleIds, 'Button ' + (index + 1) + ' allowedRoleIds');

    if (targetType === 'department') {
      const departmentId = boundedText(value.departmentId, 'Button ' + (index + 1) + ' departmentId', 28);
      const department = departments[departmentId];
      if (!department) {
        throw new Error('Button ' + (index + 1) + ' targets unknown department "' + departmentId + '".');
      }
      const tagId = value.tagId === undefined || value.tagId === null || value.tagId === '' || value.tagId === '*'
        ? null
        : boundedText(value.tagId, 'Button ' + (index + 1) + ' tagId', 28);
      if (tagId && !department.tags?.[tagId]) {
        throw new Error('Button ' + (index + 1) + ' tagId must refer to a tag in its department.');
      }
      return {
        id: panelButtonId(value.id),
        targetType,
        departmentId,
        formId: null,
        formVersion: null,
        tagId,
        label,
        ...(emoji ? { emoji } : {}),
        style: rawStyle as SupportPanelButtonStyle,
        confirmationMessage,
        allowedRoleIds,
      };
    }

    const departmentIdValue = typeof value.departmentId === 'string' ? value.departmentId : undefined;
    const requestedTagId = value.tagId === undefined || value.tagId === null || value.tagId === '' || value.tagId === '*'
      ? null
      : boundedText(value.tagId, 'Button ' + (index + 1) + ' tagId', 28);
    const { form, departmentId, tagId } = getForm(
      forms,
      value.formId,
      departmentIdValue,
      requestedTagId,
      departments,
      index + 1,
    );
    return {
      id: panelButtonId(value.id),
      targetType,
      departmentId,
      formId: form.id,
      formVersion: form.version,
      tagId,
      label,
      ...(emoji ? { emoji } : {}),
      style: rawStyle as SupportPanelButtonStyle,
      confirmationMessage,
      allowedRoleIds,
    };
  });
}

function normalizedDraft(panel: CustomSupportPanel): CustomSupportPanel {
  return {
    ...panel,
    iconUrl: panel.iconUrl ?? null,
    allowedRoleIds: panel.allowedRoleIds ?? [],
    publishedConfig: panel.publishedConfig ?? null,
    buttons: (panel.buttons ?? []).map((button, index) => ({
      id: panelButtonId(button.id ?? 'legacy_' + panel.id.slice(0, 6) + '_' + (index + 1)),
      targetType: button.targetType ?? (button.formId ? 'form' : 'department'),
      departmentId: button.departmentId ?? '',
      formId: button.formId ?? null,
      formVersion: button.formVersion ?? null,
      tagId: button.tagId ?? null,
      label: button.label ?? 'Start Ticket',
      ...(button.emoji ? { emoji: button.emoji } : {}),
      style: button.style ?? 'primary',
      confirmationMessage: button.confirmationMessage ?? null,
      allowedRoleIds: button.allowedRoleIds ?? [],
    })),
  };
}

function roleRestrictedButtons(
  panelId: string,
  buttons: CustomSupportPanelButton[],
  disabled: boolean,
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const styles = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
    danger: ButtonStyle.Danger,
  } as const;
  for (let start = 0; start < buttons.length; start += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const item of buttons.slice(start, start + 5)) {
      const button = new ButtonBuilder()
        .setCustomId('ticket:custom:' + panelId + ':' + item.id)
        .setLabel(item.label)
        .setStyle(styles[item.style] ?? ButtonStyle.Primary)
        .setDisabled(disabled);
      if (item.emoji) button.setEmoji(item.emoji);
      row.addComponents(button);
    }
    rows.push(row);
  }
  return rows;
}

export function buildCustomPanelEmbed(
  inputPanel: CustomSupportPanel,
  guildName: string,
  themeColor: number,
  preview = false,
  published = false,
): EmbedBuilder {
  const panel = normalizedDraft(inputPanel);
  const publishedConfig = published ? panel.publishedConfig : null;
  const view = publishedConfig ? { ...panel, ...publishedConfig } : panel;
  const color = view.color ? Number.parseInt(view.color, 16) : themeColor;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(view.title)
    .setDescription(view.description || 'Choose an option below to start a support request.')
    .setFooter({ text: view.footer || 'ResolveX • Customer Support' })
    .setAuthor({
      name: guildName + ' • ResolveX Support',
      ...(view.iconUrl ? { iconURL: view.iconUrl } : {}),
    })
    .setTimestamp(new Date(panel.updatedAt));
  if (view.thumbnailUrl) embed.setThumbnail(view.thumbnailUrl);
  if (view.bannerUrl) embed.setImage(view.bannerUrl);
  if (preview) {
    embed.addFields({
      name: 'Preview',
      value: 'Draft preview only. Controls are disabled and the published panel is not changed.',
    });
  }
  return embed;
}

export function buildCustomPanelComponents(
  inputPanel: CustomSupportPanel,
  preview = false,
  published = false,
): ActionRowBuilder<ButtonBuilder>[] {
  const panel = normalizedDraft(inputPanel);
  const buttons = published && panel.publishedConfig
    ? panel.publishedConfig.buttons
    : panel.buttons;
  return roleRestrictedButtons(panel.id, buttons, preview);
}

export async function listCustomPanels(guildId: string): Promise<CustomSupportPanel[]> {
  const config = await getGuildConfig(guildId);
  return Object.values(config.customPanels ?? {})
    .map(normalizedDraft)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getCustomPanel(guildId: string, panelId: string): Promise<CustomSupportPanel | null> {
  const config = await getGuildConfig(guildId);
  const panel = config.customPanels?.[panelId];
  return panel ? normalizedDraft(panel) : null;
}

async function formsForButtons(guildId: string, input: string | unknown): Promise<TicketFormVersion[]> {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input) as unknown; } catch { return []; }
  }
  if (!Array.isArray(raw) || !raw.some((entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry) &&
    (entry as Record<string, unknown>).targetType === 'form',
  )) return [];
  return listTicketForms(guildId);
}

function publishedSnapshot(panel: CustomSupportPanel): CustomSupportPanelPublishedConfig {
  return {
    title: panel.title,
    description: panel.description,
    footer: panel.footer,
    color: panel.color,
    iconUrl: panel.iconUrl ?? null,
    thumbnailUrl: panel.thumbnailUrl,
    bannerUrl: panel.bannerUrl,
    allowedRoleIds: [...(panel.allowedRoleIds ?? [])],
    buttons: panel.buttons.map((button, index) => ({
      ...button,
      id: panelButtonId(button.id ?? 'legacy_' + panel.id.slice(0, 6) + '_' + (index + 1)),
      allowedRoleIds: [...(button.allowedRoleIds ?? [])],
    })),
  };
}

export async function createCustomPanel(
  guildId: string,
  input: CustomPanelInput,
): Promise<CustomSupportPanel> {
  const config = await getGuildConfig(guildId);
  const name = boundedText(input.name, 'Panel name', 80);
  const buttonInput = input.buttons ?? [];
  const forms = await formsForButtons(guildId, buttonInput);
  const panel: CustomSupportPanel = {
    id: randomBytes(6).toString('hex'),
    name,
    title: boundedText(input.title, 'Panel title', 256),
    description: boundedText(input.description, 'Panel description', 4000, true),
    footer: input.footer === undefined ? 'ResolveX • Customer Support' : boundedText(input.footer, 'Panel footer', 2048, true),
    color: normalizePanelColor(input.color),
    iconUrl: normalizePanelUrl(input.iconUrl, 'Panel icon URL'),
    thumbnailUrl: normalizePanelUrl(input.thumbnailUrl, 'Thumbnail URL'),
    bannerUrl: normalizePanelUrl(input.bannerUrl, 'Banner URL'),
    allowedRoleIds: [],
    buttons: parseCustomPanelButtons(buttonInput, config.departments, forms, true),
    publishedChannelId: null,
    publishedMessageId: null,
    publishedConfig: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await updateGuildConfig(guildId, (current) => {
    const duplicate = Object.values(current.customPanels ?? {}).some((existing) => existing.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicate) throw new Error('A panel named "' + name + '" already exists in this server. Use a different name.');
    current.customPanels ??= {};
    current.customPanels[panel.id] = panel;
  });
  return panel;
}

export async function updateCustomPanel(
  guildId: string,
  panelId: string,
  updates: CustomPanelUpdate,
): Promise<CustomSupportPanel> {
  const config = await getGuildConfig(guildId);
  const existing = config.customPanels?.[panelId];
  if (!existing) throw new Error('Custom panel "' + panelId + '" was not found.');
  const normalized = normalizedDraft(existing);
  const forms = updates.buttons === undefined ? [] : await formsForButtons(guildId, updates.buttons);
  const buttons = updates.buttons === undefined
    ? normalized.buttons
    : parseCustomPanelButtons(updates.buttons, config.departments, forms, true);
  const nextName = updates.name === undefined ? normalized.name : boundedText(updates.name, 'Panel name', 80);
  await updateGuildConfig(guildId, (current) => {
    current.customPanels ??= {};
    const duplicate = Object.values(current.customPanels).some((other) =>
      other.id !== panelId && other.name.toLocaleLowerCase() === nextName.toLocaleLowerCase(),
    );
    if (duplicate) throw new Error('A panel named "' + nextName + '" already exists in this server.');
    const panel = current.customPanels[panelId];
    if (!panel) throw new Error('This custom panel was removed while it was being edited.');
    current.customPanels[panelId] = {
      ...normalizedDraft(panel),
      name: nextName,
      title: updates.title === undefined ? normalized.title : boundedText(updates.title, 'Panel title', 256),
      description: updates.description === undefined ? normalized.description : boundedText(updates.description, 'Panel description', 4000, true),
      footer: updates.footer === undefined ? normalized.footer : boundedText(updates.footer, 'Panel footer', 2048, true),
      color: updates.color === undefined ? normalized.color : normalizePanelColor(updates.color),
      iconUrl: updates.iconUrl === undefined ? normalized.iconUrl : normalizePanelUrl(updates.iconUrl, 'Panel icon URL'),
      thumbnailUrl: updates.thumbnailUrl === undefined ? normalized.thumbnailUrl : normalizePanelUrl(updates.thumbnailUrl, 'Thumbnail URL'),
      bannerUrl: updates.bannerUrl === undefined ? normalized.bannerUrl : normalizePanelUrl(updates.bannerUrl, 'Banner URL'),
      buttons,
      updatedAt: new Date().toISOString(),
    };
  });
  const saved = await getCustomPanel(guildId, panelId);
  if (!saved) throw new Error('Custom panel update could not be read back.');
  return saved;
}

export async function addCustomPanelButton(
  guildId: string,
  panelId: string,
  input: CustomPanelButtonInput,
): Promise<CustomSupportPanelButton> {
  const config = await getGuildConfig(guildId);
  const existing = config.customPanels?.[panelId];
  if (!existing) throw new Error('Custom panel was not found.');
  const panel = normalizedDraft(existing);
  if (panel.buttons.length >= 25) throw new Error('Discord supports at most 25 buttons per panel message.');
  const raw = {
    ...input,
    id: randomBytes(5).toString('hex'),
    allowedRoleIds: input.allowedRoleIds ?? [],
  };
  const forms = input.targetType === 'form' ? await listTicketForms(guildId) : [];
  const button = parseCustomPanelButtons([raw], config.departments, forms)[0];
  if (!button) throw new Error('Could not validate the new panel button.');
  await updateGuildConfig(guildId, (current) => {
    const target = current.customPanels?.[panelId];
    if (!target) throw new Error('Custom panel was removed while adding a button.');
    target.buttons = [...normalizedDraft(target).buttons, button];
    target.updatedAt = new Date().toISOString();
  });
  return button;
}

export async function retargetCustomPanelButton(
  guildId: string,
  panelId: string,
  buttonId: string,
  target: {
    targetType: CustomSupportPanelTargetType;
    departmentId?: string;
    formId?: string;
    tagId?: string | null;
  },
): Promise<CustomSupportPanelButton> {
  const config = await getGuildConfig(guildId);
  const savedPanel = config.customPanels?.[panelId];
  if (!savedPanel) throw new Error('Custom panel was not found.');
  const panel = normalizedDraft(savedPanel);
  const existing = panel.buttons.find((button) => button.id === buttonId);
  if (!existing) throw new Error('The button was not found. Refresh and try again.');
  const forms = target.targetType === 'form' ? await listTicketForms(guildId) : [];
  const selectedForm = target.targetType === 'form'
    ? forms.find((form) => form.id === target.formId && form.active)
    : undefined;
  if (target.targetType === 'form' && !selectedForm) {
    throw new Error('The selected form is missing or inactive. Refresh the active form list and retry.');
  }
  // Retargeting rotates the component identity so an interaction already in
  // flight against the previous target cannot accidentally launch the new one.
  const raw = {
    ...existing,
    ...target,
    ...(target.targetType === 'form' ? { departmentId: selectedForm!.departmentId } : {}),
    id: randomBytes(5).toString('hex'),
    ...(target.targetType === 'department' ? { formId: null, formVersion: null } : {}),
  };
  const updated = parseCustomPanelButtons([raw], config.departments, forms)[0];
  if (!updated) throw new Error('The new target could not be validated.');
  await updateGuildConfig(guildId, (current) => {
    const saved = current.customPanels?.[panelId];
    if (!saved) throw new Error('Custom panel was deleted while its button was being retargeted.');
    const currentButtons = normalizedDraft(saved).buttons;
    if (!currentButtons.some((button) => button.id === buttonId)) throw new Error('The button changed while you were editing it. Refresh and retry.');
    saved.buttons = currentButtons.map((button) => button.id === buttonId ? updated : button);
    saved.updatedAt = new Date().toISOString();
  });
  return updated;
}

export async function updateCustomPanelButton(
  guildId: string,
  panelId: string,
  buttonId: string,
  updates: { label?: string; emoji?: string | null; style?: SupportPanelButtonStyle; confirmationMessage?: string | null },
): Promise<CustomSupportPanelButton> {
  const panel = await getCustomPanel(guildId, panelId);
  if (!panel) throw new Error('Custom panel was not found.');
  const existing = panel.buttons.find((button) => button.id === buttonId);
  if (!existing) throw new Error('The button was not found. Refresh the panel builder and try again.');
  const updated: CustomSupportPanelButton = {
    ...existing,
    label: updates.label === undefined ? existing.label : boundedText(updates.label, 'Button label', 80),
    emoji: updates.emoji === undefined ? existing.emoji : (updates.emoji?.trim() || undefined),
    style: updates.style === undefined ? existing.style : updates.style,
    confirmationMessage: updates.confirmationMessage === undefined
      ? existing.confirmationMessage
      : (updates.confirmationMessage?.trim() ? boundedText(updates.confirmationMessage, 'Confirmation message', 1000) : null),
  };
  await updateGuildConfig(guildId, (current) => {
    const target = current.customPanels?.[panelId];
    if (!target) throw new Error('Custom panel no longer exists.');
    target.buttons = normalizedDraft(target).buttons.map((button) => button.id === buttonId ? updated : button);
    target.updatedAt = new Date().toISOString();
  });
  return updated;
}

export async function moveCustomPanelButton(
  guildId: string,
  panelId: string,
  buttonId: string,
  direction: 'up' | 'down',
): Promise<CustomSupportPanel> {
  await updateGuildConfig(guildId, (current) => {
    const target = current.customPanels?.[panelId];
    if (!target) throw new Error('Custom panel was not found.');
    const buttons = [...normalizedDraft(target).buttons];
    const index = buttons.findIndex((button) => button.id === buttonId);
    if (index < 0) throw new Error('The button no longer exists.');
    const nextIndex = direction === 'up' ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= buttons.length) return;
    [buttons[index], buttons[nextIndex]] = [buttons[nextIndex]!, buttons[index]!];
    target.buttons = buttons;
    target.updatedAt = new Date().toISOString();
  });
  const saved = await getCustomPanel(guildId, panelId);
  if (!saved) throw new Error('Panel update could not be read back.');
  return saved;
}

export async function deleteCustomPanelButton(
  guildId: string,
  panelId: string,
  buttonId: string,
): Promise<CustomSupportPanelButton> {
  let removed: CustomSupportPanelButton | null = null;
  await updateGuildConfig(guildId, (current) => {
    const target = current.customPanels?.[panelId];
    if (!target) throw new Error('Custom panel was not found.');
    const normalized = normalizedDraft(target);
    removed = normalized.buttons.find((button) => button.id === buttonId) ?? null;
    if (!removed) throw new Error('The button no longer exists.');
    target.buttons = normalized.buttons.filter((button) => button.id !== buttonId);
    target.updatedAt = new Date().toISOString();
  });
  if (!removed) throw new Error('The button could not be deleted.');
  return removed;
}

export async function setCustomPanelRoleAccess(
  guildId: string,
  panelId: string,
  roleIds: string[],
  buttonId?: string,
): Promise<CustomSupportPanel> {
  const normalizedRoles = normalizeRoleIds(roleIds, 'Access roles');
  await updateGuildConfig(guildId, (current) => {
    const target = current.customPanels?.[panelId];
    if (!target) throw new Error('Custom panel was not found.');
    const panel = normalizedDraft(target);
    if (buttonId) {
      const found = panel.buttons.some((button) => button.id === buttonId);
      if (!found) throw new Error('The button was not found.');
      target.buttons = panel.buttons.map((button) =>
        button.id === buttonId ? { ...button, allowedRoleIds: normalizedRoles } : button,
      );
    } else {
      target.allowedRoleIds = normalizedRoles;
    }
    target.updatedAt = new Date().toISOString();
  });
  const saved = await getCustomPanel(guildId, panelId);
  if (!saved) throw new Error('Panel access rules could not be read back.');
  return saved;
}

export async function markCustomPanelPublished(
  guildId: string,
  panelId: string,
  channelId: string,
  messageId: string,
): Promise<CustomSupportPanel> {
  await updateGuildConfig(guildId, (current) => {
    current.customPanels ??= {};
    const panel = current.customPanels[panelId];
    if (!panel) throw new Error('This custom panel no longer exists. Create it again before publishing.');
    const normalized = normalizedDraft(panel);
    if (normalized.buttons.length < 1 || normalized.buttons.length > 25) {
      throw new Error('Publish needs at least one and at most 25 validated buttons.');
    }
    panel.publishedChannelId = channelId;
    panel.publishedMessageId = messageId;
    panel.publishedConfig = publishedSnapshot(normalized);
    panel.updatedAt = new Date().toISOString();
  });
  const saved = await getCustomPanel(guildId, panelId);
  if (!saved) throw new Error('Published panel metadata could not be read back.');
  return saved;
}

export async function deleteCustomPanelDefinition(
  guildId: string,
  panelId: string,
): Promise<CustomSupportPanel> {
  let removed: CustomSupportPanel | null = null;
  await updateGuildConfig(guildId, (current) => {
    const panel = current.customPanels?.[panelId];
    if (!panel) throw new Error('Custom panel "' + panelId + '" was not found.');
    removed = normalizedDraft(panel);
    delete current.customPanels[panelId];
  });
  if (!removed) throw new Error('Custom panel could not be deleted.');
  return removed;
}
