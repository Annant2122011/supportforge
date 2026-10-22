import { randomBytes } from 'node:crypto';
import { getJsonDocument, setJsonDocument } from './jsonDocumentPersistenceService';

export type SupportForgeTier = 'free' | 'premium-demo' | 'pro-demo';

export type GuildTheme = 'midnight' | 'cyber-neon' | 'ocean' | 'aurora' | 'ember' | 'forest';

export interface TagConfig {
  id: string;
  name: string;
  createdAt: string;
}

export interface DepartmentConfig {
  id: string;
  name: string;
  staffRoleId: string | null;
  categoryId?: string | null;
  /** Saved private-thread parent channel for this department, created lazily. */
  threadParentChannelId?: string | null;
  /** Tracks which role received Manage Threads on the department parent. */
  threadParentStaffRoleId?: string | null;
  tags: Record<string, TagConfig>;
  createdAt: string;
}

export type SupportPanelButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';
export type CustomSupportPanelTargetType = 'department' | 'form';

export interface CustomSupportPanelButton {
  /** Stable identity. Published messages bind to this ID, never to a mutable array index. */
  id: string;
  targetType: CustomSupportPanelTargetType;
  departmentId: string;
  /** For form-target buttons, identifies the active form version the admin published. */
  formId: string | null;
  formVersion: number | null;
  /** Optional explicit tag. Department buttons may omit this to show the tag picker. */
  tagId: string | null;
  label: string;
  emoji?: string;
  style: SupportPanelButtonStyle;
  confirmationMessage: string | null;
  allowedRoleIds: string[];
}

export interface CustomSupportPanelPublishedConfig {
  title: string;
  description: string;
  footer: string;
  color: string | null;
  iconUrl: string | null;
  thumbnailUrl: string | null;
  bannerUrl: string | null;
  allowedRoleIds: string[];
  buttons: CustomSupportPanelButton[];
}

export interface CustomSupportPanel {
  id: string;
  name: string;
  title: string;
  description: string;
  footer: string;
  color: string | null;
  iconUrl: string | null;
  thumbnailUrl: string | null;
  bannerUrl: string | null;
  allowedRoleIds: string[];
  buttons: CustomSupportPanelButton[];
  publishedChannelId: string | null;
  publishedMessageId: string | null;
  /** Immutable snapshot used by still-published buttons while an unpublished draft is edited. */
  publishedConfig: CustomSupportPanelPublishedConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuildConfig {
  supportCategoryId: string | null;
  openCategoryId: string | null;
  panelChannelId: string | null;
  panelMessageId: string | null;
  transcriptChannelId: string | null;
  auditChannelId: string | null;
  auditDevChannelId: string | null;
  auditDeveloperRoleId: string | null;
  theme: GuildTheme;
  tier: SupportForgeTier;
  nextTicketNumber: number;
  departments: Record<string, DepartmentConfig>;
  retiredCategoryIds: string[];
  managedCategoryIds: string[];
  /** Custom panel definitions are versioned with the existing Neon-backed guild config document. */
  customPanels: Record<string, CustomSupportPanel>;
}

interface ConfigFile {
  version: 1;
  guilds: Record<string, GuildConfig>;
}

const DEFAULT_CONFIG: GuildConfig = {
  supportCategoryId: null,
  openCategoryId: null,
  panelChannelId: null,
  panelMessageId: null,
  transcriptChannelId: null,
  auditChannelId: null,
  auditDevChannelId: null,
  auditDeveloperRoleId: null,
  theme: 'midnight',
  tier: 'free',
  nextTicketNumber: 1000,
  departments: {},
  retiredCategoryIds: [],
  managedCategoryIds: [],
  customPanels: {},
};

let state: ConfigFile | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function normalizeBrandTextDeep<T>(value: T): T {
  if (typeof value === 'string') {
    const legacyBrandAliases = ['Support' + 'Forge', 'Resolve' + 'X', 'Resolv' + 'X', 'SUPPORT' + 'FORGE'];
    const legacyBrandPattern = new RegExp(\\`\\\\b(?:${legacyBrandAliases.join('|')})\\\\b\\`, 'g');
    return value.replace(legacyBrandPattern, 'QueryFixr') as unknown as T;
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

function cloneDefaultConfig(): GuildConfig {
  return {
    ...DEFAULT_CONFIG,
    departments: {},
    retiredCategoryIds: [],
    managedCategoryIds: [],
    customPanels: {},
  };
}

async function loadState(): Promise<ConfigFile> {
  if (state) return state;

  const persisted = await getJsonDocument<ConfigFile>('guild-config');
  if (persisted !== undefined) {
    if (
      !persisted ||
      typeof persisted !== 'object' ||
      !persisted.guilds ||
      typeof persisted.guilds !== 'object' ||
      Array.isArray(persisted.guilds)
    ) {
      throw new Error(
        'QueryFixr database configuration document is malformed. Existing data was not overwritten.',
      );
    }
    const normalizedGuilds = normalizeBrandTextDeep(persisted.guilds) as Record<string, GuildConfig>;
    state = {
      version: 1,
      guilds: normalizedGuilds,
    };
    // Migrate legacy visible brand text in saved panels/configuration without renaming IDs or keys.
    if (JSON.stringify(persisted.guilds) !== JSON.stringify(normalizedGuilds)) await persistState();
    return state;
  }

  state = { version: 1, guilds: {} };
  await persistState();
  return state;
}

async function persistState(): Promise<void> {
  if (!state) return;

  // Capture each queued write at enqueue time so rapid changes cannot make
  // several queued writes accidentally persist different snapshots.
  const snapshot = JSON.parse(JSON.stringify(state)) as ConfigFile;
  writeQueue = writeQueue.catch(() => undefined).then(
    () => setJsonDocument('guild-config', snapshot),
  );
  await writeQueue;
}

export async function getGuildConfig(guildId: string): Promise<GuildConfig> {
  const current = await loadState();
  current.guilds[guildId] ??= cloneDefaultConfig();

  let migrated = false;
  const savedTheme: unknown = (current.guilds[guildId] as { theme?: unknown }).theme;
  if (savedTheme !== 'midnight' && savedTheme !== 'cyber-neon' && savedTheme !== 'ocean' && savedTheme !== 'aurora' && savedTheme !== 'ember' && savedTheme !== 'forest') {
    current.guilds[guildId].theme = 'midnight';
    migrated = true;
  }
  if (
    !current.guilds[guildId].customPanels ||
    typeof current.guilds[guildId].customPanels !== 'object' ||
    Array.isArray(current.guilds[guildId].customPanels)
  ) {
    current.guilds[guildId].customPanels = {};
    migrated = true;
  }
  // Normalize custom-panel drafts written by earlier builder revisions. These
  // stable IDs keep old published buttons from ever being remapped by index.
  for (const [panelId, panel] of Object.entries(current.guilds[guildId].customPanels)) {
    if (!panel || typeof panel !== 'object' || Array.isArray(panel)) {
      delete current.guilds[guildId].customPanels[panelId];
      migrated = true;
      continue;
    }
    const candidate = panel as CustomSupportPanel & Record<string, unknown>;
    const rawButtons = Array.isArray(candidate.buttons) ? candidate.buttons : [];
    const normalizedButtons = rawButtons.filter((button) => button && typeof button === 'object' && !Array.isArray(button))
      .map((button, index) => {
        const item = button as Partial<CustomSupportPanelButton> & Record<string, unknown>;
        const stableId = typeof item.id === 'string' && /^[a-zA-Z0-9_-]{4,20}$/.test(item.id)
          ? item.id
          : 'legacy_' + panelId.slice(0, 6) + '_' + (index + 1);
        const targetType = item.targetType === 'form' && typeof item.formId === 'string' ? 'form' : 'department';
        const roleIds = Array.isArray(item.allowedRoleIds)
          ? item.allowedRoleIds.filter((id): id is string => typeof id === 'string' && /^\\d{17,20}$/.test(id)).slice(0, 25)
          : [];
        return {
          id: stableId,
          targetType,
          departmentId: typeof item.departmentId === 'string' ? item.departmentId : '',
          formId: targetType === 'form' && typeof item.formId === 'string' ? item.formId : null,
          formVersion: targetType === 'form' && Number.isInteger(item.formVersion) ? item.formVersion as number : null,
          tagId: typeof item.tagId === 'string' ? item.tagId : null,
          label: typeof item.label === 'string' ? item.label.slice(0, 80) : 'Start Ticket',
          ...(typeof item.emoji === 'string' && item.emoji ? { emoji: item.emoji.slice(0, 100) } : {}),
          style: item.style === 'secondary' || item.style === 'success' || item.style === 'danger' ? item.style : 'primary',
          confirmationMessage: typeof item.confirmationMessage === 'string' && item.confirmationMessage.trim()
            ? item.confirmationMessage.slice(0, 1000)
            : null,
          allowedRoleIds: [...new Set(roleIds)],
        } satisfies CustomSupportPanelButton;
      });
    const panelRoleIds = Array.isArray(candidate.allowedRoleIds)
      ? candidate.allowedRoleIds.filter((id): id is string => typeof id === 'string' && /^\\d{17,20}$/.test(id)).slice(0, 25)
      : [];
    const iconUrl = typeof candidate.iconUrl === 'string' ? candidate.iconUrl : null;
    const publishedConfig = candidate.publishedConfig && typeof candidate.publishedConfig === 'object'
      ? candidate.publishedConfig as CustomSupportPanel['publishedConfig']
      : null;
    const before = JSON.stringify(candidate);
    current.guilds[guildId].customPanels[panelId] = {
      ...candidate,
      id: typeof candidate.id === 'string' ? candidate.id : panelId,
      name: typeof candidate.name === 'string' ? candidate.name : 'Custom Panel',
      title: typeof candidate.title === 'string' ? candidate.title : 'Customer Support',
      description: typeof candidate.description === 'string' ? candidate.description : '',
      footer: typeof candidate.footer === 'string' ? candidate.footer : 'QueryFixr • Customer Support',
      color: typeof candidate.color === 'string' ? candidate.color : null,
      iconUrl,
      thumbnailUrl: typeof candidate.thumbnailUrl === 'string' ? candidate.thumbnailUrl : null,
      bannerUrl: typeof candidate.bannerUrl === 'string' ? candidate.bannerUrl : null,
      allowedRoleIds: [...new Set(panelRoleIds)],
      buttons: normalizedButtons,
      publishedChannelId: typeof candidate.publishedChannelId === 'string' ? candidate.publishedChannelId : null,
      publishedMessageId: typeof candidate.publishedMessageId === 'string' ? candidate.publishedMessageId : null,
      publishedConfig,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
    };
    if (before !== JSON.stringify(current.guilds[guildId].customPanels[panelId])) migrated = true;
  }
  if (!Array.isArray(current.guilds[guildId].retiredCategoryIds)) {
    current.guilds[guildId].retiredCategoryIds = [];
    migrated = true;
  }
  if (!Array.isArray(current.guilds[guildId].managedCategoryIds)) {
    current.guilds[guildId].managedCategoryIds = [];
    migrated = true;
  }
  if (!Number.isInteger(current.guilds[guildId].nextTicketNumber) || current.guilds[guildId].nextTicketNumber < 1) {
    current.guilds[guildId].nextTicketNumber = DEFAULT_CONFIG.nextTicketNumber;
    migrated = true;
  }

  if (current.guilds[guildId].openCategoryId === undefined) {
    current.guilds[guildId].openCategoryId = null;
    migrated = true;
  }
  if (current.guilds[guildId].auditDevChannelId === undefined) {
    current.guilds[guildId].auditDevChannelId = null;
    migrated = true;
  }
  if (current.guilds[guildId].auditDeveloperRoleId === undefined) {
    current.guilds[guildId].auditDeveloperRoleId = null;
    migrated = true;
  }
  for (const department of Object.values(current.guilds[guildId].departments)) {
    if (department.categoryId === undefined) {
      department.categoryId = null;
      migrated = true;
    }
    if (department.threadParentChannelId === undefined) {
      department.threadParentChannelId = null;
      migrated = true;
    }
    if (department.threadParentStaffRoleId === undefined) {
      department.threadParentStaffRoleId = null;
      migrated = true;
    }
    if (!department.tags || Object.keys(department.tags).length === 0) {
      const tagId = newTagId();
      department.tags = {
        [tagId]: {
          id: tagId,
          name: 'General',
          createdAt: department.createdAt ?? new Date().toISOString(),
        },
      };
      migrated = true;
    }

  }

  const normalizedManagedCategoryIds = Array.from(
    new Set(
      (current.guilds[guildId].managedCategoryIds ?? []).filter(
        (id): id is string =>
          typeof id === 'string' && id.trim().length > 0,
      ),
    ),
  );

  if (
    normalizedManagedCategoryIds.length !==
    (current.guilds[guildId].managedCategoryIds ?? []).length
  ) {
    current.guilds[guildId].managedCategoryIds =
      normalizedManagedCategoryIds;
    migrated = true;
  } else {
    current.guilds[guildId].managedCategoryIds =
      normalizedManagedCategoryIds;
  }

  if (migrated) {
    await persistState();
  }

  return current.guilds[guildId];
}

export async function updateGuildConfig(
  guildId: string,
  updater: (config: GuildConfig) => void,
): Promise<GuildConfig> {
  const config = await getGuildConfig(guildId);
  updater(config);
  await persistState();
  return config;
}

export async function getTier(guildId: string): Promise<SupportForgeTier> {
  return (await getGuildConfig(guildId)).tier;
}

export async function setTier(
  guildId: string,
  tier: SupportForgeTier,
): Promise<void> {
  await updateGuildConfig(guildId, (config) => {
    config.tier = tier;
  });
}

export function isPremiumOrHigher(tier: SupportForgeTier): boolean {
  return tier === 'premium-demo' || tier === 'pro-demo';
}

export function isPro(tier: SupportForgeTier): boolean {
  return tier === 'pro-demo';
}

export function tierLabel(tier: SupportForgeTier): string {
  switch (tier) {
    case 'premium-demo':
      return 'Premium (Demo)';
    case 'pro-demo':
      return 'Pro (Demo)';
    default:
      return 'Free';
  }
}

export function newDepartmentId(): string {
  return randomBytes(4).toString('hex');
}

export function newTagId(): string {
  return randomBytes(4).toString('hex');
}

export async function registerManagedCategory(
  guildId: string,
  categoryId: string,
): Promise<void> {
  const cleanId = categoryId.trim();
  if (!cleanId) return;

  await updateGuildConfig(guildId, (config) => {
    config.managedCategoryIds = Array.from(
      new Set([
        ...(config.managedCategoryIds ?? []),
        cleanId,
      ]),
    );
  });
}

export async function allocateTicketNumber(guildId: string): Promise<number> {
  let allocated = 1000;

  await updateGuildConfig(guildId, (config) => {
    allocated = config.nextTicketNumber;
    config.nextTicketNumber += 1;
  });

  return allocated;
}


export async function resetConfigState(): Promise<void> {
  await writeQueue.catch(() => undefined);
  state = null;
  writeQueue = Promise.resolve();
}
