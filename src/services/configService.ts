import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type SupportForgeTier = 'free' | 'premium-demo' | 'pro-demo';

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
  tags: Record<string, TagConfig>;
  createdAt: string;
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
  tier: SupportForgeTier;
  nextTicketNumber: number;
  departments: Record<string, DepartmentConfig>;
  retiredCategoryIds: string[];
  managedCategoryIds: string[];
}

interface ConfigFile {
  version: 1;
  guilds: Record<string, GuildConfig>;
}

const DATA_DIR = join(process.cwd(), 'data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG: GuildConfig = {
  supportCategoryId: null,
  openCategoryId: null,
  panelChannelId: null,
  panelMessageId: null,
  transcriptChannelId: null,
  auditChannelId: null,
  auditDevChannelId: null,
  auditDeveloperRoleId: null,
  tier: 'free',
  nextTicketNumber: 1000,
  departments: {},
  retiredCategoryIds: [],
  managedCategoryIds: [],
};

let state: ConfigFile | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function cloneDefaultConfig(): GuildConfig {
  return {
    ...DEFAULT_CONFIG,
    departments: {},
    retiredCategoryIds: [],
    managedCategoryIds: [],
  };
}

async function loadState(): Promise<ConfigFile> {
  if (state) return state;

  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ConfigFile;

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.guilds ||
      typeof parsed.guilds !== 'object' ||
      Array.isArray(parsed.guilds)
    ) {
      throw new Error(
        'SupportForge config is malformed: the guild configuration collection is invalid.',
      );
    }

    state = {
      version: 1,
      guilds: parsed.guilds as Record<string, GuildConfig>,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(
        'SupportForge config could not be loaded safely. The existing file was not replaced.',
        { cause: error },
      );
    }

    state = {
      version: 1,
      guilds: {},
    };
    await persistState();
  }

  return state;
}

async function persistState(): Promise<void> {
  if (!state) return;

  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    await mkdir(DATA_DIR, { recursive: true });

    const temporaryPath =
      CONFIG_PATH + '.tmp-' + process.pid + '-' + Date.now();

    await writeFile(
      temporaryPath,
      JSON.stringify(state, null, 2),
      'utf8',
    );

    try {
      try {
        await rename(temporaryPath, CONFIG_PATH);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM') throw error;

        await unlink(CONFIG_PATH).catch((unlinkError) => {
          const unlinkCode = (unlinkError as NodeJS.ErrnoException).code;
          if (unlinkCode !== 'ENOENT') throw unlinkError;
        });
        await rename(temporaryPath, CONFIG_PATH);
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  });

  await writeQueue;
}

export async function getGuildConfig(guildId: string): Promise<GuildConfig> {
  const current = await loadState();
  current.guilds[guildId] ??= cloneDefaultConfig();

  let migrated = false;
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
