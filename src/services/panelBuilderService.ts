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
  type DepartmentConfig,
  type SupportPanelButtonStyle,
} from './configService';

export interface CustomPanelInput {
  name: string;
  title: string;
  description: string;
  footer?: string;
  color?: string | null;
  thumbnailUrl?: string | null;
  bannerUrl?: string | null;
  buttons: string | unknown;
}

export interface CustomPanelUpdate {
  name?: string;
  title?: string;
  description?: string;
  footer?: string;
  color?: string | null;
  thumbnailUrl?: string | null;
  bannerUrl?: string | null;
  buttons?: string | unknown;
}

function boundedText(value: unknown, name: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(name + ' must be text.');
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > maximum) {
    throw new Error(name + ' must contain ' + (allowEmpty ? '0' : '1') + '–' + maximum + ' characters.');
  }
  return result;
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
  return parsed.toString();
}

export function parseCustomPanelButtons(
  input: string | unknown,
  departments: Record<string, DepartmentConfig>,
): CustomSupportPanelButton[] {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input) as unknown;
    } catch (error) {
      throw new Error('Buttons JSON must be valid JSON.', { cause: error });
    }
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 25) {
    throw new Error('A custom panel needs between 1 and 25 buttons.');
  }

  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Button ' + (index + 1) + ' must be an object.');
    }
    const value = entry as Record<string, unknown>;
    const departmentId = boundedText(value.departmentId, 'Button ' + (index + 1) + ' departmentId', 28);
    if (!departments[departmentId]) {
      throw new Error('Button ' + (index + 1) + ' targets unknown department "' + departmentId + '". Refresh the department list and try again.');
    }
    const label = boundedText(value.label, 'Button ' + (index + 1) + ' label', 80);
    const rawStyle = value.style === undefined ? 'primary' : value.style;
    if (rawStyle !== 'primary' && rawStyle !== 'secondary' && rawStyle !== 'success') {
      throw new Error('Button ' + (index + 1) + ' style must be primary, secondary, or success.');
    }
    let emoji: string | undefined;
    if (value.emoji !== undefined && value.emoji !== null && value.emoji !== '') {
      emoji = boundedText(value.emoji, 'Button ' + (index + 1) + ' emoji', 100);
    }
    return {
      departmentId,
      label,
      style: rawStyle as SupportPanelButtonStyle,
      ...(emoji ? { emoji } : {}),
    };
  });
}

function buildButtons(
  panel: CustomSupportPanel,
  disabled: boolean,
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let start = 0; start < panel.buttons.length; start += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const item of panel.buttons.slice(start, start + 5)) {
      const styles = {
        primary: ButtonStyle.Primary,
        secondary: ButtonStyle.Secondary,
        success: ButtonStyle.Success,
      } as const;
      const button = new ButtonBuilder()
        .setCustomId('ticket:create:' + item.departmentId)
        .setLabel(item.label)
        .setStyle(styles[item.style])
        .setDisabled(disabled);
      if (item.emoji) button.setEmoji(item.emoji);
      row.addComponents(button);
    }
    rows.push(row);
  }
  return rows;
}

export function buildCustomPanelEmbed(
  panel: CustomSupportPanel,
  guildName: string,
  themeColor: number,
  preview = false,
): EmbedBuilder {
  const color = panel.color ? Number.parseInt(panel.color, 16) : themeColor;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(panel.title)
    .setDescription(panel.description)
    .setFooter({ text: panel.footer || 'ResolveX • Customer Support' })
    .setAuthor({ name: guildName + ' • ResolveX Support' })
    .setTimestamp(new Date(panel.updatedAt));
  if (panel.thumbnailUrl) embed.setThumbnail(panel.thumbnailUrl);
  if (panel.bannerUrl) embed.setImage(panel.bannerUrl);
  if (preview) {
    embed.addFields({ name: 'Live Preview', value: 'Draft preview only. Buttons are disabled until this panel is published.' });
  }
  return embed;
}

export function buildCustomPanelComponents(
  panel: CustomSupportPanel,
  preview = false,
): ActionRowBuilder<ButtonBuilder>[] {
  return buildButtons(panel, preview);
}

export async function listCustomPanels(guildId: string): Promise<CustomSupportPanel[]> {
  const config = await getGuildConfig(guildId);
  return Object.values(config.customPanels ?? {}).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getCustomPanel(guildId: string, panelId: string): Promise<CustomSupportPanel | null> {
  const config = await getGuildConfig(guildId);
  return config.customPanels?.[panelId] ?? null;
}

export async function createCustomPanel(
  guildId: string,
  input: CustomPanelInput,
): Promise<CustomSupportPanel> {
  const config = await getGuildConfig(guildId);
  const name = boundedText(input.name, 'Panel name', 80);
  const panel: CustomSupportPanel = {
    id: randomBytes(6).toString('hex'),
    name,
    title: boundedText(input.title, 'Panel title', 256),
    description: boundedText(input.description, 'Panel description', 4000, true),
    footer: input.footer === undefined ? 'ResolveX • Customer Support' : boundedText(input.footer, 'Panel footer', 2048, true),
    color: normalizePanelColor(input.color),
    thumbnailUrl: normalizePanelUrl(input.thumbnailUrl, 'Thumbnail URL'),
    bannerUrl: normalizePanelUrl(input.bannerUrl, 'Banner URL'),
    buttons: parseCustomPanelButtons(input.buttons, config.departments),
    publishedChannelId: null,
    publishedMessageId: null,
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
  const buttons = updates.buttons === undefined
    ? existing.buttons
    : parseCustomPanelButtons(updates.buttons, config.departments);
  const nextName = updates.name === undefined ? existing.name : boundedText(updates.name, 'Panel name', 80);
  await updateGuildConfig(guildId, (current) => {
    current.customPanels ??= {};
    const duplicate = Object.values(current.customPanels).some((other) =>
      other.id !== panelId && other.name.toLocaleLowerCase() === nextName.toLocaleLowerCase(),
    );
    if (duplicate) throw new Error('A panel named "' + nextName + '" already exists in this server.');
    const panel = current.customPanels[panelId];
    if (!panel) throw new Error('This custom panel was removed while it was being edited.');
    current.customPanels[panelId] = {
      ...panel,
      name: nextName,
      title: updates.title === undefined ? panel.title : boundedText(updates.title, 'Panel title', 256),
      description: updates.description === undefined ? panel.description : boundedText(updates.description, 'Panel description', 4000, true),
      footer: updates.footer === undefined ? panel.footer : boundedText(updates.footer, 'Panel footer', 2048, true),
      color: updates.color === undefined ? panel.color : normalizePanelColor(updates.color),
      thumbnailUrl: updates.thumbnailUrl === undefined ? panel.thumbnailUrl : normalizePanelUrl(updates.thumbnailUrl, 'Thumbnail URL'),
      bannerUrl: updates.bannerUrl === undefined ? panel.bannerUrl : normalizePanelUrl(updates.bannerUrl, 'Banner URL'),
      buttons,
      updatedAt: new Date().toISOString(),
    };
  });
  const saved = await getCustomPanel(guildId, panelId);
  if (!saved) throw new Error('Custom panel update could not be read back.');
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
    panel.publishedChannelId = channelId;
    panel.publishedMessageId = messageId;
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
    removed = panel;
    delete current.customPanels[panelId];
  });
  if (!removed) throw new Error('Custom panel could not be deleted.');
  return removed;
}
