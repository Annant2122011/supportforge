import type { Guild } from 'discord.js';
import { normalizeDiscordEmoji } from '../core/domain/discordEmoji';
import { normalizeInactivityExemptionIds } from '../core/domain/ticketInactivityExemptions';
import { getJsonDocument, setJsonDocument } from './jsonDocumentPersistenceService';
import { resolveLocale, type SupportedLocale } from '../i18n/localeRegistry';

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

export const SETTINGS_DASHBOARD_BUTTON_KEYS = [
  // Core ticket experience first, then routing and server policy.
  'panel', 'panels', 'forms', 'defaults', 'tags',
  'usecases', 'support-hours', 'ticket-workspace', 'inactivity', 'reports', 'analytics',
  // Appearance/team operations, then recovery and administration.
  'team', 'retention', 'appearance', 'theme', 'dashboard-builder',
  'storage', 'rules', 'repair', 'premium', 'manual',
  'refresh', 'reset',
] as const;

/**
 * Exact pre-inactivity default order persisted by older releases. Only this
 * untouched default migrates to the new grouped layout; any custom ordering
 * is preserved and newly introduced buttons are appended safely.
 */
const LEGACY_DEFAULT_SETTINGS_BUTTON_ORDER = [
  'panel', 'defaults', 'tags', 'usecases', 'reports', 'retention', 'appearance',
  'storage', 'rules', 'repair', 'team', 'manual', 'forms', 'refresh', 'reset',
  'theme', 'premium', 'panels', 'dashboard-builder', 'support-hours', 'ticket-workspace',
] as const;

export function normalizeSettingsDashboardButtonOrder(rawOrderInput: unknown): SettingsDashboardButtonKey[] {
  const rawOrder = Array.isArray(rawOrderInput) ? rawOrderInput : [];
  const validOrder = rawOrder.filter((key): key is SettingsDashboardButtonKey =>
    typeof key === 'string' && (SETTINGS_DASHBOARD_BUTTON_KEYS as readonly string[]).includes(key),
  );
  const uniqueOrder = [...new Set(validOrder)];
  const isUncustomizedLegacyDefault =
    rawOrder.length === LEGACY_DEFAULT_SETTINGS_BUTTON_ORDER.length &&
    rawOrder.every((key, index) => key === LEGACY_DEFAULT_SETTINGS_BUTTON_ORDER[index]);
  // Upgrade only the exact legacy default. A server's custom order is
  // user data and must never be silently rearranged by a UI upgrade.
  const normalizedOrder: SettingsDashboardButtonKey[] = isUncustomizedLegacyDefault
    ? [...SETTINGS_DASHBOARD_BUTTON_KEYS]
    : uniqueOrder;
  for (const key of SETTINGS_DASHBOARD_BUTTON_KEYS) {
    if (!normalizedOrder.includes(key)) normalizedOrder.push(key);
  }
  return normalizedOrder;
}

export type SettingsDashboardButtonKey = (typeof SETTINGS_DASHBOARD_BUTTON_KEYS)[number];

export interface SettingsDashboardButtonCustomization {
  label: string;
  /** Null intentionally removes the default emoji. */
  emoji: string | null;
}

export interface SettingsDashboardSettings {
  title: string;
  description: string;
  footer: string;
  buttonOrder: SettingsDashboardButtonKey[];
  buttonCustomizations: Partial<Record<SettingsDashboardButtonKey, SettingsDashboardButtonCustomization>>;
}

export interface AdvancedGuildSettings {
  version: 5;
  /** Per-server default language. Older documents normalise to en-US without a database migration. */
  locale: SupportedLocale;
  settingsChannelId: string | null;
  closedCategoryId: string | null;
  archiveCategoryId: string | null;
  panelActivity: {
    enabled: boolean;
    visualLineBudget: number;
    messageBudget: number;
    minimumMessagesBeforeMove: number;
  };
  /** Explicitly opt-in, restart-safe auto-close policy for idle tickets. */
  inactivity: {
    enabled: boolean;
    idleHours: number;
    graceHours: number;
    /** Increments when policy toggles, thresholds, or exemption lists change. */
    generation: number;
    /** Roles held by a ticket owner or assigned staff member exempt the ticket from inactivity closure. */
    exemptRoleIds: string[];
    /** Department IDs that never use automatic inactivity closure. */
    exemptDepartmentIds: string[];
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
  /** Per-server ticket resource choice; text channels remain the backward-compatible default. */
  ticketWorkspace: { mode: 'text-channels' | 'private-threads' };
  /** Per-server Settings-channel branding and button order; essential controls are never hidden. */
  settingsDashboard: SettingsDashboardSettings;
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
  locale: 'en-US',
  settingsChannelId: null,
  closedCategoryId: null,
  archiveCategoryId: null,
  panelActivity: {
    enabled: true,
    visualLineBudget: 18,
    messageBudget: 12,
    minimumMessagesBeforeMove: 6,
  },
  inactivity: {
    enabled: false,
    idleHours: 72,
    graceHours: 24,
    generation: 1,
    exemptRoleIds: [],
    exemptDepartmentIds: [],
  },
  retention: {
    closedDays: 180,
    archiveDays: 180,
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
    panelTitle: '🎫 ResolvX Support Center',
    panelDescription:
      'Click a department button below to open a private support ticket.',
    panelFooter: 'ResolvX • Professional Ticket System',
  },
  ticketWorkspace: { mode: 'text-channels' },
  settingsDashboard: {
    title: '⚙️ ResolvX Settings',
    description: 'Configure your server’s ticket system, support panels and retention policies.',
    footer: 'ResolvX • Settings Dashboard',
    buttonOrder: [...SETTINGS_DASHBOARD_BUTTON_KEYS],
    buttonCustomizations: {},
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

function normalizeBrandTextDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/\b(?:SupportForge|ResolveX|SUPPORTFORGE)\b/g, 'ResolvX') as unknown as T;
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeBrandTextDeep(entry)) as unknown as T;
  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      normalized[key] = normalizeBrandTextDeep(entry);
    }
    return normalized as unknown as T;
  }
  return value;
}

function cloneDefaults(): AdvancedGuildSettings {
  return {
    ...DEFAULTS,
    panelActivity: { ...DEFAULTS.panelActivity },
    inactivity: { ...DEFAULTS.inactivity, exemptRoleIds: [...DEFAULTS.inactivity.exemptRoleIds], exemptDepartmentIds: [...DEFAULTS.inactivity.exemptDepartmentIds] },
    retention: {
      ...DEFAULTS.retention,
      pendingApprovals: {
        ...DEFAULTS.retention.pendingApprovals,
      },
    },
    statusCategories: { ...DEFAULTS.statusCategories },
    appearance: { ...DEFAULTS.appearance },
    settingsDashboard: {
      ...DEFAULTS.settingsDashboard,
      buttonOrder: [...DEFAULTS.settingsDashboard.buttonOrder],
      buttonCustomizations: {},
    },
    ticketWorkspace: { ...DEFAULTS.ticketWorkspace },
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

  const snapshot = JSON.parse(JSON.stringify(state)) as SettingsFile;
  writeQueue = writeQueue.catch(() => undefined).then(
    () => setJsonDocument('advanced-settings', snapshot),
  );
  await writeQueue;
}

async function load(): Promise<SettingsFile> {
  if (state) return state;

  const persisted = await getJsonDocument<Partial<SettingsFile>>('advanced-settings');
  if (persisted !== undefined) {
    if (
      !persisted ||
      typeof persisted !== 'object' ||
      !persisted.guilds ||
      typeof persisted.guilds !== 'object' ||
      Array.isArray(persisted.guilds)
    ) {
      throw new Error(
        'ResolvX advanced settings database document is malformed. Existing data was not overwritten.',
      );
    }
    const normalizedGuilds = normalizeBrandTextDeep(persisted.guilds) as Record<string, AdvancedGuildSettings>;
    state = { version: 5, guilds: normalizedGuilds };
    // Normalize previously saved visible labels/footers while preserving setting keys and structure.
    if (JSON.stringify(persisted.guilds) !== JSON.stringify(normalizedGuilds)) await persist();
    return state;
  }

  state = { version: 5, guilds: {} };
  await persist();
  return state;
}

function normalizeRetentionDays(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(365, Math.max(0, parsed));
}

function normalizeBoundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeExistingSettings(
  settings: Partial<AdvancedGuildSettings>,
): AdvancedGuildSettings {
  return {
    ...cloneDefaults(),
    ...settings,
    version: 5,
    locale: resolveLocale(settings.locale),
    panelActivity: {
      ...DEFAULTS.panelActivity,
      ...(settings.panelActivity ?? {}),
    },
    inactivity: {
      ...DEFAULTS.inactivity,
      ...(settings.inactivity ?? {}),
      enabled: settings.inactivity?.enabled === true,
      idleHours: normalizeBoundedInteger(settings.inactivity?.idleHours, DEFAULTS.inactivity.idleHours, 1, 720),
      graceHours: normalizeBoundedInteger(settings.inactivity?.graceHours, DEFAULTS.inactivity.graceHours, 1, 168),
      generation: normalizeBoundedInteger(settings.inactivity?.generation, DEFAULTS.inactivity.generation, 1, 2147483647),
      exemptRoleIds: normalizeInactivityExemptionIds(settings.inactivity?.exemptRoleIds),
      exemptDepartmentIds: normalizeInactivityExemptionIds(settings.inactivity?.exemptDepartmentIds),
    },
    retention: {
      ...DEFAULTS.retention,
      ...(settings.retention ?? {}),
      closedDays: normalizeRetentionDays(
        settings.retention?.closedDays,
        DEFAULTS.retention.closedDays,
      ),
      archiveDays: normalizeRetentionDays(
        settings.retention?.archiveDays,
        DEFAULTS.retention.archiveDays,
      ),
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
    ticketWorkspace: {
      mode: settings.ticketWorkspace?.mode === 'private-threads' ? 'private-threads' : 'text-channels',
    },
    settingsDashboard: (() => {
      const saved = settings.settingsDashboard;
      const rawOrder = Array.isArray(saved?.buttonOrder) ? saved.buttonOrder : [];
      const normalizedOrder = normalizeSettingsDashboardButtonOrder(rawOrder);
      const text = (value: unknown, fallback: string, max: number): string =>
        typeof value === 'string' ? value.trim().slice(0, max) : fallback;
      const rawCustomizations = saved?.buttonCustomizations && typeof saved.buttonCustomizations === 'object' &&
        !Array.isArray(saved.buttonCustomizations)
        ? saved.buttonCustomizations as Record<string, unknown>
        : {};
      const buttonCustomizations: SettingsDashboardSettings['buttonCustomizations'] = {};
      for (const key of SETTINGS_DASHBOARD_BUTTON_KEYS) {
        const candidate = rawCustomizations[key];
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const value = candidate as Record<string, unknown>;
        const label = text(value.label, '', 80);
        let emoji: string | null;
        if (value.emoji === null) {
          emoji = null;
        } else {
          try {
            emoji = normalizeDiscordEmoji(value.emoji, 'Settings dashboard button emoji') ?? null;
          } catch {
            // Bad legacy customization must not prevent the Settings dashboard
            // from rendering after a restart.
            continue;
          }
        }
        if (label) buttonCustomizations[key] = { label, emoji };
      }
      return {
        title: text(saved?.title, DEFAULTS.settingsDashboard.title, 256) || DEFAULTS.settingsDashboard.title,
        description: text(saved?.description, DEFAULTS.settingsDashboard.description, 4000),
        footer: text(saved?.footer, DEFAULTS.settingsDashboard.footer, 2048) || DEFAULTS.settingsDashboard.footer,
        buttonOrder: normalizedOrder,
        buttonCustomizations,
      };
    })(),
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

/** Read the resolved default language for one guild. */
export async function getGuildLocale(guildId: string): Promise<SupportedLocale> {
  return (await getAdvancedSettings(guildId)).locale;
}

/** Persist a validated locale in the existing Neon-backed advanced-settings document. */
export async function setGuildLocale(guildId: string, locale: SupportedLocale): Promise<AdvancedGuildSettings> {
  return updateAdvancedSettings(guildId, (settings) => {
    settings.locale = resolveLocale(locale);
  });
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
    '**⏳ Inactivity Automation**',
    '• Auto-close: ' + (settings.inactivity.enabled ? 'Enabled' : 'Disabled'),
    '• Warning after: ' + settings.inactivity.idleHours + ' hours',
    '• Grace period: ' + settings.inactivity.graceHours + ' hours',
    '',
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
