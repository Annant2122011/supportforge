import type { Client, Guild } from 'discord.js';
import { getGuildConfig } from './configService';
import { refreshSettingsChannel } from './settingsChannelService';
import { refreshTicketPanelControls } from './ticketPanelService';
import { getOrCreateAuditChannel } from './auditLogService';

const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const GITHUB_REPOSITORY = 'Annant2122011/supportforge';
const DEPLOY_WORKFLOW = 'deploy-server.yml';
const UPDATE_URL = 'https://api.github.com/repos/Annant2122011/supportforge/commits/main';

let baselineSha: string | null = null;
let scheduler: NodeJS.Timeout | null = null;
let refreshInProgress = false;

async function fetchLatestSha(): Promise<string | null> {
  try {
    const response = await fetch(UPDATE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'QueryFixr',
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) return null;

    const payload = await response.json() as { sha?: string };
    return payload.sha ?? null;
  } catch (error) {
    console.warn('⚠️ QueryFixr update check failed:', error);
    return null;
  }
}

async function refreshGuildUi(guild: Guild): Promise<void> {
  const config = await getGuildConfig(guild.id);
  if (!config.supportCategoryId) return;

  await Promise.allSettled([
    refreshSettingsChannel(guild),
    getOrCreateAuditChannel(guild, config.supportCategoryId),
    refreshTicketPanelControls(guild),
  ]);
}

export interface GitHubDeployRequestResult {
  requested: boolean;
  reason: string;
}

/**
 * Ask GitHub Actions to deploy the current main branch. The token must be a
 * repository-scoped fine-grained token with Actions: write. No shell command
 * is executed inside the bot process.
 */
export async function requestGitHubDeployment(): Promise<GitHubDeployRequestResult> {
  const token = process.env.GITHUB_DEPLOY_TOKEN?.trim();
  if (!token) {
    return {
      requested: false,
      reason: 'Code deployment is not configured on this server. Set GITHUB_DEPLOY_TOKEN and the SSH deployment secrets in GitHub Actions.',
    };
  }

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'QueryFixr-Deployment-Control',
      },
      body: JSON.stringify({ ref: 'main' }),
      signal: AbortSignal.timeout(20_000),
    },
  );

  if (response.status === 204) {
    return { requested: true, reason: 'GitHub Actions accepted a deployment of main. The server will update and restart through the configured SSH workflow.' };
  }

  const detail = (await response.text().catch(() => '')).slice(0, 500);
  if (response.status === 401 || response.status === 403) {
    return { requested: false, reason: 'GitHub rejected GITHUB_DEPLOY_TOKEN. Use a repository-scoped fine-grained token with Actions: write.' };
  }
  if (response.status === 404) {
    return { requested: false, reason: 'GitHub could not find the deployment workflow. Ensure .github/workflows/deploy-server.yml is on main.' };
  }
  return { requested: false, reason: `GitHub deployment request failed (HTTP ${response.status}). ${detail}`.trim() };
}

export async function refreshAllSupportForgeUi(client: Client): Promise<void> {
  if (refreshInProgress) return;
  refreshInProgress = true;

  try {
    for (const guild of client.guilds.cache.values()) {
      await refreshGuildUi(guild).catch((error) => {
        console.warn(`⚠️ QueryFixr UI refresh failed for ${guild.id}:`, error);
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
  console.log('🔄 GitHub commit detected (' + latestSha.slice(0, 8) + '). Requesting the deployment workflow as a fallback; panel refresh alone does not update running code.');
  const deployment = await requestGitHubDeployment().catch((error) => ({
    requested: false,
    reason: error instanceof Error ? error.message : 'GitHub deployment request failed.',
  }));
  if (deployment.requested) {
    console.info('QueryFixr deployment workflow accepted the detected commit: ' + deployment.reason);
  } else {
    console.warn('QueryFixr did not dispatch a deployment from the bot monitor: ' + deployment.reason + ' The push-triggered workflow and server-side watchdog remain the automatic update paths.');
  }
  // UI reconciliation is separate from fetching/building/restarting code. The
  // GitHub workflow and the independent server watchdog perform the deployment.
  await refreshAllSupportForgeUi(client);
}

export function startSupportForgeUpdateMonitor(client: Client): void {
  if (scheduler) return;

  /*
   * Full infrastructure reconciliation is run once by index.ts after startup.
   * Avoid starting a second overlapping set of channel/message mutations here.
   * This monitor is responsible for detecting commits and refreshing UI after
   * an update event, while the separate server watchdog handles deployments.
   */
  void checkForUpdate(client);

  scheduler = setInterval(() => {
    void checkForUpdate(client);
  }, UPDATE_CHECK_INTERVAL_MS);

  scheduler.unref();
}
