import {
  ActionRowBuilder,
  AuditLogEvent,
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
  type GuildBasedChannel,
  type Role,
  type TextChannel,
} from 'discord.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getGuildConfig, updateGuildConfig } from './configService';
import { getAdvancedSettings } from './advancedSettingsService';
import { ensureChannelPurposeMessage } from './channelPurposeService';
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
  overallSummary: string | null;
  accumulationEnabled: boolean;
  /**
   * Developer visibility is per moderator. Discord channel messages are
   * inherently visible to everyone who can read the channel, so internal
   * audit events are never published globally. These IDs only control each
   * moderator's private Developer View.
   */
  developerViewers: string[];
  /**
   * Legacy field retained so older audit-log files can still be loaded.
   * It is no longer used as a global switch.
   */
  developerMode: boolean;
  panelMessageId: string | null;
  restoreMessageId: string | null;
  panelEventCheckpoint: number;
  lastSetupDate: string | null;
}

interface AuditStore {
  version: 2;
  guilds: Record<string, AuditGuildStore>;
}

const AUDIT_TOPIC = 'supportforge:audit';
const AUDIT_NAME = '📒 supportforge-audit-log';
const DATA_DIR = join(process.cwd(), 'data');
const AUDIT_PATH = join(DATA_DIR, 'audit-log.json');
const AUDIT_BACKUP_PATH = join(DATA_DIR, 'audit-log.backup.json');

let state: AuditStore | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let dailyScheduler: NodeJS.Timeout | null = null;

function cloneGuildStore(): AuditGuildStore {
  return {
    events: [],
    summaries: {},
    overallSummary: null,
    accumulationEnabled: true,
    developerViewers: [],
    developerMode: false,
    panelMessageId: null,
    restoreMessageId: null,
    panelEventCheckpoint: 0,
    lastSetupDate: null,
  };
}

async function persist(): Promise<void> {
  if (!state) return;

  writeQueue = writeQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const persistedState = JSON.parse(JSON.stringify(state)) as AuditStore;
    for (const store of Object.values(persistedState.guilds)) {
      if (!store.accumulationEnabled) {
        store.events = [];
      }
    }
    const serialized = JSON.stringify(persistedState, null, 2);

    /*
     * Keep a second local copy so a damaged/missing primary audit file does
     * not destroy the historical record. This backup is deliberately
     * separate from Discord's channels and survives SupportForge channel
     * deletion.
     */
    await writeFile(AUDIT_PATH, serialized, 'utf8');
    await writeFile(AUDIT_BACKUP_PATH, serialized, 'utf8');
  });

  await writeQueue;
}

async function load(): Promise<AuditStore> {
  if (state) return state;

  await mkdir(DATA_DIR, { recursive: true });

  try {
    let raw: string;

    try {
      raw = await readFile(AUDIT_PATH, 'utf8');
    } catch {
      raw = await readFile(AUDIT_BACKUP_PATH, 'utf8');
    }

    let parsed: Partial<AuditStore>;
    try {
      parsed = JSON.parse(raw) as Partial<AuditStore>;
    } catch {
      const backup = await readFile(AUDIT_BACKUP_PATH, 'utf8');
      parsed = JSON.parse(backup) as Partial<AuditStore>;
    }

    const rawGuilds = parsed.guilds ?? {};
    const guilds: Record<string, AuditGuildStore> = {};

    for (const [guildId, rawStore] of Object.entries(rawGuilds)) {
      const store = rawStore as Partial<AuditGuildStore>;
      guilds[guildId] = {
        events: store.events ?? [],
        summaries: store.summaries ?? {},
        overallSummary: store.overallSummary ?? null,
        accumulationEnabled: store.accumulationEnabled ?? true,
        developerViewers: Array.isArray(store.developerViewers)
          ? store.developerViewers.filter((id): id is string => typeof id === 'string')
          : [],
        developerMode: false,
        panelMessageId: store.panelMessageId ?? null,
        restoreMessageId: store.restoreMessageId ?? null,
        panelEventCheckpoint: store.panelEventCheckpoint ?? 0,
        lastSetupDate: store.lastSetupDate ?? null,
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

function currentUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function previousCompletedUtcDateKey(): string {
  const now = new Date();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 1,
    ),
  ).toISOString().slice(0, 10);
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

/*
 * Every recorded event is part of the audit history and therefore belongs in
 * summaries. Developer mode controls whether internal/system events are
 * published to the normal visible feed, not whether they disappear from
 * reporting.
 */
function isReportableAuditEvent(_event: PersistedAuditEntry): boolean {
  return true;
}

const SUPPORTFORGE_NAME_PREFIXES = [
  'SupportForge.',
  'SupportForge •',
];

function hasSupportForgeName(name: string): boolean {
  return SUPPORTFORGE_NAME_PREFIXES.some((prefix) =>
    name.toLowerCase().startsWith(prefix.toLowerCase()),
  );
}

export function permissionOverwriteSignature(channel: GuildBasedChannel): string {
  if (!('permissionOverwrites' in channel)) {
    return '';
  }

  const entries = [...channel.permissionOverwrites.cache.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.bitfield.toString(),
      deny: overwrite.deny.bitfield.toString(),
    }));

  return JSON.stringify(entries);
}

export async function isSupportForgeManagedChannel(
  guild: Guild,
  channel: GuildBasedChannel,
): Promise<boolean> {
  const topic =
    channel.type === ChannelType.GuildText
      ? channel.topic ?? ''
      : '';

  if (topic.startsWith('supportforge:')) {
    return true;
  }

  const config = await getGuildConfig(guild.id);
  const settings = await getAdvancedSettings(guild.id);

  const configuredCategoryIds = new Set(
    [
      config.supportCategoryId,
      config.openCategoryId,
      settings.closedCategoryId,
      settings.archiveCategoryId,
      settings.statusCategories.claimedCategoryId,
      settings.statusCategories.pendingCategoryId,
      ...Object.values(config.departments).map(
        (department) => department.categoryId ?? null,
      ),
    ].filter((id): id is string => Boolean(id)),
  );

  const configuredIds = new Set([
    ...configuredCategoryIds,
    config.panelChannelId,
    config.transcriptChannelId,
    config.auditChannelId,
  ].filter((id): id is string => Boolean(id)));

  if (configuredIds.has(channel.id)) {
    return true;
  }

  /*
   * Any channel directly inside a SupportForge-managed category is part of
   * the managed scope, even when it has no SupportForge topic of its own.
   */
  if (channel.parentId && configuredCategoryIds.has(channel.parentId)) {
    return true;
  }

  if (
    channel.type === ChannelType.GuildCategory &&
    channel.name.toLowerCase() === 'support forge'
  ) {
    return true;
  }

  const parent =
    channel.parentId
      ? guild.channels.cache.get(channel.parentId)
      : undefined;

  const parentLooksManaged =
    Boolean(
      parent &&
      (
        hasSupportForgeName(parent.name) ||
        parent.name === 'Open' ||
        parent.name.startsWith('Open ')
      ),
    );

  return hasSupportForgeName(channel.name) ||
    parentLooksManaged ||
    (
      channel.type === ChannelType.GuildCategory &&
      (
        channel.name === 'Open' ||
        channel.name.startsWith('Open ')
      )
    );
}

type DiscordAuditTarget =
  | GuildBasedChannel
  | Role;

async function findRecentAuditExecutor(
  guild: Guild,
  auditType:
    | AuditLogEvent.ChannelCreate
    | AuditLogEvent.ChannelUpdate
    | AuditLogEvent.ChannelDelete
    | AuditLogEvent.RoleCreate
    | AuditLogEvent.RoleUpdate
    | AuditLogEvent.RoleDelete,
  targetId: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const logs = await guild.fetchAuditLogs({
      type: auditType,
      limit: 10,
    });

    const entry = logs.entries.find(
      (candidate) =>
        candidate.targetId === targetId &&
        Date.now() - candidate.createdTimestamp < 15_000,
    );

    const executor = entry?.executor;

    if (!executor) {
      return null;
    }

    return {
      id: executor.id,
      name: executor.tag || executor.username || executor.id,
    };
  } catch {
    return null;
  }
}

export async function isSupportForgeManagedRole(
  guild: Guild,
  role: Role,
): Promise<boolean> {
  const settings = await getAdvancedSettings(guild.id);
  const configuredIds = new Set(
    Object.values(settings.priorityRoles).filter(
      (id): id is string => Boolean(id),
    ),
  );

  return configuredIds.has(role.id) ||
    role.name.toLowerCase().startsWith('supportforge •');
}

export async function logDiscordMutation(
  guild: Guild,
  target: DiscordAuditTarget,
  action: string,
  detail: string,
  auditType:
    | AuditLogEvent.ChannelCreate
    | AuditLogEvent.ChannelUpdate
    | AuditLogEvent.ChannelDelete
    | AuditLogEvent.RoleCreate
    | AuditLogEvent.RoleUpdate
    | AuditLogEvent.RoleDelete,
): Promise<void> {
  try {
    const config = await getGuildConfig(guild.id);

    if (!config.supportCategoryId) {
      return;
    }

    const executor = await findRecentAuditExecutor(
      guild,
      auditType,
      target.id,
    );

    await recordAndPublish(
      guild,
      config.supportCategoryId,
      {
        event: action,
        actorId: executor?.id ?? 'discord-system',
        actorName: executor?.name ?? 'Discord / SupportForge',
        detail,
        category: 'system',
      },
    );
  } catch (error) {
    console.warn('⚠️ Discord mutation audit failed:', error);
  }
}

export async function logSystemEvent(
  guild: Guild,
  parentCategoryId: string,
  action: string,
  detail: string,
): Promise<void> {
  try {
    await recordAndPublish(guild, parentCategoryId, {
      event: action,
      actorId: 'supportforge-system',
      actorName: 'SupportForge',
      detail,
      category: 'system',
    });
  } catch (error) {
    console.warn('⚠️ SupportForge system audit failed:', error);
  }
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
    if (existing.parentId !== parentCategoryId) {
      await existing
        .setParent(parentCategoryId, { lockPermissions: false })
        .catch((error) => {
          console.warn('⚠️ Could not move the SupportForge audit channel into its container:', error);
        });
    }

    await ensureChannelPurposeMessage(
      existing,
      'This private channel stores SupportForge’s durable operational audit history. It records important ticket lifecycle actions, configuration changes, retention decisions, repairs, and other administrative events with responsible users and timestamps.',
    );
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

  await ensureChannelPurposeMessage(
    channel,
    'This private channel stores SupportForge’s durable operational audit history. It records important ticket lifecycle actions, configuration changes, retention decisions, repairs, and other administrative events with responsible users and timestamps.',
  );

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

  if (event.action === 'SETUP_COMPLETED') {
    store.lastSetupDate = dateKey(event.timestamp);
  }

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
        .setFooter({
        text:
          event.category === 'settings'
            ? 'Settings action'
            : event.category === 'system'
              ? 'System action'
              : 'Ticket action',
      })
        .setTimestamp(new Date(event.timestamp)),
    ],
  });
}

const AUDIT_PANEL_TITLE = '📒 SupportForge Audit Log';
const AUDIT_SUMMARY_CUSTOM_ID = 'sf:audit:summary';
const AUDIT_DAILY_CUSTOM_ID = 'sf:audit:daily';
const AUDIT_ACCUMULATE_CUSTOM_ID = 'sf:audit:accumulate';
const AUDIT_ACCUMULATE_CONFIRM_CUSTOM_ID = 'sf:audit:accumulate:confirm';
const AUDIT_ACCUMULATE_CANCEL_CUSTOM_ID = 'sf:audit:accumulate:cancel';
const AUDIT_REVERT_CUSTOM_ID = 'sf:audit:revert';
const AUDIT_REVERT_CONFIRM_CUSTOM_ID = 'sf:audit:revert:confirm';
const AUDIT_DEVELOPER_CUSTOM_ID = 'sf:audit:developer';
const AUDIT_DEVELOPER_ON_CUSTOM_ID = 'sf:audit:developer:on';
const AUDIT_DEVELOPER_OFF_CUSTOM_ID = 'sf:audit:developer:off';
const AUDIT_QUICK_SUMMARY_CUSTOM_ID = 'sf:audit:quick-summary';
const AUDIT_COLLAPSE_CUSTOM_ID = 'sf:audit:collapse-panel';
const AUDIT_RESTORE_CUSTOM_ID = 'sf:audit:restore-panel';

function auditPanelComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(AUDIT_COLLAPSE_CUSTOM_ID)
        .setLabel('Move Audit Panel Down')
        .setEmoji('⬇️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(AUDIT_DAILY_CUSTOM_ID)
        .setLabel('Daily Summary')
        .setEmoji('📅')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(AUDIT_ACCUMULATE_CUSTOM_ID)
        .setLabel('Audit Data Settings')
        .setEmoji('💾')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(AUDIT_DEVELOPER_CUSTOM_ID)
        .setLabel('Developer Options')
        .setEmoji('🛠️')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function auditRestoreComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [];
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
    const restore = channel.messages.cache.get(store.restoreMessageId) ??
      await channel.messages.fetch(store.restoreMessageId).catch(() => null);

    if (restore) {
      await restore.delete().catch(() => undefined);
    }

    store.restoreMessageId = null;
    await persist();
  }

  if (store.panelMessageId) {
    const panel = channel.messages.cache.get(store.panelMessageId);
    if (panel?.embeds.some((embed) => embed.title === AUDIT_PANEL_TITLE)) {
      await panel.edit({
        embeds: [buildAuditPanelEmbed(guild)],
        components: auditPanelComponents(),
      }).catch(() => undefined);
      return;
    }

    store.panelMessageId = null;
  }

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (recent) {
    const existingRestores = recent.filter(
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

    for (const restore of existingRestores) {
      await restore.delete().catch(() => undefined);
    }

    const existingPanel = recent.find(
      (message) =>
        message.author.id === channel.client.user?.id &&
        message.embeds.some((embed) => embed.title === AUDIT_PANEL_TITLE),
    );
    if (existingPanel) {
      store.panelMessageId = existingPanel.id;
      await existingPanel
        .edit({
          embeds: [buildAuditPanelEmbed(guild)],
          components: auditPanelComponents(),
        })
        .catch(() => undefined);
      await persist();
      return;
    }
  }

  const panel = await channel.send({
    embeds: [buildAuditPanelEmbed(guild)],
    components: auditPanelComponents(),
  });

  store.panelMessageId = panel.id;
  store.restoreMessageId = null;
  store.panelEventCheckpoint = store.events.length;
  await persist();
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
      departmentId: getField(topic, 'department') ?? null,
      openedAt: getField(topic, 'opened_at') ?? null,
    });
  }

  return tickets;
}

function formatAuditDate(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp.slice(0, 10) : date.toISOString().slice(0, 10);
}

function buildPrivateDeveloperAuditEmbeds(guild: Guild): Promise<EmbedBuilder[]> {
  return load().then((current) => {
    const store = getGuildStore(current, guild.id);
    const internalEvents = store.events
      .filter((event) => event.category !== 'ticket')
      .slice(-24)
      .reverse();

    const embeds: EmbedBuilder[] = [];
    const chunks: PersistedAuditEntry[][] = [];

    for (let index = 0; index < internalEvents.length; index += 8) {
      chunks.push(internalEvents.slice(index, index + 8));
    }

    if (!chunks.length) {
      return [
        new EmbedBuilder()
          .setTitle('🛠️ Private Developer Audit View')
          .setDescription(
            'No internal settings/system audit events are currently recorded.\n\n' +
            'This view is private to the moderator who enabled Developer View.',
          )
          .setFooter({ text: guild.name + ' • Private Developer View' })
          .setTimestamp(),
      ];
    }

    for (let index = 0; index < chunks.length; index += 1) {
      const lines = chunks[index].map((event) => {
        const detail = event.detail?.replace(/\s+/g, ' ').trim();
        return (
          '• <t:' +
          Math.floor(new Date(event.timestamp).getTime() / 1000) +
          ':R> • **' +
          actionLabel(event.action) +
          '** • ' +
          event.actorName +
          (event.category === 'system' ? ' • system' : ' • settings') +
          (detail ? ' • ' + detail.slice(0, 180) : '')
        );
      });

      embeds.push(
        new EmbedBuilder()
          .setTitle(
            '🛠️ Private Developer Audit View' +
              (chunks.length > 1 ? ' • Page ' + (index + 1) + '/' + chunks.length : ''),
          )
          .setDescription(lines.join('\n'))
          .setFooter({
            text:
              guild.name +
              ' • Private Developer View • ' +
              internalEvents.length +
              ' internal events shown',
          })
          .setTimestamp(),
      );
    }

    return embeds;
  });
}

async function generateOverallAuditSummary(
  guild: Guild,
  includeInternalEvents = false,
): Promise<EmbedBuilder[]> {
  const current = await load();
  const store = getGuildStore(current, guild.id);
  const visibleAuditEvents = store.events.filter(
    (event) => event.category === 'ticket' || includeInternalEvents,
  );
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

  const lifetimeCounts = new Map<TicketStatus, number>();
  for (const ticket of ticketRecords) {
    lifetimeCounts.set(
      ticket.status,
      (lifetimeCounts.get(ticket.status) ?? 0) + 1,
    );
  }

  const lifetimeOpen =
    (lifetimeCounts.get('open') ?? 0) +
    (lifetimeCounts.get('claimed') ?? 0) +
    (lifetimeCounts.get('pending') ?? 0) +
    (lifetimeCounts.get('reopened') ?? 0);
  const lifetimeClaimed = lifetimeCounts.get('claimed') ?? 0;
  const lifetimePending = lifetimeCounts.get('pending') ?? 0;
  const lifetimeArchived = lifetimeCounts.get('archived') ?? 0;
  const lifetimeClosed =
    (lifetimeCounts.get('closed') ?? 0) + lifetimeArchived;
  const ticketCreationEvents = visibleAuditEvents.filter((event) => event.action === 'TICKET_CREATED').length;
  const ticketsCreatedToDate = Math.max(
    ticketRecords.length,
    liveTickets.length,
    ticketCreationEvents,
  );

  const managedCategoryIds = new Set(
    [
      config.supportCategoryId,
      config.openCategoryId,
      settings.closedCategoryId,
      settings.archiveCategoryId,
      settings.statusCategories.claimedCategoryId,
      settings.statusCategories.pendingCategoryId,
      ...Object.values(config.departments).map(
        (department) => department.categoryId ?? null,
      ),
    ].filter((id): id is string => Boolean(id)),
  );

  const nonCategoryChannels = guild.channels.cache.filter(
    (channel) => channel.type !== ChannelType.GuildCategory,
  ).size;

  const categoriesCurrentlyInServer = guild.channels.cache.filter(
    (channel) => channel.type === ChannelType.GuildCategory,
  ).size;

  const managedChannels = guild.channels.cache.filter(
    (channel) =>
      channel.type !== ChannelType.GuildCategory &&
      (
        (channel.type === ChannelType.GuildText &&
          channel.topic?.startsWith('supportforge:')) ||
        channel.name === '📄 support-transcripts' ||
        channel.name === '📒 supportforge-audit-log' ||
        channel.name === 'supportforge-settings' ||
        channel.name.startsWith('SupportForge.') ||
        channel.name.startsWith('SupportForge • Closed') ||
        channel.name.startsWith('SupportForge • Archive') ||
        (channel.parentId && managedCategoryIds.has(channel.parentId))
      ),
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

  const tagCreationEvents = visibleAuditEvents.filter((event) => event.action === 'TAG_ADDED');
  const tagCreations = tagCreationEvents.length;
  const reportableEvents = visibleAuditEvents.filter(isReportableAuditEvent);
  const settingsActions = reportableEvents.filter((event) => event.category === 'settings').length;
  const ticketActions = reportableEvents.filter((event) => event.category === 'ticket').length;
  const priorityRolesCreated = reportableEvents.filter((event) => event.action === 'PRIORITY_ROLE_CREATED').length;
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
    '**Lifetime recorded statuses**',
    '**Open chats to date:** ' + lifetimeOpen + ' *(includes ' + lifetimeClaimed + ' claimed, ' + lifetimePending + ' pending, and reopened chats)*',
    '**Claimed chats recorded:** ' + lifetimeClaimed,
    '**Pending chats recorded:** ' + lifetimePending,
    '**Closed chats to date:** ' + lifetimeClosed + ' *(includes ' + lifetimeArchived + ' archived)*',
    '**Archived chats to date:** ' + lifetimeArchived,
    '',
    '**Channels currently in server:** ' + nonCategoryChannels,
    '**Categories currently in server:** ' + categoriesCurrentlyInServer,
    '**SupportForge-managed channels currently present:** ' + managedChannels,
    '**Ticket channels created to date:** ' + ticketsCreatedToDate,
    '',
    '**Existing departments:** ' + departments.length,
    '**Active custom tags:** ' + tags.length,
    '**Tag creations recorded:** ' + tagCreations,
    '**Audit entries visible in this view:** ' + visibleAuditEvents.length,
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

  const actionCounts = new Map<string, number>();
  for (const event of reportableEvents) {
    actionCounts.set(
      event.action,
      (actionCounts.get(event.action) ?? 0) + 1,
    );
  }

  const actionBreakdown = [...actionCounts.entries()]
    .sort((a, b) => b[1] - a[1]);

  const metricsLines = [
    '**Ticket lifecycle audit actions:** ' + ticketActions,
    '**Settings actions:** ' + settingsActions,
    '**Categories created:** ' + (actionCounts.get('CATEGORY_CREATED') ?? 0),
    '**Categories deleted:** ' + (actionCounts.get('CATEGORY_DELETED') ?? 0),
    '**Channels created:** ' + (actionCounts.get('CHANNEL_CREATED') ?? 0),
    '**Channels renamed:** ' + (actionCounts.get('CHANNEL_RENAMED') ?? 0),
    '**Channels moved/reordered:** ' +
      ((actionCounts.get('CHANNEL_MOVED') ?? 0) + (actionCounts.get('CHANNEL_REORDERED') ?? 0)),
    '**Permission changes:** ' + (actionCounts.get('CHANNEL_PERMISSIONS_CHANGED') ?? 0),
    '**Channel deletions:** ' + (actionCounts.get('CHANNEL_DELETED') ?? 0),
    '**Channel settings changes:** ' + (actionCounts.get('CHANNEL_SETTINGS_CHANGED') ?? 0),
    '**Ticket panel moves:** ' +
      ((actionCounts.get('TICKET_PANEL_MOVED') ?? 0) + (actionCounts.get('TICKET_PANEL_AUTO_MOVED') ?? 0)),
    '**Priority roles created:** ' + priorityRolesCreated,
    '**Roles created:** ' + (actionCounts.get('ROLE_CREATED') ?? 0),
    '**Roles updated:** ' + (actionCounts.get('ROLE_UPDATED') ?? 0),
    '**Roles deleted:** ' + (actionCounts.get('ROLE_DELETED') ?? 0),
    '**Retention reviewed/approved/declined:** ' +
      ((actionCounts.get('RETENTION_REVIEWED') ?? 0) +
        (actionCounts.get('RETENTION_APPROVED') ?? 0) +
        (actionCounts.get('RETENTION_DECLINED') ?? 0)),
    '**Ticket metadata changes:** ' +
      ((actionCounts.get('TICKET_USER_ADDED') ?? 0) +
        (actionCounts.get('TICKET_PRIORITY_CHANGED') ?? 0) +
        (actionCounts.get('TICKET_TAG_ADDED') ?? 0)),
    '**Retention-deleted ticket records:** ' + retentionEligible,
    '**Retention policy:** closed ' + (settings.retention.closedDays === 0 ? 'unlimited' : settings.retention.closedDays + ' days') + ' • archive ' + (settings.retention.archiveDays === 0 ? 'unlimited' : settings.retention.archiveDays + ' days'),
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

    const actionStart = index * 16;
    const actionChunk = actionBreakdown.slice(actionStart, actionStart + 16);
    if (actionChunk.length) {
      embed.addFields({
        name: '🧾 Audit action breakdown',
        value: actionChunk
          .map(([action, count]) => '• **' + actionLabel(action) + ':** ' + count)
          .join('\n')
          .slice(0, 1024),
      });
    }

    detailEmbeds.push(embed);
  }

  const recentAuditLines = reportableEvents
    .slice(-8)
    .reverse()
    .map((event) => {
      const detail = event.detail?.replace(/\s+/g, ' ').trim();
      return '• <t:' +
        Math.floor(new Date(event.timestamp).getTime() / 1000) +
        ':R> • **' +
        actionLabel(event.action) +
        '** • ' +
        event.actorName +
        (event.ticketNumber ? ' • Ticket #' + event.ticketNumber : '') +
        (detail ? ' • ' + detail.slice(0, 140) : '');
    });

  const first = new EmbedBuilder()
    .setTitle('📊 SupportForge Overall Audit Summary • ' + guild.name)
    .setDescription(summaryLines.join('\n'))
    .addFields(
      {
        name: 'Recent Audits',
        value: recentAuditLines.length
          ? recentAuditLines.join('\n').slice(0, 1024)
          : '• No significant changes have been recorded.',
      },
      { name: 'Priority distribution', value: priorityLines.join('\n') },
    )
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

  /*
   * Store every event, but only publish user-significant events to the visible
   * audit channel. Internal metadata changes stay in the durable audit store.
   */
  const current = await load();
  const store = getGuildStore(current, guild.id);

  if (!isReportableAuditEvent(record) || record.category !== 'ticket') {
    return;
  }

  try {
    const channel = await getOrCreateAuditChannel(guild, parentCategoryId);
    await sendAuditEntry(channel, record);

    const ticketEventCount = store.events.filter(
      (item) => isReportableAuditEvent(item) && item.category === 'ticket',
    ).length;

    if (
      ticketEventCount > 0 &&
      ticketEventCount % 12 === 0
    ) {
      await channel.send({
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(AUDIT_QUICK_SUMMARY_CUSTOM_ID)
              .setLabel('Summarise Everything')
              .setEmoji('📊')
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      }).catch(() => undefined);
    }
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

function buildNoActivityDailySummaryEmbed(
  guild: Guild,
  date: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`📊 Daily Audit • ${date}`)
    .setDescription(
      `**Date:** ${date} (UTC)\n\nNo SupportForge audit data was recorded for this day. No significant SupportForge changes were detected.`,
    )
    .setFooter({ text: 'SupportForge • Daily audit marker (UTC)' })
    .setTimestamp();
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

  const recent = events
    .slice(-8)
    .reverse()
    .map((event) => {
      const detail = event.detail?.replace(/\s+/g, ' ').trim();
      return '• <t:' +
        Math.floor(new Date(event.timestamp).getTime() / 1000) +
        ':R> • **' +
        actionLabel(event.action) +
        '** • ' +
        event.actorName +
        (event.ticketNumber ? ' • Ticket #' + event.ticketNumber : '') +
        (detail ? ' • ' + detail.slice(0, 160) : '');
    });

  const lines = [
    `**Date:** ${date} (UTC)`,
    `**Significant actions:** ${events.length}`,
    '',
    '**Tickets**',
    `• Created: ${count('TICKET_CREATED')}`,
    `• Closed: ${count('TICKET_CLOSED')}`,
    `• Panel moves: ${count('TICKET_PANEL_MOVED')}`,
    `• User changes: ${count('TICKET_USER_ADDED')}`,
    `• Priority changes: ${count('TICKET_PRIORITY_CHANGED')}`,
    `• Tag changes: ${count('TICKET_TAG_ADDED')}`,
    `• Internal notes: ${count('INTERNAL_NOTE')}`,
    '',
    '**Configuration**',
    `• Departments added/removed: ${count('DEPARTMENT_ADDED') + count('DEPARTMENT_REMOVED')}`,
    `• Tier changes: ${count('TIER_CHANGED')}`,
    `• Panel/settings changes: ${count('PANEL_TOGGLE') + count('PANEL_SETTINGS_CHANGED')}`,
    `• Ticket defaults: ${count('TICKET_DEFAULTS_CHANGED')}`,
    `• Retention changes: ${count('RETENTION_CHANGED')}`,
    `• Appearance changes: ${count('APPEARANCE_CHANGED')}`,
    `• Tags added/removed: ${count('TAG_ADDED') + count('TAG_REMOVED')}`,
    '',
    '**Infrastructure**',
    `• Categories created/deleted: ${count('CATEGORY_CREATED') + count('CATEGORY_DELETED')}`,
    `• Channels created: ${count('CHANNEL_CREATED')}`,
    `• Channels renamed: ${count('CHANNEL_RENAMED')}`,
    `• Channels moved/reordered: ${count('CHANNEL_MOVED') + count('CHANNEL_REORDERED')}`,
    `• Permission changes: ${count('CHANNEL_PERMISSIONS_CHANGED')}`,
    `• Channel settings changes: ${count('CHANNEL_SETTINGS_CHANGED')}`,
    `• Channel deletions: ${count('CHANNEL_DELETED')}`,
    `• Roles created/updated/deleted: ${count('ROLE_CREATED') + count('ROLE_UPDATED') + count('ROLE_DELETED')}`,
    '',
    '**Recent Audits**',
    ...(recent.length ? recent : ['• No significant changes have been recorded.']),
  ];

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
  /*
   * A daily summary is only valid for a completed UTC calendar day.
   * This guard is deliberately inside the publisher as a second line of
   * defence, so no caller can accidentally publish today's partial data.
   */
  if (date >= currentUtcDateKey()) {
    return;
  }

  const current = await load();
  const store = getGuildStore(current, guild.id);

  if (store.summaries[date]) return;

  const config = await getGuildConfig(guild.id);
  if (!config.supportCategoryId) return;

  const events = store.events.filter((event) => dateKey(event.timestamp) === date);
  const reportableEvents = events.filter(
    (event) => isReportableAuditEvent(event) && event.category === 'ticket',
  );
  const channel = await getOrCreateAuditChannel(guild, config.supportCategoryId);

  const dailyEmbed = reportableEvents.length
    ? buildDailySummaryEmbed(guild, date, reportableEvents)
    : buildNoActivityDailySummaryEmbed(guild, date);

  await channel.send({ embeds: [dailyEmbed] });
  store.summaries[date] = JSON.stringify(dailyEmbed.toJSON());
  await persist();
}

async function removeInvalidCurrentDaySummaries(
  guild: Guild,
  currentDate: string,
): Promise<void> {
  const current = await load();
  const store = getGuildStore(current, guild.id);
  let stateChanged = false;

  /*
   * Older SupportForge versions could leave behind a summary for the
   * current UTC day. That message is permanently invalid because that
   * calendar day has not finished yet. Remove the stale visible message
   * and its persisted marker so the completed-day scheduler can recreate
   * the correct summary tomorrow.
   */
  for (const date of Object.keys(store.summaries)) {
    if (date >= currentDate) {
      delete store.summaries[date];
      stateChanged = true;
    }
  }

  const channel = await findAuditChannel(guild);
  if (channel) {
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);

    if (recent) {
      const invalidSummaries = recent.filter((message) => {
        if (message.author.id !== channel.client.user?.id) return false;

        const embed = message.embeds[0];
        const title = embed?.title ?? '';
        const footer = embed?.footer?.text ?? '';

        const match = title.match(
          /^📊 Daily Audit(?: Summary)? • (\d{4}-\d{2}-\d{2})$/,
        );

        return Boolean(
          match &&
          match[1] >= currentDate &&
          (
            footer === 'SupportForge • Daily audit summary (UTC)' ||
            footer === 'SupportForge • Daily audit marker (UTC)'
          ),
        );
      });

      for (const message of invalidSummaries.values()) {
        await message.delete().catch(() => undefined);
      }
    }
  }

  if (stateChanged) {
    await persist();
  }
}

async function runDailySummarySweep(client: Client): Promise<void> {
  const currentDate = currentUtcDateKey();
  const previousDate = previousCompletedUtcDateKey();

  for (const guild of client.guilds.cache.values()) {
    try {
      await removeInvalidCurrentDaySummaries(guild, currentDate);
      await publishDailySummary(guild, previousDate);
    } catch (error) {
      console.warn(`⚠️ Daily audit summary skipped for ${guild.id}:`, error);
    }
  }
}

function nextUtcMidnightDelay(): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    ),
  );

  return Math.max(1_000, next.getTime() - now.getTime());
}

export function startAuditDailySummaryScheduler(client: Client): void {
  if (dailyScheduler) return;

  /*
   * Reconcile any stale current-day summary left by an older build, then
   * backfill exactly one completed UTC calendar day. There is never a
   * summary for the currently active UTC date.
   */
  void runDailySummarySweep(client);

  const scheduleNext = (): void => {
    dailyScheduler = setTimeout(() => {
      void runDailySummarySweep(client);
      scheduleNext();
    }, nextUtcMidnightDelay());

    dailyScheduler.unref();
  };

  scheduleNext();
}

async function saveOverallSummary(guild: Guild): Promise<void> {
  const embeds = await generateOverallAuditSummary(guild, false);
  const current = await load();
  const store = getGuildStore(current, guild.id);
  store.overallSummary = JSON.stringify(embeds.map((embed) => embed.toJSON()));
  await persist();
}

export async function prepareFactoryResetAuditRetention(guild: Guild, accumulate: boolean): Promise<void> {
  const current = await load();
  const store = getGuildStore(current, guild.id);
  store.accumulationEnabled = accumulate;
  await saveOverallSummary(guild);
  if (!accumulate) store.events = [];
  await persist();
}

export async function setAuditAccumulation(guildId: string, enabled: boolean): Promise<void> {
  const current = await load();
  const store = getGuildStore(current, guildId);
  store.accumulationEnabled = enabled;
  if (!enabled) store.events = [];
  await persist();
}

export async function getAuditAccumulation(guildId: string): Promise<boolean> {
  const current = await load();
  return getGuildStore(current, guildId).accumulationEnabled;
}

export async function refreshAuditPanel(guild: Guild): Promise<void> {
  const channel = await findAuditChannel(guild);
  if (!channel) return;
  await ensureAuditPanel(guild, channel);
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
    const auditChannel = interaction.channel;
    const restore = auditChannel.messages.cache.get(store.restoreMessageId ?? '') ??
      (await auditChannel.messages.fetch({ limit: 100 })).find(
        (message) =>
          message.author.id === auditChannel.client.user?.id &&
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

    if (!store.panelMessageId) {
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
      components: auditPanelComponents(),
    });

    await oldPanel.delete().catch(() => undefined);

    store.panelMessageId = movedPanel.id;
    store.panelEventCheckpoint = store.events.length;
    await persist();
    return true;
  }

  if (
    interaction.customId === AUDIT_DEVELOPER_CUSTOM_ID ||
    interaction.customId === AUDIT_DEVELOPER_ON_CUSTOM_ID ||
    interaction.customId === AUDIT_DEVELOPER_OFF_CUSTOM_ID
  ) {
    const member = await interaction.guild.members
      .fetch(interaction.user.id)
      .catch(() => null);

    const config = await getGuildConfig(interaction.guild.id);
    const staffRoleIds = new Set(
      Object.values(config.departments)
        .map((department) => department.staffRoleId)
        .filter((id): id is string => Boolean(id)),
    );

    const isModerator =
      Boolean(
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
        member?.roles.cache.some((role) => staffRoleIds.has(role.id)),
      );

    if (!isModerator) {
      await interaction.reply({
        content: '❌ Developer audit tools are restricted to SupportForge moderators.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const current = await load();
    const store = getGuildStore(current, interaction.guild.id);
    const isEnabled = store.developerViewers.includes(interaction.user.id);

    if (interaction.customId === AUDIT_DEVELOPER_ON_CUSTOM_ID) {
      if (!isEnabled) {
        store.developerViewers.push(interaction.user.id);
        await persist();
      }
    } else if (interaction.customId === AUDIT_DEVELOPER_OFF_CUSTOM_ID) {
      store.developerViewers = store.developerViewers.filter(
        (id) => id !== interaction.user.id,
      );
      await persist();
    }

    const enabledNow = store.developerViewers.includes(interaction.user.id);

    await interaction.reply({
      content: enabledNow
        ? '🛠️ **Developer View is ON for you only.** Internal settings/system audit events remain hidden from the shared audit channel and are shown only in your private developer view.'
        : '🛠️ **Developer View is OFF for you.** You will receive the normal moderator audit view.',
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(AUDIT_DEVELOPER_ON_CUSTOM_ID)
            .setLabel('Enable My Developer View')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(enabledNow),
          new ButtonBuilder()
            .setCustomId(AUDIT_DEVELOPER_OFF_CUSTOM_ID)
            .setLabel('Disable My Developer View')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!enabledNow),
        ),
      ],
      embeds: enabledNow
        ? await buildPrivateDeveloperAuditEmbeds(interaction.guild)
        : [],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.customId === AUDIT_QUICK_SUMMARY_CUSTOM_ID) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const current = await load();
    const store = getGuildStore(current, interaction.guild.id);
    const includeInternalEvents = store.developerViewers.includes(interaction.user.id);
    const embeds = await generateOverallAuditSummary(
      interaction.guild,
      includeInternalEvents,
    );
    await interaction.editReply({ embeds });
    return true;
  }

  if (interaction.customId === AUDIT_SUMMARY_CUSTOM_ID) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const config = await getGuildConfig(interaction.guild.id);
    if (config.supportCategoryId) {
      const current = await load();
      const store = getGuildStore(current, interaction.guild.id);
      const includeInternalEvents = store.developerViewers.includes(interaction.user.id);
      const embeds = await generateOverallAuditSummary(
        interaction.guild,
        includeInternalEvents,
      );
      if (!includeInternalEvents) {
        store.overallSummary = JSON.stringify(embeds.map((embed) => embed.toJSON()));
      }
      await persist();
      await interaction.editReply({ embeds });
    } else {
      const current = await load();
      const store = getGuildStore(current, interaction.guild.id);
      if (!store.overallSummary) {
        await interaction.editReply('No saved overall summary is available yet.');
      } else {
        try {
          const embeds = JSON.parse(store.overallSummary).map((item: unknown) => EmbedBuilder.from(item as Parameters<typeof EmbedBuilder.from>[0]));
          await interaction.editReply({ embeds });
        } catch {
          await interaction.editReply('The saved overall summary could not be restored.');
        }
      }
    }
    return true;
  }

  if (interaction.customId === AUDIT_DAILY_CUSTOM_ID) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const current = await load();
    const store = getGuildStore(current, interaction.guild.id);
    const includeInternalEvents = store.developerViewers.includes(interaction.user.id);

    /*
     * Normal moderators receive the shared, persisted daily summary.
     * Developer View generates the same day privately from raw events so
     * internal settings/system activity never leaks into the shared view.
     */
    if (includeInternalEvents) {
      const completedDates = Object.keys(store.summaries).sort();
      const date = completedDates.pop();

      if (!date) {
        await interaction.editReply('No completed daily summary has been saved yet.');
        return true;
      }

      const events = store.events.filter(
        (event) => dateKey(event.timestamp) === date,
      );

      if (!events.length) {
        await interaction.editReply({
          embeds: [buildNoActivityDailySummaryEmbed(interaction.guild, date)],
        });
        return true;
      }

      await interaction.editReply({
        embeds: [buildDailySummaryEmbed(interaction.guild, date, events)],
      });
      return true;
    }

    const date = Object.keys(store.summaries).sort().pop();
    const raw = date ? store.summaries[date] : null;
    if (!raw) {
      await interaction.editReply('No completed daily summary has been saved yet.');
      return true;
    }

    try {
      await interaction.editReply({
        embeds: [EmbedBuilder.from(JSON.parse(raw))],
      });
    } catch {
      await interaction.editReply('The saved daily summary could not be restored.');
    }
    return true;
  }

  if (interaction.customId === AUDIT_ACCUMULATE_CUSTOM_ID) {
    const enabled = await getAuditAccumulation(interaction.guild.id);
    await interaction.reply({
      content: enabled
        ? 'Audit accumulation is enabled. Retained raw events can be reverted while saved summaries remain.'
        : 'Audit accumulation is disabled. Only summaries are retained.',
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(enabled ? AUDIT_REVERT_CUSTOM_ID : AUDIT_ACCUMULATE_CONFIRM_CUSTOM_ID)
          .setLabel(enabled ? 'Revert & Clear Raw Audits' : 'Enable Accumulation')
          .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(AUDIT_ACCUMULATE_CANCEL_CUSTOM_ID).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.customId === AUDIT_ACCUMULATE_CONFIRM_CUSTOM_ID || interaction.customId === AUDIT_REVERT_CONFIRM_CUSTOM_ID) {
    await interaction.deferUpdate();
    await setAuditAccumulation(interaction.guild.id, interaction.customId === AUDIT_ACCUMULATE_CONFIRM_CUSTOM_ID);
    await interaction.followUp({
      content: interaction.customId === AUDIT_ACCUMULATE_CONFIRM_CUSTOM_ID ? 'Audit accumulation enabled.' : 'Raw audit accumulation reverted. Saved summaries remain.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.customId === AUDIT_REVERT_CUSTOM_ID) {
    await interaction.reply({
      content: 'Confirming this clears retained individual audits but keeps saved summaries.',
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(AUDIT_REVERT_CONFIRM_CUSTOM_ID).setLabel('Confirm Revert').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(AUDIT_ACCUMULATE_CANCEL_CUSTOM_ID).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.customId === AUDIT_ACCUMULATE_CANCEL_CUSTOM_ID) {
    await interaction.deferUpdate();
    await interaction.deleteReply().catch(() => undefined);
    return true;
  }

  return false;
}

export async function resetAuditLogState(): Promise<void> {
  await writeQueue.catch(() => undefined);
  state = null;
  writeQueue = Promise.resolve();
}
