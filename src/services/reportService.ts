import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PermissionFlagsBits,
  type Guild,
} from 'discord.js';
import {
  getAdvancedSettings,
  type FlagRule,
} from './advancedSettingsService';
import { getGuildConfig } from './configService';
import { logTicketEvent } from './auditLogService';

export interface StoredReport {
  id: string;
  guildId: string;
  targetUserId: string;
  reporterUserId: string;
  reporterName: string;
  categoryId: string;
  categoryName: string;
  subcategoryId: string;
  subcategoryName: string;
  description: string;
  flagged: boolean;
  ticketNumber?: string;
  channelId?: string;
  createdAt: string;
}

interface ReportGuildStore {
  reports: StoredReport[];
  flagCounts: Record<string, number>;
  appliedRules: Record<string, string[]>;
  ticketRestrictedUsers: string[];
}

interface ReportStore {
  version: 1;
  guilds: Record<string, ReportGuildStore>;
}

const DATA_DIR = join(process.cwd(), 'data');
const REPORT_PATH = join(DATA_DIR, 'reports.json');

let state: ReportStore | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function emptyGuildStore(): ReportGuildStore {
  return {
    reports: [],
    flagCounts: {},
    appliedRules: {},
    ticketRestrictedUsers: [],
  };
}

async function persist(): Promise<void> {
  if (!state) return;
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(REPORT_PATH, JSON.stringify(state, null, 2), 'utf8');
  });
  await writeQueue;
}

async function load(): Promise<ReportStore> {
  if (state) return state;
  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(REPORT_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ReportStore>;
    const guilds: Record<string, ReportGuildStore> = {};

    for (const [guildId, rawStore] of Object.entries(parsed.guilds ?? {})) {
      const store = rawStore as Partial<ReportGuildStore>;
      guilds[guildId] = {
        reports: Array.isArray(store.reports) ? store.reports : [],
        flagCounts: store.flagCounts ?? {},
        appliedRules: store.appliedRules ?? {},
        ticketRestrictedUsers: Array.isArray(store.ticketRestrictedUsers)
          ? store.ticketRestrictedUsers
          : [],
      };
    }

    state = { version: 1, guilds };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(
        'SupportForge report data could not be loaded safely. The existing file was not replaced.',
        { cause: error },
      );
    }

    state = { version: 1, guilds: {} };
    await persist();
  }

  return state;
}

function getGuildStore(current: ReportStore, guildId: string): ReportGuildStore {
  current.guilds[guildId] ??= emptyGuildStore();
  return current.guilds[guildId];
}

export async function getUserFlagCount(guildId: string, userId: string): Promise<number> {
  const current = await load();
  return getGuildStore(current, guildId).flagCounts[userId] ?? 0;
}

export async function isTicketCreationRestricted(guildId: string, userId: string): Promise<boolean> {
  const current = await load();
  return getGuildStore(current, guildId).ticketRestrictedUsers.includes(userId);
}

async function applyFlagRule(
  guild: Guild,
  targetUserId: string,
  rule: FlagRule,
  sourceChannelId?: string,
): Promise<boolean> {
  const current = await load();
  const store = getGuildStore(current, guild.id);
  const applied = store.appliedRules[targetUserId] ?? [];

  if (applied.includes(rule.id)) return true;

  let succeeded = false;

  if (rule.action === 'tickets') {
    if (!store.ticketRestrictedUsers.includes(targetUserId)) {
      store.ticketRestrictedUsers.push(targetUserId);
    }
    succeeded = true;
  } else if (rule.action === 'channel') {
    const channelId = rule.channelId ?? sourceChannelId;
    const channel = channelId ? guild.channels.cache.get(channelId) : undefined;

    if (!channel || !('permissionOverwrites' in channel)) {
      console.warn(
        '⚠️ Report channel restriction could not run because the target channel was not found.',
      );
      return false;
    }

    try {
      await channel.permissionOverwrites.edit(targetUserId, {
        ViewChannel: false,
        SendMessages: false,
        ReadMessageHistory: false,
        AddReactions: false,
      }, {
        reason: 'SupportForge automatic report flag restriction',
      });
      succeeded = true;
    } catch (error) {
      console.warn('⚠️ Could not apply report channel restriction:', error);
      return false;
    }
  } else if (rule.action === 'server') {
    try {
      await guild.members.ban(targetUserId, {
        deleteMessageSeconds: 0,
        reason: 'SupportForge automatic report flag threshold reached',
      });
      succeeded = true;
    } catch (error) {
      console.warn('⚠️ Could not apply automatic SupportForge server ban:', error);
      return false;
    }
  }

  if (!succeeded) return false;

  applied.push(rule.id);
  store.appliedRules[targetUserId] = applied;
  await persist();

  const config = await getGuildConfig(guild.id);
  if (config.supportCategoryId) {
    await logTicketEvent(guild, config.supportCategoryId, {
      ticketNumber: 'report',
      event: 'report_automatic_action',
      actor: 'SupportForge',
      detail:
        'Automatic flag rule reached: ' +
        rule.action +
        ' at ' +
        rule.threshold +
        ' flag(s) for <@' +
        targetUserId +
        '>.',
    }).catch(() => undefined);
  }

  return true;
}

export async function recordReport(
  guild: Guild,
  input: {
    targetUserId: string;
    reporterUserId: string;
    reporterName: string;
    categoryId: string;
    subcategoryId: string;
    description?: string;
    flagged: boolean;
    channelId?: string;
    ticketNumber?: string;
  },
): Promise<{ report: StoredReport; flagCount: number; appliedRules: FlagRule[] }> {
  const settings = await getAdvancedSettings(guild.id);
  if (!settings.reports.enabled) {
    throw new Error('Reporting is currently disabled.');
  }

  const category = settings.reports.categories[input.categoryId];
  const subcategory = category?.subcategories[input.subcategoryId];

  if (!category || !subcategory) {
    throw new Error('The selected report category is no longer configured.');
  }

  const current = await load();
  const store = getGuildStore(current, guild.id);

  const report: StoredReport = {
    id: 'report-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    guildId: guild.id,
    targetUserId: input.targetUserId,
    reporterUserId: input.reporterUserId,
    reporterName: input.reporterName,
    categoryId: category.id,
    categoryName: category.name,
    subcategoryId: subcategory.id,
    subcategoryName: subcategory.name,
    description: (input.description ?? '').slice(0, 500),
    flagged: input.flagged,
    ticketNumber: input.ticketNumber,
    channelId: input.channelId,
    createdAt: new Date().toISOString(),
  };

  store.reports.push(report);

  if (input.flagged) {
    store.flagCounts[input.targetUserId] =
      (store.flagCounts[input.targetUserId] ?? 0) + 1;
  }

  await persist();

  const flagCount = store.flagCounts[input.targetUserId] ?? 0;
  const appliedRules: FlagRule[] = [];

  if (input.flagged) {
    const rules = Object.values(settings.reports.flagRules)
      .filter((rule) => rule.enabled)
      .sort((a, b) => a.threshold - b.threshold);

    for (const rule of rules) {
      if (flagCount >= rule.threshold) {
        const alreadyApplied = (store.appliedRules[input.targetUserId] ?? []).includes(rule.id);
        if (!alreadyApplied) {
          if (await applyFlagRule(guild, input.targetUserId, rule, input.channelId)) {
            appliedRules.push(rule);
          }
        }
      }
    }
  }

  const config = await getGuildConfig(guild.id);
  if (config.supportCategoryId) {
    await logTicketEvent(guild, config.supportCategoryId, {
      ticketNumber: input.ticketNumber ?? 'report',
      event: input.flagged ? 'user_report_flagged' : 'user_report_recorded',
      actor: input.reporterName,
      actorId: input.reporterUserId,
      detail:
        'Reported <@' + input.targetUserId + '> • ' +
        category.name + ' / ' + subcategory.name +
        (input.description ? ' • ' + input.description : '') +
        ' • flag count: ' + flagCount,
    }).catch(() => undefined);
  }

  return { report, flagCount, appliedRules };
}

export async function getReportSummary(
  guildId: string,
  userId: string,
): Promise<{ count: number; flagged: number }> {
  const current = await load();
  const reports = getGuildStore(current, guildId).reports.filter(
    (report) => report.targetUserId === userId,
  );
  return {
    count: reports.length,
    flagged: reports.filter((report) => report.flagged).length,
  };
}

export async function resetReportState(): Promise<void> {
  state = { version: 1, guilds: {} };
  await persist();
}

export async function resetReportRuntimeState(): Promise<void> {
  await writeQueue.catch(() => undefined);
  state = null;
  writeQueue = Promise.resolve();
}
