import {
  ChannelType,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getGuildConfig, updateGuildConfig } from './configService';

export interface AuditEvent {
  ticketNumber?: string;
  event: string;
  actor?: string;
  actorId?: string;
  actorName?: string;
  detail?: string;
  category?: 'ticket' | 'settings' | 'system';
}

export interface SettingsAuditEvent {
  action: string;
  actorId: string;
  actorName: string;
  detail?: string;
}

interface PersistedAuditEntry {
  id: string;
  guildId: string;
  category: 'ticket' | 'settings' | 'system';
  action: string;
  actorId: string;
  actorName: string;
  timestamp: string;
  ticketNumber?: string;
  detail?: string;
}

interface AuditGuildStore {
  events: PersistedAuditEntry[];
  summaries: Record<string, string>;
}

interface AuditStore {
  version: 1;
  guilds: Record<string, AuditGuildStore>;
}

const AUDIT_TOPIC = 'supportforge:audit';
const AUDIT_NAME = '📒 supportforge-audit-log';
const DATA_DIR = join(process.cwd(), 'data');
const AUDIT_PATH = join(DATA_DIR, 'audit-log.json');

let state: AuditStore | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let dailyScheduler: NodeJS.Timeout | null = null;

function cloneGuildStore(): AuditGuildStore {
  return { events: [], summaries: {} };
}

async function persist(): Promise<void> {
  if (!state) return;

  writeQueue = writeQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(AUDIT_PATH, JSON.stringify(state, null, 2), 'utf8');
  });

  await writeQueue;
}

async function load(): Promise<AuditStore> {
  if (state) return state;

  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(AUDIT_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AuditStore>;

    state = {
      version: 1,
      guilds: parsed.guilds ?? {},
    };
  } catch {
    state = {
      version: 1,
      guilds: {},
    };
    await persist();
  }

  return state;
}

function getGuildStore(current: AuditStore, guildId: string): AuditGuildStore {
  current.guilds[guildId] ??= cloneGuildStore();
  return current.guilds[guildId];
}

function dateKey(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function timeLabel(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(11, 16);
}

function actionLabel(action: string): string {
  return action
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ');
}

async function findAuditChannel(guild: Guild): Promise<TextChannel | null> {
  const config = await getGuildConfig(guild.id);

  if (config.auditChannelId) {
    const cached = guild.channels.cache.get(config.auditChannelId);
    if (cached?.type === ChannelType.GuildText) {
      return cached;
    }
  }

  const byTopic = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.topic?.startsWith(AUDIT_TOPIC),
  );

  if (byTopic?.type === ChannelType.GuildText) {
    await updateGuildConfig(guild.id, (current) => {
      current.auditChannelId = byTopic.id;
    });
    return byTopic;
  }

  return null;
}

export async function getOrCreateAuditChannel(
  guild: Guild,
  parentCategoryId: string,
): Promise<TextChannel> {
  const existing = await findAuditChannel(guild);
  if (existing) return existing;

  const bot = guild.members.me;
  if (!bot) throw new Error('SupportForge bot member could not be resolved.');

  const config = await getGuildConfig(guild.id);
  const staffRoleIds = Object.values(config.departments)
    .map((department) => department.staffRoleId)
    .filter((id): id is string => Boolean(id));

  const uniqueStaffRoleIds = [...new Set(staffRoleIds)];

  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: bot.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    ...uniqueStaffRoleIds.map((id) => ({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    })),
  ];

  const channel = await guild.channels.create({
    name: AUDIT_NAME,
    type: ChannelType.GuildText,
    parent: parentCategoryId,
    topic: `${AUDIT_TOPIC} guild=${guild.id}`,
    permissionOverwrites,
  });

  await updateGuildConfig(guild.id, (current) => {
    current.auditChannelId = channel.id;
  });

  return channel;
}

async function appendAuditRecord(
  guild: Guild,
  event: PersistedAuditEntry,
): Promise<void> {
  const current = await load();
  const store = getGuildStore(current, guild.id);

  store.events.push(event);

  // Keep the local audit database bounded while retaining a useful history.
  if (store.events.length > 5000) {
    store.events.splice(0, store.events.length - 5000);
  }

  await persist();
}

async function sendAuditEntry(
  channel: TextChannel,
  event: PersistedAuditEntry,
): Promise<void> {
  const actor = event.actorName === 'Unknown'
    ? `<@${event.actorId}>`
    : event.actorName;

  const description = [
    `**User:** ${actor}`,
    `**User ID:** \`${event.actorId}\``,
    `**When:** <t:${Math.floor(new Date(event.timestamp).getTime() / 1000)}:F>`,
    event.ticketNumber ? `**Ticket:** #${event.ticketNumber}` : null,
    event.detail ? `**Details:** ${event.detail}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(`SupportForge Audit • ${actionLabel(event.action)}`)
        .setDescription(description)
        .setFooter({ text: event.category === 'settings' ? 'Settings action' : 'Ticket action' })
        .setTimestamp(new Date(event.timestamp)),
    ],
  });
}

async function recordAndPublish(
  guild: Guild,
  parentCategoryId: string,
  event: AuditEvent,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const category = event.category ?? (event.ticketNumber ? 'ticket' : 'settings');
  const actorId = event.actorId ?? 'unknown';
  const actorName = event.actorName ?? event.actor ?? 'Unknown';

  const record: PersistedAuditEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    guildId: guild.id,
    category,
    action: event.event.toUpperCase(),
    actorId,
    actorName,
    timestamp,
    ticketNumber: event.ticketNumber,
    detail: event.detail,
  };

  await appendAuditRecord(guild, record);

  try {
    const channel = await getOrCreateAuditChannel(guild, parentCategoryId);
    await sendAuditEntry(channel, record);
  } catch (error) {
    console.error('❌ Failed to publish audit log entry:', error);
  }
}

export async function logTicketEvent(
  guild: Guild,
  parentCategoryId: string,
  event: AuditEvent,
): Promise<void> {
  try {
    await recordAndPublish(guild, parentCategoryId, {
      ...event,
      category: event.category ?? 'ticket',
    });
  } catch (error) {
    console.error('❌ Failed to write audit log:', error);
  }
}

export async function logSettingsEvent(
  guild: Guild,
  parentCategoryId: string,
  event: SettingsAuditEvent,
): Promise<void> {
  try {
    await recordAndPublish(guild, parentCategoryId, {
      event: event.action,
      actorId: event.actorId,
      actorName: event.actorName,
      detail: event.detail,
      category: 'settings',
    });
  } catch (error) {
    console.error('❌ Failed to write settings audit log:', error);
  }
}

function buildDailySummaryEmbed(
  guild: Guild,
  date: string,
  events: PersistedAuditEntry[],
): EmbedBuilder {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.action, (counts.get(event.action) ?? 0) + 1);
  }

  const count = (action: string): number => counts.get(action) ?? 0;

  const lines = [
    `**Date:** ${date} (UTC)`,
    `**Total actions:** ${events.length}`,
    '',
    '**Tags**',
    `• Added: ${count('TAG_ADDED')}`,
    `• Removed: ${count('TAG_REMOVED')}`,
    '',
    '**Departments**',
    `• Added: ${count('DEPARTMENT_ADDED') + count('USE_CASE_ADDED')}`,
    `• Removed: ${count('DEPARTMENT_REMOVED')}`,
    '',
    '**Settings**',
    `• Panel changes: ${count('PANEL_TOGGLE') + count('PANEL_SETTINGS_CHANGED')}`,
    `• Ticket defaults: ${count('TICKET_DEFAULTS_CHANGED')}`,
    `• Retention changes: ${count('RETENTION_CHANGED')}`,
    `• Appearance changes: ${count('APPEARANCE_CHANGED')}`,
    '',
    '**Repairs**',
    `• Normal Repair: ${count('NORMAL_REPAIR')}`,
    `• Storage Repair: ${count('STORAGE_REPAIR')}`,
    '',
    '**Other**',
    `• Use-case actions: ${count('USE_CASE_ADDED')}`,
    `• Refresh: ${count('SETTINGS_REFRESH')}`,
  ];

  const recent = events
    .slice(-5)
    .reverse()
    .map(
      (event) =>
        `• ${timeLabel(event.timestamp)} • ${event.actorName} • ${actionLabel(event.action)}${event.detail ? ` • ${event.detail.slice(0, 100)}` : ''}`,
    );

  lines.push('', '**Recent actions**', ...(recent.length ? recent : ['• No actions recorded.']));

  return new EmbedBuilder()
    .setTitle(`📊 Daily Audit Summary • ${date}`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: 'SupportForge • Daily audit summary (UTC)' })
    .setTimestamp();
}

async function publishDailySummary(
  guild: Guild,
  date: string,
): Promise<void> {
  const current = await load();
  const store = getGuildStore(current, guild.id);

  if (store.summaries[date]) return;

  const config = await getGuildConfig(guild.id);
  if (!config.supportCategoryId) return;

  const events = store.events.filter((event) => dateKey(event.timestamp) === date);
  const channel = await getOrCreateAuditChannel(guild, config.supportCategoryId);

  await channel.send({
    embeds: [buildDailySummaryEmbed(guild, date, events)],
  });

  store.summaries[date] = new Date().toISOString();
  await persist();
}

async function runDailySummarySweep(client: Client): Promise<void> {
  const previousDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const guild of client.guilds.cache.values()) {
    try {
      await publishDailySummary(guild, previousDate);
    } catch (error) {
      console.warn(`⚠️ Daily audit summary skipped for ${guild.id}:`, error);
    }
  }
}

export function startAuditDailySummaryScheduler(client: Client): void {
  if (dailyScheduler) return;

  void runDailySummarySweep(client);

  dailyScheduler = setInterval(() => {
    void runDailySummarySweep(client);
  }, 15 * 60 * 1000);

  dailyScheduler.unref();
}

export async function resetAuditLogState(): Promise<void> {
  await writeQueue.catch(() => undefined);
  state = null;
  writeQueue = Promise.resolve();
}
