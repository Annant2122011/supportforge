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

export interface RetentionApproval {
  scope: 'closed' | 'archive';
  status: 'pending' | 'declined';
  days: number;
  requestedById: string;
  requestedAt: string;
  eligibleChannelIds: string[];
  messageId: string | null;
}

export interface ReportSubcategory {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReportCategory {
  id: string;
  name: string;
  emoji: string;
  subcategories: Record<string, ReportSubcategory>;
}

export type FlagActionType = 'tickets' | 'channel' | 'server';

export interface FlagRule {
  id: string;
  threshold: number;
  action: FlagActionType;
  channelId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdvancedGuildSettings {
  version: 5;
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
    closedEffectiveFrom: string | null;
    archiveEffectiveFrom: string | null;
    pendingApprovals: {
      closed: RetentionApproval | null;
      archive: RetentionApproval | null;
    };
  };
  statusCategories: {
    claimedCategoryId: string | null;
    pendingCategoryId: string | null;
  };
  appearance: {
    panelTitle: string;
    panelDescription: string;
    panelFooter: string;
  };
  ticketDefaults: {
    priority: TicketPriority;
    maxClaimedModerators: number;
  };
  reports: {
    enabled: boolean;
    categories: Record<string, ReportCategory>;
    flagRules: Record<string, FlagRule>;
  };
  /**
   * Optional server roles explicitly created by an administrator for
   * priority-based routing/visibility. No priority role is created by
   * default.
   */
  priorityRoles: Partial<Record<TicketPriority, string>>;
  customTags: Record<string, CustomTag>;
}

interface SettingsFile {
  version: 5;
  guilds: Record<string, AdvancedGuildSettings>;
}

const DATA_DIR = join(process.cwd(), 'data');
const SETTINGS_PATH = join(DATA_DIR, 'advanced-settings.json');

function defaultReportCategories(): Record<string, ReportCategory> {
  const now = new Date().toISOString();
  const definitions: Array<[string, string, string, string[]]> = [
    ['profanity', 'Profanity', '🤬', ['Excessive profanity', 'Slurs or hate speech', 'Sexual profanity']],
    ['harassment', 'Harassment', '🚫', ['Personal attacks', 'Threats or intimidation', 'Targeted harassment']],
    ['inappropriate', 'Inappropriate Content', '⚠️', ['Inappropriate questions', 'Sexual or explicit content', 'Graphic violence']],
    ['off-topic', 'Off-topic Questions', '💬', ['Irrelevant questions', 'Spam or repeated requests', 'Abusive misuse of support']],
  ];
  return Object.fromEntries(definitions.map(([id, name, emoji, subs]) => [
    id,
    {
      id,
      name,
      emoji,
      subcategories: Object.fromEntries(subs.map((name) => {
        const subId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return [subId, { id: subId, name, createdAt: now, updatedAt: now }];
      })),
    },
  ]));
}

const DEFAULTS: AdvancedGuildSettings = {
  version: 5,
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
    closedEffectiveFrom: null,
    archiveEffectiveFrom: null,
    pendingApprovals: {
      closed: null,
      archive: null,
    },
  },
  statusCategories: {
    claimedCategoryId: null,
    pendingCategoryId: null,
  },
  appearance: {
    panelTitle: '🎫 SupportForge Support Center',
    panelDescription:
      'Click a department button below to open a private support ticket.',
    panelFooter: 'SupportForge • Professional Ticket System',
  },
  ticketDefaults: {
    priority: 'normal',
    maxClaimedModerators: 2,
  },
  reports: {
    enabled: true,
    categories: defaultReportCategories(),
    flagRules: {
      'tickets-5': { id: 'tickets-5', threshold: 5, action: 'tickets', channelId: null, enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      'server-10': { id: 'server-10', threshold: 10, action: 'server', channelId: null, enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    },
  },
  priorityRoles: {},
  customTags: {},
};

let state: SettingsFile | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function cloneDefaults(): AdvancedGuildSettings {
  return {
    ...DEFAULTS,
    panelActivity: { ...DEFAULTS.panelActivity },
    retention: {
      ...DEFAULTS.retention,
      pendingApprovals: {
        ...DEFAULTS.retention.pendingApprovals,
      },
    },
    statusCategories: { ...DEFAULTS.statusCategories },
    appearance: { ...DEFAULTS.appearance },
    ticketDefaults: { ...DEFAULTS.ticketDefaults },
    reports: {
      ...DEFAULTS.reports,
      categories: Object.fromEntries(
        Object.entries(DEFAULTS.reports.categories).map(([id, category]) => [
          id,
          {
            ...category,
            subcategories: Object.fromEntries(
              Object.entries(category.subcategories).map(([subId, subcategory]) => [
                subId,
                { ...subcategory },
              ]),
            ),
          },
        ]),
      ),
      flagRules: { ...DEFAULTS.reports.flagRules },
    },
    priorityRoles: { ...DEFAULTS.priorityRoles },
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
      version: 5,
      guilds: parsed.guilds ?? {},
    };
  } catch {
    state = {
      version: 5,
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
    version: 5,
    panelActivity: {
      ...DEFAULTS.panelActivity,
      ...(settings.panelActivity ?? {}),
    },
    retention: {
      ...DEFAULTS.retention,
      ...(settings.retention ?? {}),
      pendingApprovals: {
        ...DEFAULTS.retention.pendingApprovals,
        ...(settings.retention?.pendingApprovals ?? {}),
      },
    },
    statusCategories: {
      ...DEFAULTS.statusCategories,
      ...(settings.statusCategories ?? {}),
    },
    appearance: {
      ...DEFAULTS.appearance,
      ...(settings.appearance ?? {}),
    },
    ticketDefaults: {
      ...DEFAULTS.ticketDefaults,
      ...(settings.ticketDefaults ?? {}),
      maxClaimedModerators: Math.min(3, Math.max(1, Number(settings.ticketDefaults?.maxClaimedModerators ?? DEFAULTS.ticketDefaults.maxClaimedModerators) || 2)),
    },
    reports: {
      ...DEFAULTS.reports,
      ...(settings.reports ?? {}),
      categories: settings.reports?.categories && Object.keys(settings.reports.categories).length
        ? settings.reports.categories
        : defaultReportCategories(),
      flagRules: settings.reports?.flagRules && Object.keys(settings.reports.flagRules).length
        ? settings.reports.flagRules
        : { ...DEFAULTS.reports.flagRules },
    },
    priorityRoles: {
      ...DEFAULTS.priorityRoles,
      ...(settings.priorityRoles ?? {}),
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
      ? 'Unlimited'
      : settings.retention.closedDays + ' days';

  const archived =
    settings.retention.archiveDays === 0
      ? 'Unlimited'
      : settings.retention.archiveDays + ' days';

  const claimedCategory = settings.statusCategories.claimedCategoryId
    ? 'Configured'
    : 'Not configured';
  const pendingCategory = settings.statusCategories.pendingCategoryId
    ? 'Configured'
    : 'Not configured';

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
    '• Maximum simultaneous moderators per ticket: ' + settings.ticketDefaults.maxClaimedModerators,
    '',
    '**🛡️ Reports & flags**',
    '• Reporting: ' + (settings.reports.enabled ? 'Enabled' : 'Disabled'),
    '• Categories: ' + Object.keys(settings.reports.categories).length,
    '• Flag rules: ' + Object.keys(settings.reports.flagRules).length,
    '',
    '**🎨 Priority roles**',
    '• Explicitly created roles: ' + Object.keys(settings.priorityRoles).length,
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
    '',
    '**🗂️ Optional status categories**',
    '• Claimed tickets: ' + claimedCategory,
    '• Pending tickets: ' + pendingCategory,
  ].join('\n');
}

export async function resetAdvancedSettings(): Promise<void> {
  state = {
    version: 5,
    guilds: {},
  };
  await persist();
}

export async function resetAdvancedSettingsState(): Promise<void> {
  await writeQueue.catch(() => undefined);
  state = null;
  writeQueue = Promise.resolve();
}
