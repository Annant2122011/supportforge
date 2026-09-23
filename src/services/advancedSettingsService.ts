import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageFlags, type ChatInputCommandInteraction, type Guild } from 'discord.js';

export interface CustomSlashCommand {
  id: string;
  name: string;
  description: string;
  response: string;
  staffOnly: boolean;
  createdAt: string;
}

export interface AdvancedGuildSettings {
  version: 1;
  settingsChannelId: string | null;
  closedCategoryId: string | null;
  archiveCategoryId: string | null;
  billingCategoryId: string | null;
  panelActivity: { enabled: boolean; visualLineBudget: number; messageBudget: number; minimumMessagesBeforeMove: number; };
  retention: { closedDays: number; archiveDays: number; };
  customCommands: Record<string, CustomSlashCommand>;
}

interface SettingsFile { version: 1; guilds: Record<string, AdvancedGuildSettings>; }
const DATA_DIR = join(process.cwd(), 'data');
const SETTINGS_PATH = join(DATA_DIR, 'advanced-settings.json');
const DEFAULTS: AdvancedGuildSettings = {
  version: 1, settingsChannelId: null, closedCategoryId: null, archiveCategoryId: null, billingCategoryId: null,
  panelActivity: { enabled: true, visualLineBudget: 18, messageBudget: 12, minimumMessagesBeforeMove: 6 },
  retention: { closedDays: 30, archiveDays: 0 }, customCommands: {},
};
let state: SettingsFile | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function cloneDefaults(): AdvancedGuildSettings {
  return { ...DEFAULTS, panelActivity: { ...DEFAULTS.panelActivity }, retention: { ...DEFAULTS.retention }, customCommands: {} };
}
async function persist(): Promise<void> {
  if (!state) return;
  writeQueue = writeQueue.then(async () => { await mkdir(DATA_DIR, { recursive: true }); await writeFile(SETTINGS_PATH, JSON.stringify(state, null, 2), 'utf8'); });
  await writeQueue;
}
async function load(): Promise<SettingsFile> {
  if (state) return state;
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SettingsFile>;
    state = { version: 1, guilds: parsed.guilds ?? {} };
  } catch {
    state = { version: 1, guilds: {} };
    await persist();
  }
  return state;
}
export async function getAdvancedSettings(guildId: string): Promise<AdvancedGuildSettings> {
  const current = await load();
  const existing = current.guilds[guildId];
  if (!existing) { current.guilds[guildId] = cloneDefaults(); await persist(); }
  else { existing.panelActivity ??= { ...DEFAULTS.panelActivity }; existing.retention ??= { ...DEFAULTS.retention }; existing.customCommands ??= {}; }
  return current.guilds[guildId];
}
export async function updateAdvancedSettings(guildId: string, updater: (settings: AdvancedGuildSettings) => void): Promise<AdvancedGuildSettings> {
  const settings = await getAdvancedSettings(guildId); updater(settings); await persist(); return settings;
}
export function validateCustomCommandName(name: string): boolean { return /^[a-z0-9_-]{1,32}$/.test(name) && name !== 'supportforge'; }
export async function createCustomSlashCommand(guild: Guild, name: string, description: string, response: string, staffOnly: boolean): Promise<CustomSlashCommand> {
  if (!validateCustomCommandName(name)) throw new Error('Custom command names must use lowercase letters, numbers, hyphens, or underscores and be 1-32 characters.');
  const settings = await getAdvancedSettings(guild.id);
  if (settings.customCommands[name]) throw new Error('A custom command with that name already exists.');
  const command = await guild.commands.create({ name, description: description.slice(0, 100) });
  const record: CustomSlashCommand = { id: command.id, name, description: description.slice(0, 100), response, staffOnly, createdAt: new Date().toISOString() };
  await updateAdvancedSettings(guild.id, (current) => { current.customCommands[name] = record; });
  return record;
}
export async function deleteCustomSlashCommand(guild: Guild, name: string): Promise<boolean> {
  const settings = await getAdvancedSettings(guild.id); const command = settings.customCommands[name]; if (!command) return false;
  await guild.commands.delete(command.id).catch(() => undefined);
  await updateAdvancedSettings(guild.id, (current) => { delete current.customCommands[name]; });
  return true;
}
export async function executeCustomSlashCommand(interaction: ChatInputCommandInteraction, administratorPermission: bigint): Promise<boolean> {
  const settings = await getAdvancedSettings(interaction.guildId); const command = settings.customCommands[interaction.commandName]; if (!command) return false;
  if (command.staffOnly && !interaction.memberPermissions?.has(administratorPermission)) { await interaction.reply({ content: '❌ This custom command is restricted to staff.', flags: MessageFlags.Ephemeral }); return true; }
  await interaction.reply({ content: command.response.slice(0, 2000), flags: MessageFlags.Ephemeral }); return true;
}
export function buildSettingsSummary(settings: AdvancedGuildSettings): string {
  const customCount = Object.keys(settings.customCommands).length;
  const closed = settings.retention.closedDays === 0 ? 'Never delete' : settings.retention.closedDays + ' days';
  const archived = settings.retention.archiveDays === 0 ? 'Never delete' : settings.retention.archiveDays + ' days';
  return ['**Panel activity**', '• Automatic repositioning: ' + (settings.panelActivity.enabled ? 'Enabled' : 'Disabled'), '• Visual budget: ' + settings.panelActivity.visualLineBudget + ' lines', '• Message safety cap: ' + settings.panelActivity.messageBudget + ' messages', '• Minimum messages: ' + settings.panelActivity.minimumMessagesBeforeMove, '', '**Retention**', '• Closed tickets: ' + closed, '• Archived tickets: ' + archived, '', '**Custom slash commands:** ' + customCount].join('\n');
}