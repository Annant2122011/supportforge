import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getGuildConfig, updateGuildConfig } from './configService';
import { getAdvancedSettings } from './advancedSettingsService';
import {
  getPersistedTicketRecords,
  getPersistedTicketStatus,
} from './ticketPersistenceService';
import {
  getField,
  getTicketStatus,
  isTicketTopic,
  type TicketStatus,
} from './ticketStateService';

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
  panelMessageId: string | null;
  restoreMessageId: string | null;
  panelEventCheckpoint: number;
}

interface AuditStore {
  version: 2;
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
  return {
    events: [],
    summaries: {},
    panelMessageId: null,
    restoreMessageId: null,
    panelEventCheckpoint: 0,
  };
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

    const rawGuilds = parsed.guilds ?? {};
    const guilds: Record<string, AuditGuildStore> = {};

    for (const [guildId, rawStore] of Object.entries(rawGuilds)) {
      const store = rawStore as Partial<AuditGuildStore>;
      guilds[guildId] = {
        events: store.events ?? [],
        summaries: store.summaries ?? {},
        panelMessageId: store.panelMessageId ?? null,
        restoreMessageId: store.restoreMessageId ?? null,
        panelEventCheckpoint: store.panelEventCheckpoint ?? 0,
      };
    }

    state = {
      version: 2,
      guilds,
    };
  } catch {
    state = {
      version: 2,
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
  if (existing) {
    await ensureAuditPanel(guild, existing);
    return existing;
  }

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

  await ensureAuditPanel(guild, channel);
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

const AUDIT_PANEL_TITLE = '📒 SupportForge Audit Log';
const AUDIT_SUMMARY_CUSTOM_ID = 'sf:audit:summary';
const AUDIT_COLLAPSE_CUSTOM_ID = 'sf:audit:collapse-panel';
const AUDIT_RESTORE_CUSTOM_ID = 'sf:audit:restore-panel';
const AUDIT_COLLAPSE_AFTER = 12;

function auditPanelComponents(canCollapse = false): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(AUDIT_SUMMARY_CUSTOM_ID)
      .setLabel('Summarise Everything')
      .setEmoji('📊')
      .setStyle(ButtonStyle.Primary),
  ];

  if (canCollapse) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(AUDIT_COLLAPSE_CUSTOM_ID)
        .setLabel('Collapse Audit Panel')
        .setEmoji('⬇️')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons),
  ];
}

function auditRestoreComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(AUDIT_RESTORE_CUSTOM_ID)
        .setLabel('Restore Audit Panel')
        .setEmoji('↩️')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildAuditPanelEmbed(guild: Guild): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(AUDIT_PANEL_TITLE)
    .setDescription(
      'This channel is the central SupportForge audit record. It keeps a durable history of ticket lifecycle actions and important configuration changes, including responsible users and timestamps.\n\n' +
      'Use **Summarise Everything** to generate a current, detailed snapshot of ticket activity, tags, channels, departments, priorities, retention, and other useful metrics.',
    )
    .addFields(
      {
        name: 'What the audit log records',
        value: 'Ticket lifecycle actions, Settings changes, tags, departments, retention decisions, repairs, priority-role creation, and other SupportForge configuration activity.',
      },
      {
        name: 'What the overall summary contains',
        value: 'Tickets created to date, current Open/Claimed/Pending/Closed/Archived totals, tag creation dates, channel counts, departments, priorities, audit activity, and useful operational metrics.',
      },
    )
    .setFooter({ text: guild.name + ' • SupportForge Audit' })
    .setTimestamp();
}

async function ensureAuditPanel(guild: Guild, channel: TextChannel): Promise<void> {
  const current = await load();
  const store = getGuildStore(current, guild.id);

  if (store.restoreMessageId) {
    const restore = channel.messages.cache.get(store.restoreMessageId);
    if (restore) return;
    store.restoreMessageId = null;
  }

  if (store.panelMessageId) {
    const panel = channel.messages.cache.get(store.panelMessageId);
    if (panel?.embeds.some((embed) => embed.title === AUDIT_PANEL_TITLE)) {
      const canCollapse =
        store.events.length - store.panelEventCheckpoint >= AUDIT_COLLAPSE_AFTER;
      const hasCollapse = panel.components.some(
        (row) =>
          row.type === ComponentType.ActionRow &&
          row.components.some(
            (component) =>
              'customId' in component &&
              component.customId === AUDIT_COLLAPSE_CUSTOM_ID,
          ),
      );

      if (canCollapse !== hasCollapse) {
        await panel.edit({
          components: auditPanelComponents(canCollapse),
        });
      }
      return;
    }

    store.panelMessageId = null;
  }

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (recent) {
    const existingRestore = recent.find(
      (message) =>
        message.author.id === channel.client.user?.id &&
        message.components.some(
          (row) =>
            row.type === ComponentType.ActionRow &&
            row.components.some(
              (component) =>
                'customId' in component &&
                component.customId === AUDIT_RESTORE_CUSTOM_ID,
            ),
        ),
    );
    if (existingRestore) {
      store.restoreMessageId = existingRestore.id;
      store.panelMessageId = null;
      await persist();
      return;
    }

    const existingPanel = recent.find(
      (message) =>
        message.author.id === channel.client.user?.id &&
        message.embeds.some((embed) => embed.title === AUDIT_PANEL_TITLE),
    );
    if (existingPanel) {
      store.panelMessageId = existingPanel.id;
      const canCollapse =
        store.events.length - store.panelEventCheckpoint >= AUDIT_COLLAPSE_AFTER;
      await existingPanel
        .edit({ components: auditPanelComponents(canCollapse) })
        .catch(() => undefined);
      await persist();
      return;
    }
  }

  const panel = await channel.send({
    embeds: [buildAuditPanelEmbed(guild)],
    components: auditPanelComponents(false),
  });

  store.panelMessageId = panel.id;
  store.restoreMessageId = null;
  store.panelEventCheckpoint = store.events.length;
  await persist();
}

async function collapseAuditPanel(
  guild: Guild,
  channel: TextChannel,
): Promise<void> {
  const current = await load();
  const store = getGuildStore(current, guild.id);

  if (!store.panelMessageId) return;
  if (store.events.length - store.panelEventCheckpoint < AUDIT_COLLAPSE_AFTER) return;

  // An explicit collapse button is exposed after the threshold. Do not
  // move the panel automatically.
}

function currentStatusCounts(tickets: Awaited<ReturnType<typeof collectLiveTickets>>): Map<TicketStatus, number> {
  const counts = new Map<TicketStatus, number>();
  for (const ticket of tickets) {
    counts.set(ticket.status, (counts.get(ticket.status) ?? 0) + 1);
  }
  return counts;
}

async function collectLiveTickets(guild: Guild): Promise<Array<{
  channel: TextChannel;
  status: TicketStatus;
  number: string;
  priority: string;
  departmentId: string | null;
  openedAt: string | null;
}>> {
  const tickets: Array<{
    channel: TextChannel;
    status: TicketStatus;
    number: string;
    priority: string;
    departmentId: string | null;
    openedAt: string | null;
  }> = [];

  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;
    const topic = channel.topic ?? '';
    if (!isTicketTopic(topic)) continue;

    tickets.push({
      channel,
      status: (await getPersistedTicketStatus(channel.id)) ?? getTicketStatus(topic),
      number: getField(topic, 'number') ?? 'unknown',
      priority: getField(topic, 'priority') ?? 'normal',
      departmentId: getField(topic, 'department'),
      openedAt: getField(topic, 'opened_at') ?? null,
    });
  }

  return tickets;
}

function formatAuditDate(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp.slice(0, 10) : date.toISOString().slice(0, 10);
}

async function generateOverallAuditSummary(guild: Guild): Promise<EmbedBuilder[]> {
  const current = await load();
  const store = getGuildStore(current, guild.id);
  const [config, settings, ticketRecords, liveTickets] = await Promise.all([
    getGuildConfig(guild.id),
    getAdvancedSettings(guild.id),
    getPersistedTicketRecords(guild.id),
    collectLiveTickets(guild),
  ]);

  const counts = currentStatusCounts(liveTickets);
  const unclaimedOpen = counts.get('open') ?? 0;
  const claimed = counts.get('claimed') ?? 0;
  const pending = counts.get('pending') ?? 0;
  const reopened = counts.get('reopened') ?? 0;
  const archived = counts.get('archived') ?? 0;
  const closedOnly = counts.get('closed') ?? 0;
  const openTotal = unclaimedOpen + claimed + pending + reopened;
  const closedTotal = closedOnly + archived;
  const ticketCreationEvents = store.events.filter((event) => event.action === 'TICKET_CREATED').length;
  const ticketsCreatedToDate = Math.max(
    ticketRecords.length,
    liveTickets.length,
    ticketCreationEvents,
  );

  const managedChannels = guild.channels.cache.filter((channel) =>
    channel.topic?.startsWith('supportforge:') ||
    channel.name === 'Support Forge' ||
    channel.name === '📄 support-transcripts' ||
    channel.name === '📒 supportforge-audit-log' ||
    channel.name === 'supportforge-settings' ||
    channel.name.startsWith('SupportForge.') ||
    channel.name.startsWith('SupportForge • Closed') ||
    channel.name.startsWith('SupportForge • Archive'),
  ).size;

  const tags = Object.values(settings.customTags).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const departments = Object.values(config.departments).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const priorityCounts = new Map<string, number>();
  for (const ticket of liveTickets) {
    priorityCounts.set(ticket.priority, (priorityCounts.get(ticket.priority) ?? 0) + 1);
  }

  const departmentCounts = new Map<string, number>();
  for (const ticket of liveTickets) {
    if (ticket.departmentId) {
      departmentCounts.set(ticket.departmentId, (departmentCounts.get(ticket.departmentId) ?? 0) + 1);
    }
  }

  const oldestActive = liveTickets
    .filter((ticket) => ['open', 'claimed', 'pending', 'reopened'].includes(ticket.status))
    .map((ticket) => ({ ticket, timestamp: ticket.openedAt ? Date.parse(ticket.openedAt) : NaN }))
    .filter((item): item is { ticket: typeof liveTickets[number]; timestamp: number } => Number.isFinite(item.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)[0];

  const tagCreationEvents = store.events.filter((event) => event.action === 'TAG_ADDED');
  const tagCreations = tagCreationEvents.length;
  const settingsActions = store.events.filter((event) => event.category === 'settings').length;
  const ticketActions = store.events.filter((event) => event.category === 'ticket').length;
  const priorityRolesCreated = store.events.filter((event) => event.action === 'PRIORITY_ROLE_CREATED').length;
  const retentionEligible = ticketRecords.filter((ticket) => ticket.deletedAt !== null).length;

  const summaryLines = [
    '**Tickets created to date:** ' + ticketsCreatedToDate,
    '**Current Open chats:** ' + openTotal + ' *(includes Claimed, Pending, and Reopened)*',
    '**Open (unclaimed):** ' + unclaimedOpen,
    '**Claimed:** ' + claimed,
    '**Pending:** ' + pending,
    '**Reopened:** ' + reopened,
    '**Closed:** ' + closedTotal + ' *(includes ' + archived + ' archived)*',
    '**Archived:** ' + archived,
    '',
    '**Channels currently in server:** ' + guild.channels.cache.size,
    '**SupportForge-managed channels currently present:** ' + managedChannels,
    '**Ticket channels created to date:** ' + ticketsCreatedToDate,
    '',
    '**Existing departments:** ' + departments.length,
    '**Active custom tags:** ' + tags.length,
    '**Tag creations recorded:** ' + tagCreations,
    '**Audit entries stored:** ' + store.events.length,
  ];

  const priorityLines = ['**Current ticket priorities**'];
  for (const priority of ['critical', 'urgent', 'high', 'normal', 'low']) {
    priorityLines.push('• ' + priority + ': ' + (priorityCounts.get(priority) ?? 0));
  }

  const historicalTagLines = tagCreationEvents
    .slice()
    .reverse()
    .map((event) => {
      const nameMatch = event.detail?.match(/custom tag (.+?)(?:\.|$)/i);
      const name = nameMatch?.[1] ?? 'Unknown tag';
      return '• **' + name + '** • created ' + formatAuditDate(event.timestamp);
    });
  const tagLines = historicalTagLines.length
    ? historicalTagLines
    : tags.length
      ? tags.map((tag) => '• ' + tag.emoji + ' **' + tag.name + '** • created ' + formatAuditDate(tag.createdAt) + (tag.description ? ' • ' + tag.description : ''))
      : ['• No tags have been created yet.'];

  const departmentLines = departments.length
    ? departments.map((department) => {
        const active = departmentCounts.get(department.id) ?? 0;
        const staff = department.staffRoleId ? '<@&' + department.staffRoleId + '>' : 'Administrators only';
        return '• **' + department.name + '** • created ' + formatAuditDate(department.createdAt) + ' • active tickets: ' + active + ' • staff: ' + staff;
      })
    : ['• None configured.'];

  const metricsLines = [
    '**Ticket lifecycle audit actions:** ' + ticketActions,
    '**Settings actions:** ' + settingsActions,
    '**Priority roles created:** ' + priorityRolesCreated,
    '**Retention-deleted ticket records:** ' + retentionEligible,
    '**Retention policy:** closed ' + (settings.retention.closedDays || 'never') + ' days • archive ' + (settings.retention.archiveDays || 'never') + ' days',
    oldestActive
      ? '**Oldest active ticket:** #' + oldestActive.ticket.number + ' • opened ' + formatAuditDate(oldestActive.ticket.openedAt ?? new Date(oldestActive.timestamp).toISOString())
      : '**Oldest active ticket:** none',
  ];

  const chunkLines = (lines: string[], max = 900): string[][] => {
    const chunks: string[][] = [];
    let current: string[] = [];
    let length = 0;

    for (const line of lines) {
      const nextLength = length + line.length + (current.length ? 1 : 0);
      if (current.length && nextLength > max) {
        chunks.push(current);
        current = [];
        length = 0;
      }

      current.push(line);
      length += line.length + (current.length > 1 ? 1 : 0);
    }

    if (current.length) chunks.push(current);
    return chunks;
  };

  const tagChunks = chunkLines(tagLines);
  const departmentChunks = chunkLines(departmentLines);
  const detailEmbeds: EmbedBuilder[] = [];
  const detailSections = Math.max(tagChunks.length, departmentChunks.length, 1);

  for (let index = 0; index < detailSections; index += 1) {
    const embed = new EmbedBuilder()
      .setTitle(
        '📋 Audit Details' +
          (detailSections > 1 ? ' • Page ' + (index + 1) + '/' + detailSections : ''),
      )
      .setFooter({ text: 'SupportForge • Overall audit to date' })
      .setTimestamp();

    if (tagChunks[index]) {
      embed.addFields({
        name:
          '🏷️ Tags created to date (' +
          tagCreations +
          ')' +
          (tagChunks.length > 1 ? ' • Part ' + (index + 1) + '/' + tagChunks.length : ''),
        value: tagChunks[index].join('\n'),
      });
    }

    if (departmentChunks[index]) {
      embed.addFields({
        name:
          '📂 Departments (' +
          departments.length +
          ')' +
          (departmentChunks.length > 1 ? ' • Part ' + (index + 1) + '/' + departmentChunks.length : ''),
        value: departmentChunks[index].join('\n'),
      });
    }

    if (index === 0) {
      embed.addFields({
        name: '📈 Additional metrics',
        value: metricsLines.join('\n').slice(0, 1024),
      });
    }

    detailEmbeds.push(embed);
  }

  const first = new EmbedBuilder()
    .setTitle('📊 SupportForge Overall Audit Summary • ' + guild.name)
    .setDescription(summaryLines.join('\n'))
    .addFields({ name: 'Priority distribution', value: priorityLines.join('\n') })
    .setFooter({ text: 'Persisted audit history + current live ticket snapshot' })
    .setTimestamp();

  return [first, ...detailEmbeds];
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
    await collapseAuditPanel(guild, channel);
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

export async function handleAuditInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith('sf:audit:')) return false;

  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: '❌ This audit control can only be used inside the SupportForge audit channel.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (!(interaction.channel.topic ?? '').startsWith(AUDIT_TOPIC)) {
    await interaction.reply({
      content: '❌ This is not the SupportForge audit channel.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.customId === AUDIT_RESTORE_CUSTOM_ID) {
    await interaction.deferUpdate();
    const current = await load();
    const store = getGuildStore(current, interaction.guild.id);
    const restore = interaction.channel.messages.cache.get(store.restoreMessageId ?? '') ??
      (await interaction.channel.messages.fetch({ limit: 100 })).find(
        (message) =>
          message.author.id === interaction.channel.client.user?.id &&
          message.components.some(
            (row) =>
              row.type === ComponentType.ActionRow &&
              row.components.some(
                (component) =>
                  'customId' in component &&
                  component.customId === AUDIT_RESTORE_CUSTOM_ID,
              ),
          ),
      );

    const panel = await interaction.channel.send({
      embeds: [buildAuditPanelEmbed(interaction.guild)],
      components: auditPanelComponents(),
    });
    if (restore) await restore.delete().catch(() => undefined);
    store.panelMessageId = panel.id;
    store.restoreMessageId = null;
    store.panelEventCheckpoint = store.events.length;
    await persist();
    return true;
  }

  if (interaction.customId === AUDIT_COLLAPSE_CUSTOM_ID) {
    await interaction.deferUpdate();

    const current = await load();
    const store = getGuildStore(current, interaction.guild.id);

    if (
      !store.panelMessageId ||
      store.events.length - store.panelEventCheckpoint < AUDIT_COLLAPSE_AFTER
    ) {
      return true;
    }

    const oldPanel =
      interaction.channel.messages.cache.get(store.panelMessageId) ??
      await interaction.channel.messages.fetch(store.panelMessageId).catch(() => null);

    if (!oldPanel) {
      store.panelMessageId = null;
      await persist();
      return true;
    }

    const movedPanel = await interaction.channel.send({
      embeds: [buildAuditPanelEmbed(interaction.guild)],
      components: auditPanelComponents(false),
    });

    await oldPanel.delete().catch(() => undefined);

    store.panelMessageId = movedPanel.id;
    store.panelEventCheckpoint = store.events.length;
    await persist();
    return true;
  }

  if (interaction.customId === AUDIT_SUMMARY_CUSTOM_ID) {
    await interaction.deferReply();
    const embeds = await generateOverallAuditSummary(interaction.guild);
    await interaction.editReply({ embeds });
    return true;
  }

  return false;
}

export async function resetAuditLogState(): Promise<void> {
  await writeQueue.catch(() => undefined);
  state = null;
  writeQueue = Promise.resolve();
}
