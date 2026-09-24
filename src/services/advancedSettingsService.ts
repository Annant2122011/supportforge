import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Guild } from 'discord.js';

export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent' | 'critical';

export interface CustomTag {
  id: string;
  name: string;
  emoji: string;
  description: string;
  createdAt: string;
}

export interface AdvancedGuildSettings {
  version: 2;
  settingsChannelId: string | null;
  closedCategoryId: string | null;
  archiveCategoryId: string | null;
  panelActivity: {
    enabled: boolean;
    visualLineBudget: number;
    messageBudget: number;
    minimumMessagesBeforeMove: number;
  };
  retention: {
    closedDays: number;
    archiveDays: number;
  };
  appearance: {
    panelTitle: string;
    panelDescription: string;
    panelFooter: string;
  };
  ticketDefaults: {
    priority: TicketPriority;
  };
  customTags: Record<string, CustomTag>;
}

interface SettingsFile {
  version: 2;
  guilds: Record<string, AdvancedGuildSettings>;
}

const DATA_DIR = join(process.cwd(), 'data');
const SETTINGS_PATH = join(DATA_DIR, 'advanced-settings.json');

const DEFAULTS: AdvancedGuildSettings = {
  version: 2,
  settingsChannelId: null,
  closedCategoryId: null,
  archiveCategoryId: null,
  panelActivity: {
    enabled: true,
    visualLineBudget: 18,
    messageBudget: 12,
    minimumMessagesBeforeMove: 6,
  },
  retention: {
    closedDays: 0,
    archiveDays: 0,
  },
  appearance: {
    panelTitle: '🎫 SupportForge Support Center',
    panelDescription:
      'Click a department button below to open a private support ticket.',
    panelFooter: 'SupportForge • Professional Ticket System',
  },
  ticketDefaults: {
    priority: 'normal',
  },
  customTags: {},
};

let state: SettingsFile | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function cloneDefaults(): AdvancedGuildSettings {
  return {
    ...DEFAULTS,
    panelActivity: { ...DEFAULTS.panelActivity },
    retention: { ...DEFAULTS.retention },
    appearance: { ...DEFAULTS.appearance },
    ticketDefaults: { ...DEFAULTS.ticketDefaults },
    customTags: {},
  };
}

async function persist(): Promise<void> {
  if (!state) return;

  writeQueue = writeQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(
      SETTINGS_PATH,
      JSON.stringify(state, null, 2),
      'utf8',
    );
  });

  await writeQueue;
}

async function load(): Promise<SettingsFile> {
  if (state) return state;

  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SettingsFile>;

    state = {
      version: 2,
      guilds: parsed.guilds ?? {},
    };
  } catch {
    state = {
      version: 2,
      guilds: {},
    };

    await persist();
  }

  return state;
}

function normalizeExistingSettings(
  settings: Partial<AdvancedGuildSettings>,
): AdvancedGuildSettings {
  return {
    ...cloneDefaults(),
    ...settings,
    version: 2,
    panelActivity: {
      ...DEFAULTS.panelActivity,
      ...(settings.panelActivity ?? {}),
    },
    retention: {
      ...DEFAULTS.retention,
      ...(settings.retention ?? {}),
    },
    appearance: {
      ...DEFAULTS.appearance,
      ...(settings.appearance ?? {}),
    },
    ticketDefaults: {
      ...DEFAULTS.ticketDefaults,
      ...(settings.ticketDefaults ?? {}),
    },
    customTags: {
      ...(settings.customTags ?? {}),
    },
  };
}

export async function getAdvancedSettings(
  guildId: string,
): Promise<AdvancedGuildSettings> {
  const current = await load();
  const existing = current.guilds[guildId];

  if (!existing) {
    current.guilds[guildId] = cloneDefaults();
    await persist();
  } else {
    current.guilds[guildId] = normalizeExistingSettings(existing);
  }

  return current.guilds[guildId];
}

export async function updateAdvancedSettings(
  guildId: string,
  updater: (settings: AdvancedGuildSettings) => void,
): Promise<AdvancedGuildSettings> {
  const settings = await getAdvancedSettings(guildId);
  updater(settings);
  await persist();
  return settings;
}

export function normalizeTagName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 32);
}

export async function addCustomTag(
  guildId: string,
  name: string,
  emoji = '🏷️',
  description = '',
): Promise<CustomTag> {
  const normalized = normalizeTagName(name);

  if (!normalized) {
    throw new Error('Tag name cannot be empty.');
  }

  const settings = await getAdvancedSettings(guildId);

  if (settings.customTags[normalized]) {
    throw new Error('A tag with that name already exists.');
  }

  const tag: CustomTag = {
    id: normalized,
    name: normalized,
    emoji: emoji.trim().slice(0, 4) || '🏷️',
    description: description.trim().slice(0, 100),
    createdAt: new Date().toISOString(),
  };

  await updateAdvancedSettings(guildId, (current) => {
    current.customTags[normalized] = tag;
  });

  return tag;
}

export async function removeCustomTag(
  guildId: string,
  tagId: string,
): Promise<boolean> {
  const settings = await getAdvancedSettings(guildId);
  if (!settings.customTags[tagId]) return false;

  await updateAdvancedSettings(guildId, (current) => {
    delete current.customTags[tagId];
  });

  return true;
}

export async function removeLegacyCustomCommands(guild: Guild): Promise<void> {
  const current = await load();
  const raw = current.guilds[guild.id] as (AdvancedGuildSettings & {
    customCommands?: Record<string, { id: string }>;
  }) | undefined;

  const legacy = raw?.customCommands;
  if (!legacy) return;

  for (const command of Object.values(legacy)) {
    await guild.commands.delete(command.id).catch(() => undefined);
  }

  delete raw.customCommands;
  await persist();
}

export function buildSettingsSummary(
  settings: AdvancedGuildSettings,
): string {
  const closed =
    settings.retention.closedDays === 0
      ? 'Never delete'
      : settings.retention.closedDays + ' days';

  const archived =
    settings.retention.archiveDays === 0
      ? 'Never delete'
      : settings.retention.archiveDays + ' days';

  const tags = Object.values(settings.customTags);

  return [
    '**🎛️ Panel**',
    '• Automatic repositioning: ' +
      (settings.panelActivity.enabled ? 'Enabled' : 'Disabled'),
    '• Visual budget: ' +
      settings.panelActivity.visualLineBudget +
      ' lines',
    '• Message safety cap: ' +
      settings.panelActivity.messageBudget,
    '',
    '**🎟️ Ticket defaults**',
    '• Default priority: ' + settings.ticketDefaults.priority,
    '',
    '**🏷️ Custom tags**',
    '• Configured tags: ' + tags.length,
    tags.length
      ? '• ' +
        tags
          .slice(0, 6)
          .map((tag) => tag.emoji + ' ' + tag.name)
          .join(' • ')
      : '• No custom tags configured',
    '',
    '**🧹 Retention**',
    '• Closed: ' + closed,
    '• Archived: ' + archived,
  ].join('\n');
}
