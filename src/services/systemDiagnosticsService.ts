import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
} from 'discord.js';

import { getGuildConfig } from './configService';
import { getAdvancedSettings } from './advancedSettingsService';
import { getPostgresPool, pingPostgres } from '../core/persistence/postgresDatabase';

export type DiagnosticSeverity = 'ok' | 'info' | 'warning' | 'error';

export interface DiagnosticFinding {
  area: string;
  severity: DiagnosticSeverity;
  title: string;
  detail: string;
  remedy?: string;
}

export interface SystemDiagnosticsReport {
  guildId: string;
  generatedAt: string;
  mode: 'health' | 'setup-doctor';
  findings: DiagnosticFinding[];
  queue?: {
    pending: number;
    processing: number;
    failed: number;
    oldestPendingAt: string | null;
    oldestProcessingAt: string | null;
  };
}

const CHANNEL_MESSAGE_PERMISSIONS = [
  ['View Channel', PermissionFlagsBits.ViewChannel],
  ['Send Messages', PermissionFlagsBits.SendMessages],
  ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
] as const;

function severityRank(severity: DiagnosticSeverity): number {
  switch (severity) {
    case 'error': return 3;
    case 'warning': return 2;
    case 'info': return 1;
    default: return 0;
  }
}

export function diagnosticsOverallStatus(findings: readonly DiagnosticFinding[]): 'HEALTHY' | 'DEGRADED' | 'ACTION REQUIRED' {
  const maxSeverity = findings.reduce((rank, finding) => Math.max(rank, severityRank(finding.severity)), 0);
  return maxSeverity >= 3 ? 'ACTION REQUIRED' : maxSeverity >= 2 ? 'DEGRADED' : 'HEALTHY';
}

export function evaluateOutboxCounts(input: {
  pending: number;
  processing: number;
  failed: number;
  oldestPendingAt?: string | Date | null;
  oldestProcessingAt?: string | Date | null;
}, now = Date.now()): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  const ageMs = (value: string | Date | null | undefined): number | null => {
    if (value == null) return null;
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
  };
  const pendingAge = ageMs(input.oldestPendingAt);
  const processingAge = ageMs(input.oldestProcessingAt);

  if (input.failed > 0) {
    findings.push({
      area: 'Queue',
      severity: 'error',
      title: 'Failed outbox work needs attention',
      detail: input.failed + ' failed outbox item(s) are recorded for this server.',
      remedy: 'Inspect the outbox error records and repair the underlying Discord permission, channel or payload problem before requeueing.',
    });
  } else {
    findings.push({
      area: 'Queue',
      severity: 'ok',
      title: 'No permanently failed outbox work',
      detail: 'No failed outbox items are currently recorded for this server.',
    });
  }

  if (input.pending > 50 || (pendingAge !== null && pendingAge > 15 * 60_000)) {
    findings.push({
      area: 'Queue',
      severity: 'warning',
      title: 'Outbox backlog is growing or old',
      detail: input.pending + ' pending item(s)' + (pendingAge === null ? '.' : '; oldest pending item is about ' + Math.floor(pendingAge / 60_000) + ' minute(s) old.'),
      remedy: 'Check worker activity, Discord rate limits and permissions. Do not delete queued records to hide the backlog.',
    });
  } else {
    findings.push({
      area: 'Queue',
      severity: 'ok',
      title: 'Pending outbox work is within the alert threshold',
      detail: input.pending + ' pending item(s) are recorded.',
    });
  }

  if (input.processing > 0 && processingAge !== null && processingAge > 10 * 60_000) {
    findings.push({
      area: 'Queue',
      severity: 'warning',
      title: 'Outbox work may be stuck in processing',
      detail: input.processing + ' item(s) are processing; the oldest processing lease is about ' + Math.floor(processingAge / 60_000) + ' minute(s) old.',
      remedy: 'Inspect lease age and worker health. Use the existing stale-processing reconciliation path rather than editing rows manually.',
    });
  } else {
    findings.push({
      area: 'Queue',
      severity: 'ok',
      title: 'No stale processing lease detected',
      detail: input.processing + ' item(s) are currently processing.',
    });
  }

  return findings;
}

async function fetchGuildChannel(guild: Guild, channelId: string) {
  const cached = guild.channels.cache.get(channelId);
  if (cached) return cached;
  return guild.channels.fetch(channelId).catch(() => null);
}

function checkBotPermissions(
  guild: Guild,
  channel: NonNullable<Awaited<ReturnType<typeof fetchGuildChannel>>>,
  required: readonly (readonly [string, bigint])[],
): string[] {
  const botMember = guild.members.me;
  if (!botMember) return ['The bot guild-member object is unavailable; reconnect or check guild member intent/cache state.'];
  const permissions = channel.permissionsFor(botMember);
  if (!permissions) return ['Effective channel permissions could not be resolved.'];
  return required
    .filter(([, permission]) => !permissions.has(permission))
    .map(([name]) => name);
}

export async function runSystemDiagnostics(
  guild: Guild,
  mode: 'health' | 'setup-doctor' = 'health',
): Promise<SystemDiagnosticsReport> {
  const findings: DiagnosticFinding[] = [];
  const report: SystemDiagnosticsReport = {
    guildId: guild.id,
    generatedAt: new Date().toISOString(),
    mode,
    findings,
  };
  const add = (finding: DiagnosticFinding): void => { findings.push(finding); };

  add({
    area: 'Bot',
    severity: guild.client.isReady() && guild.available ? 'ok' : 'error',
    title: guild.client.isReady() && guild.available ? 'Bot gateway is online' : 'Bot gateway or guild is unavailable',
    detail: guild.client.isReady() && guild.available ? 'The command is executing through a ready Discord client.' : 'The Discord client is not ready or this guild is not available.',
    remedy: 'Check the process and gateway connection; a live interaction alone does not prove database or channel readiness.',
  });

  let dbConnected = false;
  try {
    await pingPostgres();
    dbConnected = true;
    add({
      area: 'Database',
      severity: 'ok',
      title: 'Neon/PostgreSQL connection succeeded',
      detail: 'A read-only SELECT 1 health probe completed successfully. No production records were changed.',
    });
  } catch {
    add({
      area: 'Database',
      severity: 'error',
      title: 'Neon/PostgreSQL connection failed',
      detail: 'The database health probe failed. Connection details are deliberately not included in the Discord report.',
      remedy: 'Verify DATABASE_URL, provider configuration, network reachability and migration state in the deployment environment. Never paste credentials into Discord.',
    });
  }

  if (dbConnected) {
    try {
      const query = await getPostgresPool().query(
        'SELECT ' +
          "COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count, " +
          "COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_count, " +
          "COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count, " +
          "MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at, " +
          "MIN(processing_started_at) FILTER (WHERE status = 'processing') AS oldest_processing_at " +
          'FROM outbox_events WHERE guild_id = $1',
        [guild.id],
      );
      const row = query.rows[0] as {
        pending_count?: number | string;
        processing_count?: number | string;
        failed_count?: number | string;
        oldest_pending_at?: string | Date | null;
        oldest_processing_at?: string | Date | null;
      } | undefined;
      if (!row) throw new Error('Health query returned no row.');
      report.queue = {
        pending: Number(row.pending_count ?? 0),
        processing: Number(row.processing_count ?? 0),
        failed: Number(row.failed_count ?? 0),
        oldestPendingAt: row.oldest_pending_at ? new Date(row.oldest_pending_at).toISOString() : null,
        oldestProcessingAt: row.oldest_processing_at ? new Date(row.oldest_processing_at).toISOString() : null,
      };
      findings.push(...evaluateOutboxCounts({
        pending: report.queue.pending,
        processing: report.queue.processing,
        failed: report.queue.failed,
        oldestPendingAt: report.queue.oldestPendingAt,
        oldestProcessingAt: report.queue.oldestProcessingAt,
      }));
    } catch {
      add({
        area: 'Queue',
        severity: 'warning',
        title: 'Outbox health could not be inspected',
        detail: 'The database responded, but the outbox status query failed. Queue health is unknown, not healthy.',
        remedy: 'Verify that PostgreSQL migrations are current and inspect the outbox worker logs.',
      });
    }
  } else {
    add({
      area: 'Queue',
      severity: 'warning',
      title: 'Outbox health was not checked',
      detail: 'Queue status is unknown because the database health probe failed.',
      remedy: 'Restore database connectivity before trusting queue health.',
    });
  }

  const config = await getGuildConfig(guild.id).catch(() => null);
  const advanced = await getAdvancedSettings(guild.id).catch(() => null);
  if (!config || !advanced) {
    add({
      area: 'Configuration',
      severity: 'error',
      title: 'Guild configuration could not be loaded',
      detail: 'One or more configuration documents could not be read or normalized.',
      remedy: 'Inspect database-document health and existing config validation errors before running repairs. Do not reset the configuration.',
    });
    return report;
  }

  const channelResults = await Promise.all([
    {
      id: config.supportCategoryId,
      name: 'Support category',
      kind: 'category' as const,
      required: [['View Channel', PermissionFlagsBits.ViewChannel], ['Manage Channels', PermissionFlagsBits.ManageChannels]] as const,
      missingSeverity: 'error' as const,
    },
    {
      id: config.panelChannelId,
      name: 'Public ticket panel channel',
      kind: 'text' as const,
      required: CHANNEL_MESSAGE_PERMISSIONS,
      missingSeverity: 'warning' as const,
    },
    {
      id: config.transcriptChannelId,
      name: 'Transcript destination',
      kind: 'text' as const,
      required: [...CHANNEL_MESSAGE_PERMISSIONS, ['Attach Files', PermissionFlagsBits.AttachFiles]] as const,
      missingSeverity: 'error' as const,
    },
    {
      id: config.auditChannelId,
      name: 'Audit channel',
      kind: 'text' as const,
      required: CHANNEL_MESSAGE_PERMISSIONS,
      missingSeverity: 'warning' as const,
    },
    {
      id: advanced.settingsChannelId,
      name: 'Settings dashboard channel',
      kind: 'text' as const,
      required: CHANNEL_MESSAGE_PERMISSIONS,
      missingSeverity: 'warning' as const,
    },
  ].map(async (entry) => {
    if (!entry.id) {
      add({
        area: 'Discord configuration',
        severity: entry.missingSeverity,
        title: entry.name + ' is not configured',
        detail: 'No managed destination ID is saved for this resource.',
        remedy: 'Use the existing Setup/Restore or Storage tools, then run diagnostics again.',
      });
      return;
    }

    const channel = await fetchGuildChannel(guild, entry.id);
    if (!channel) {
      add({
        area: 'Discord configuration',
        severity: entry.missingSeverity,
        title: entry.name + ' is missing or inaccessible',
        detail: 'The saved channel ID could not be resolved in this server.',
        remedy: 'Confirm the channel was not deleted and that the bot can view it. Use the appropriate repair action only after checking resource ownership.',
      });
      return;
    }

    if (entry.kind === 'category' && channel.type !== ChannelType.GuildCategory) {
      add({
        area: 'Discord configuration',
        severity: 'error',
        title: entry.name + ' has the wrong channel type',
        detail: 'The saved ID resolves to a non-category channel.',
        remedy: 'Review the saved ID and managed-category ledger before changing it.',
      });
      return;
    }
    if (entry.kind === 'text' && channel.type !== ChannelType.GuildText) {
      add({
        area: 'Discord configuration',
        severity: entry.missingSeverity,
        title: entry.name + ' has the wrong channel type',
        detail: 'The saved ID does not resolve to a standard server text channel.',
        remedy: 'Choose a compatible text channel through the feature’s existing settings.',
      });
      return;
    }

    const missing = checkBotPermissions(guild, channel, entry.required);
    add({
      area: 'Discord permissions',
      severity: missing.length ? entry.missingSeverity : 'ok',
      title: entry.name + (missing.length ? ' is missing bot permissions' : ' permissions look correct'),
      detail: missing.length
        ? 'Missing permission(s): ' + missing.join(', ') + '.'
        : 'The bot currently has the required channel permissions.',
      remedy: missing.length ? 'Update the channel/category permission overwrites for the bot role, then run the check again.' : undefined,
    });

    if (entry.name === 'Public ticket panel channel' && config.panelMessageId && channel.type === ChannelType.GuildText) {
      const message = await channel.messages.fetch(config.panelMessageId).catch(() => null);
      add({
        area: 'Panels',
        severity: message ? 'ok' : 'warning',
        title: message ? 'Default ticket panel message exists' : 'Default ticket panel message is missing',
        detail: message ? 'The saved public panel message ID resolves.' : 'The saved panel message ID could not be fetched.',
        remedy: message ? undefined : 'Use the existing panel refresh/publish tool after verifying the saved target channel.',
      });
    }
  }));

  const departments = Object.values(config.departments);
  if (!departments.length) {
    add({
      area: 'Departments',
      severity: 'warning',
      title: 'No ticket departments are configured',
      detail: 'Users may not have a valid department to select when opening a ticket.',
      remedy: 'Create at least one department and configure its staff role.',
    });
  } else {
    for (const department of departments) {
      if (!department.staffRoleId) {
        add({
          area: 'Departments',
          severity: 'warning',
          title: 'Department has no staff role: ' + department.name,
          detail: 'The department can be difficult to staff or may have incomplete permission routing.',
          remedy: 'Assign a valid staff role in Settings → Departments.',
        });
      } else if (!guild.roles.cache.has(department.staffRoleId)) {
        add({
          area: 'Departments',
          severity: 'warning',
          title: 'Department staff role is missing: ' + department.name,
          detail: 'The configured role ID is not present in the current guild role cache.',
          remedy: 'Verify the role ID and choose an existing role in department settings.',
        });
      }
      if (!Object.keys(department.tags ?? {}).length) {
        add({
          area: 'Departments',
          severity: 'error',
          title: 'Department has no tags: ' + department.name,
          detail: 'Ticket routing requires a valid tag selection.',
          remedy: 'Add a tag using the existing department tag controls.',
        });
      }
    }
    if (!findings.some((finding) => finding.area === 'Departments' && finding.severity === 'error')) {
      add({
        area: 'Departments',
        severity: 'ok',
        title: 'Department configuration inspected',
        detail: departments.length + ' department(s) inspected for staff-role and tag readiness.',
      });
    }
  }

  if (advanced.ticketWorkspace.mode === 'private-threads') {
    const threadPermissions = [
      ['View Channel', PermissionFlagsBits.ViewChannel],
      ['Create Private Threads', PermissionFlagsBits.CreatePrivateThreads],
      ['Send Messages in Threads', PermissionFlagsBits.SendMessagesInThreads],
      ['Manage Threads', PermissionFlagsBits.ManageThreads],
    ] as const;
    for (const department of departments) {
      if (!department.threadParentChannelId) {
        add({
          area: 'Private-thread workspace',
          severity: 'warning',
          title: 'Thread parent is not provisioned: ' + department.name,
          detail: 'Private-thread mode is enabled but no parent text channel ID is saved for this department.',
          remedy: 'Configure the department staff role and open a test ticket; do not switch existing tickets destructively.',
        });
        continue;
      }
      const parent = await fetchGuildChannel(guild, department.threadParentChannelId);
      if (!parent || parent.type !== ChannelType.GuildText) {
        add({
          area: 'Private-thread workspace',
          severity: 'error',
          title: 'Private-thread parent is missing: ' + department.name,
          detail: 'The stored parent ID does not resolve to an accessible standard text channel.',
          remedy: 'Verify ownership and permissions before repairing the workspace.',
        });
        continue;
      }
      const missing = checkBotPermissions(guild, parent, threadPermissions);
      add({
        area: 'Private-thread workspace',
        severity: missing.length ? 'error' : 'ok',
        title: department.name + (missing.length ? ' thread permissions need attention' : ' thread permissions look correct'),
        detail: missing.length ? 'Missing: ' + missing.join(', ') + '.' : 'Required thread permissions are present.',
        remedy: missing.length ? 'Review parent-channel overwrites and staff-role configuration, then recheck.' : undefined,
      });
    }
  } else {
    add({
      area: 'Ticket workspace',
      severity: 'ok',
      title: 'Standard text-channel workspace selected',
      detail: 'New tickets use the configured text-channel workspace mode.',
    });
  }

  add({
    area: 'Data safety',
    severity: 'info',
    title: 'Diagnostics are read-only',
    detail: 'This report does not repair, delete, rename or publish Discord resources and does not mutate ticket records.',
  });

  return report;
}

export function buildSystemDiagnosticsEmbed(
  report: SystemDiagnosticsReport,
  themeColor = 0x3b82f6,
): EmbedBuilder {
  const status = diagnosticsOverallStatus(report.findings);
  const color = status === 'ACTION REQUIRED' ? 0xdc2626 : status === 'DEGRADED' ? 0xd97706 : themeColor;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(report.mode === 'setup-doctor' ? '🩺 ResolveX Setup Doctor' : '🛡️ ResolveX System Health')
    .setDescription(
      '**Overall status:** ' + status +
      '\n**Generated:** <t:' + Math.floor(Date.parse(report.generatedAt) / 1000) + ':F>' +
      '\n**Checks:** ' + report.findings.length +
      '\n\nThis is a read-only report. A green result is not a substitute for the live acceptance checklist.',
    )
    .setFooter({ text: 'Guild ' + report.guildId + ' • secrets and connection strings are never shown' });

  const grouped = new Map<string, DiagnosticFinding[]>();
  for (const finding of report.findings) {
    const current = grouped.get(finding.area) ?? [];
    current.push(finding);
    grouped.set(finding.area, current);
  }
  for (const [area, group] of grouped) {
    const lines = group.map((finding) => {
      const icon = finding.severity === 'error' ? '🔴' : finding.severity === 'warning' ? '🟠' : finding.severity === 'info' ? 'ℹ️' : '🟢';
      return icon + ' **' + finding.title + '**\n' + finding.detail +
        (finding.remedy ? '\n*Next step:* ' + finding.remedy : '');
    });
    embed.addFields({ name: area.slice(0, 256), value: (lines.join('\n\n').slice(0, 1024) || 'No details.'), inline: false });
    if (embed.data.fields?.length === 25) break;
  }
  return embed;
}
