import type { Client, Guild } from 'discord.js';
import { getGuildConfig } from './configService';
import { ensureSettingsChannel, refreshSettingsChannel } from './settingsChannelService';
import { refreshTicketPanel } from './ticketPanelService';
import { refreshAuditPanel } from './auditLogService';

const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const UPDATE_URL = 'https://api.github.com/repos/Annant2122011/supportforge/commits/main';

let baselineSha: string | null = null;
let scheduler: NodeJS.Timeout | null = null;
let refreshInProgress = false;

async function fetchLatestSha(): Promise<string | null> {
  try {
    const response = await fetch(UPDATE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'SupportForge',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const payload = await response.json() as { sha?: string };
    return payload.sha ?? null;
  } catch (error) {
    console.warn('⚠️ SupportForge update check failed:', error);
    return null;
  }
}

async function refreshGuildUi(guild: Guild): Promise<void> {
  const config = await getGuildConfig(guild.id);
  if (!config.supportCategoryId) return;

  await Promise.allSettled([
    refreshSettingsChannel(guild),
    refreshAuditPanel(guild),
    config.panelChannelId
      ? refreshTicketPanel(guild, config.panelChannelId)
      : Promise.resolve(),
  ]);
}

export async function refreshAllSupportForgeUi(client: Client): Promise<void> {
  if (refreshInProgress) return;
  refreshInProgress = true;

  try {
    for (const guild of client.guilds.cache.values()) {
      await refreshGuildUi(guild).catch((error) => {
        console.warn(`⚠️ SupportForge UI refresh failed for ${guild.id}:`, error);
      });
    }
  } finally {
    refreshInProgress = false;
  }
}

async function checkForUpdate(client: Client): Promise<void> {
  const latestSha = await fetchLatestSha();
  if (!latestSha) return;

  if (!baselineSha) {
    baselineSha = latestSha;
    return;
  }

  if (latestSha === baselineSha) return;

  baselineSha = latestSha;
  console.log(`🔄 SupportForge update detected (${latestSha.slice(0, 8)}). Refreshing all SupportForge buttons and panels.`);
  await refreshAllSupportForgeUi(client);
}

export function startSupportForgeUpdateMonitor(client: Client): void {
  if (scheduler) return;

  void checkForUpdate(client);

  scheduler = setInterval(() => {
    void checkForUpdate(client);
  }, UPDATE_CHECK_INTERVAL_MS);

  scheduler.unref();
}
