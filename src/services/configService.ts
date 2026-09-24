import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type SupportForgeTier = 'free' | 'premium-demo' | 'pro-demo';

export interface DepartmentConfig {
  id: string;
  name: string;
  staffRoleId: string | null;
  categoryId?: string | null;
  createdAt: string;
}

export interface GuildConfig {
  supportCategoryId: string | null;
  panelChannelId: string | null;
  panelMessageId: string | null;
  transcriptChannelId: string | null;
  auditChannelId: string | null;
  tier: SupportForgeTier;
  nextTicketNumber: number;
  departments: Record<string, DepartmentConfig>;
}

interface ConfigFile {
  version: 1;
  guilds: Record<string, GuildConfig>;
}

const DATA_DIR = join(process.cwd(), 'data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG: GuildConfig = {
  supportCategoryId: null,
  panelChannelId: null,
  panelMessageId: null,
  transcriptChannelId: null,
  auditChannelId: null,
  tier: 'free',
  nextTicketNumber: 1000,
  departments: {},
};

let state: ConfigFile | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function cloneDefaultConfig(): GuildConfig {
  return {
    ...DEFAULT_CONFIG,
    departments: {},
  };
}

async function loadState(): Promise<ConfigFile> {
  if (state) return state;

  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ConfigFile;

    state = {
      version: 1,
      guilds: parsed.guilds ?? {},
    };
  } catch {
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

  writeQueue = writeQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify(state, null, 2), 'utf8');
  });

  await writeQueue;
}

export async function getGuildConfig(guildId: string): Promise<GuildConfig> {
  const current = await loadState();
  current.guilds[guildId] ??= cloneDefaultConfig();

  let migrated = false;
  for (const department of Object.values(current.guilds[guildId].departments)) {
    if (department.categoryId === undefined) {
      department.categoryId = null;
      migrated = true;
    }
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

export async function allocateTicketNumber(guildId: string): Promise<number> {
  let allocated = 1000;

  await updateGuildConfig(guildId, (config) => {
    allocated = config.nextTicketNumber;
    config.nextTicketNumber += 1;
    if (config.nextTicketNumber > 999999) {
      config.nextTicketNumber = 1000;
    }
  });

  return allocated;
}


export async function resetConfigState(): Promise<void> {
  await writeQueue.catch(() => undefined);
  state = null;
  writeQueue = Promise.resolve();
}
