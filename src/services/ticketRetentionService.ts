import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type Client,
  type Message,
  type Guild,
  type TextChannel,
} from 'discord.js';

import { getAdvancedSettings, updateAdvancedSettings, type AdvancedGuildSettings } from './advancedSettingsService';
import {
  getPersistedTicketRecords,
  markPersistedTicketDeleted,
} from './ticketPersistenceService';
import { getField, getTicketStatus, isTicketTopic } from './ticketStateService';

export type RetentionScope = 'closed' | 'archive';

export interface RetentionSweepOptions {
  requestApproval?: boolean;
  requestedById?: string;
}

let timer: NodeJS.Timeout | undefined;

const DAY_MS = 86_400_000;

function retentionDays(settings: AdvancedGuildSettings, scope: RetentionScope): number {
  return scope === 'closed'
    ? settings.retention.closedDays
    : settings.retention.archiveDays;
}

const MAX_TICKET_RETENTION_DAYS = 365;

function effectiveDeletionAt(
  timestamp: number,
  createdAt: string,
  days: number,
  effectiveFrom: string | null,
): number {
  const normalDeadline =
    days === 0 ? Number.POSITIVE_INFINITY : timestamp + days * DAY_MS;
  const countdownDeadline = effectiveFrom && days > 0
    ? Date.parse(effectiveFrom) + days * DAY_MS
    : 0;
  const hardMaximum = Date.parse(createdAt) + MAX_TICKET_RETENTION_DAYS * DAY_MS;

  const policyDeadline = Number.isFinite(countdownDeadline)
    ? Math.max(normalDeadline, countdownDeadline)
    : normalDeadline;

  return Math.min(
    policyDeadline,
    Number.isFinite(hardMaximum) ? hardMaximum : Number.POSITIVE_INFINITY,
  );
}

function timestampForScope(
  topic: string,
  scope: RetentionScope,
): string | undefined {
  return getField(topic, scope === 'closed' ? 'closed_at' : 'archived_at');
}

async function findEligibleTickets(
  guild: Guild,
  scope: RetentionScope,
  settings?: AdvancedGuildSettings,
): Promise<TextChannel[]> {
  const resolvedSettings = settings ?? (await getAdvancedSettings(guild.id));
  const days = retentionDays(resolvedSettings, scope);
  const persistedTickets = await getPersistedTicketRecords(guild.id);
  const persistedByChannelId = new Map(persistedTickets.map((ticket) => [ticket.channelId, ticket]));

  const eligible: TextChannel[] = [];
  const requiredStatus = scope === 'closed' ? 'closed' : 'archived';
  const now = Date.now();
  const effectiveFrom =
    scope === 'closed'
      ? resolvedSettings.retention.closedEffectiveFrom
      : resolvedSettings.retention.archiveEffectiveFrom;

  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;

    const text = channel as TextChannel;
    const topic = text.topic ?? '';

    if (!isTicketTopic(topic)) continue;

    const persistedTicket = persistedByChannelId.get(text.id);
    const status = persistedTicket?.status ?? getTicketStatus(topic);

    if (status !== requiredStatus || !persistedTicket) continue;

    const timestampField = timestampForScope(topic, scope);
    if (!timestampField) continue;

    const timestamp = Date.parse(timestampField);
    if (!Number.isFinite(timestamp)) continue;

    if (now >= effectiveDeletionAt(timestamp, persistedTicket.createdAt, days, effectiveFrom)) {
      eligible.push(text);
    }
  }

  return eligible;
}

function approvalComponents(scope: RetentionScope): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('sf:settings:retention:approve:' + scope)
        .setLabel('Approve Deletion')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('sf:settings:retention:decline:' + scope)
        .setLabel('Decline')
        .setEmoji('✋')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function findSettingsChannel(guild: Guild): Promise<TextChannel | null> {
  const settings = await getAdvancedSettings(guild.id);
  if (settings.settingsChannelId) {
    const channel = guild.channels.cache.get(settings.settingsChannelId);
    if (channel?.type === ChannelType.GuildText) return channel;
  }

  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.topic?.startsWith('supportforge:settings'),
  );

  return existing?.type === ChannelType.GuildText ? existing : null;
}

export async function requestRetentionApproval(
  guild: Guild,
  scope: RetentionScope,
  eligibleChannels: TextChannel[],
  requestedById: string,
): Promise<void> {
  if (eligibleChannels.length === 0) return;

  const settings = await getAdvancedSettings(guild.id);
  if (settings.retention.pendingApprovals[scope]?.status === 'pending') return;

  const channel = await findSettingsChannel(guild);
  if (!channel) return;

  const days = retentionDays(settings, scope);
  const label = scope === 'closed' ? 'Closed tickets' : 'Archive tickets';
  const oldest = eligibleChannels
    .map((item) => timestampForScope(item.topic ?? '', scope))
    .filter((value): value is string => Boolean(value))
    .map(Date.parse)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];

  const approval = {
    scope,
    status: 'pending' as const,
    days,
    requestedById,
    requestedAt: new Date().toISOString(),
    eligibleChannelIds: eligibleChannels.map((item) => item.id),
    messageId: null,
  };

  await updateAdvancedSettings(guild.id, (current) => {
    current.retention.pendingApprovals[scope] = approval;
  });

  let message: Message;
  try {
    message = await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('⚠️ Retention approval required')
          .setDescription(
            `SupportForge found **${eligibleChannels.length}** ${label.toLowerCase()} that are already eligible for deletion under the **${days}-day** policy.\n\n` +
            `The oldest eligible record is ${oldest ? '<t:' + Math.floor(oldest / 1000) + ':R>' : 'unknown'}.\n\n` +
            `Deletion will **not** happen unless the requested administrator approves it below.`,
          )
          .addFields({
            name: 'Requested permission',
            value: `Delete ${label.toLowerCase()} older than **${days} days**.`,
          })
          .setFooter({ text: 'SupportForge • Retention safeguard' })
          .setTimestamp(),
      ],
      components: approvalComponents(scope),
    });
  } catch (error) {
    await updateAdvancedSettings(guild.id, (current) => {
      current.retention.pendingApprovals[scope] = null;
    });
    throw error;
  }

  await updateAdvancedSettings(guild.id, (current) => {
    const pending = current.retention.pendingApprovals[scope];
    if (pending) pending.messageId = message.id;
  });
}

export async function approveRetentionDeletion(
  guild: Guild,
  scope: RetentionScope,
  actorId: string,
): Promise<number> {
  const settings = await getAdvancedSettings(guild.id);
  const pending = settings.retention.pendingApprovals[scope];

  if (!pending) {
    throw new Error('No pending retention approval exists.');
  }

  if (pending.requestedById !== actorId && guild.ownerId !== actorId) {
    throw new Error('Only the administrator who was asked, or the server owner, can approve this deletion.');
  }

  const eligible = await findEligibleTickets(guild, scope, settings);
  let deleted = 0;

  for (const channel of eligible) {
    try {
      await channel.delete('SupportForge approved retention cleanup');
      deleted += 1;

      /*
       * Keep the durable ticket record after the Discord channel disappears.
       * This preserves lifetime history and lets overall audit summaries retain
       * the ticket's existence without keeping a live Discord resource.
       */
      await markPersistedTicketDeleted(
        channel.id,
        'SupportForge approved retention cleanup',
      );
    } catch (error) {
      console.warn(
        `⚠️ Retention cleanup could not fully process ${channel.id}:`,
        error,
      );
    }
  }

  await updateAdvancedSettings(guild.id, (current) => {
    current.retention.pendingApprovals[scope] = null;
  });

  return deleted;
}

export async function declineRetentionDeletion(
  guild: Guild,
  scope: RetentionScope,
  actorId: string,
): Promise<void> {
  const settings = await getAdvancedSettings(guild.id);
  const pending = settings.retention.pendingApprovals[scope];

  if (!pending) {
    throw new Error('No pending retention approval exists.');
  }

  if (pending.requestedById !== actorId && guild.ownerId !== actorId) {
    throw new Error('Only the administrator who was asked, or the server owner, can cancel this deletion.');
  }

  /*
   * A declined request must not remain as a non-pending sentinel. The
   * scheduler treats any pending-approval object as an existing request, so
   * retaining a "declined" object would permanently suppress future prompts.
   */
  await updateAdvancedSettings(guild.id, (current) => {
    current.retention.pendingApprovals[scope] = null;
  });
}

export async function getEligibleRetentionTickets(
  guild: Guild,
  scope: RetentionScope,
): Promise<TextChannel[]> {
  const settings = await getAdvancedSettings(guild.id);
  return findEligibleTickets(guild, scope, settings);
}

export async function clearRetentionEffectiveFrom(
  guildId: string,
  scope: RetentionScope,
): Promise<void> {
  await updateAdvancedSettings(guildId, (current) => {
    if (scope === 'closed') {
      current.retention.closedEffectiveFrom = null;
    } else {
      current.retention.archiveEffectiveFrom = null;
    }
  });
}

export async function runRetentionSweepForGuild(
  guild: Guild,
  options: RetentionSweepOptions = {},
): Promise<void> {
  const settings = await getAdvancedSettings(guild.id);

  for (const scope of ['closed', 'archive'] as const) {
    const days = retentionDays(settings, scope);
    if (days <= 0) continue;

    const eligible = await findEligibleTickets(guild, scope, settings);
    if (eligible.length === 0) continue;

    // Never silently delete. A pending approval freezes the batch until the user acts.
    if (
      settings.retention.pendingApprovals[scope] &&
      settings.retention.pendingApprovals[scope].status === 'pending'
    ) {
      continue;
    }

    if (options.requestApproval ?? true) {
      await requestRetentionApproval(
        guild,
        scope,
        eligible,
        options.requestedById ?? guild.ownerId,
      );
    }
  }
}

export function startTicketRetentionScheduler(client: Client): void {
  if (timer) return;

  const run = async () => {
    for (const guild of client.guilds.cache.values()) {
      await runRetentionSweepForGuild(guild, { requestApproval: true }).catch(
        (error) =>
          console.warn(
            '⚠️ Ticket retention sweep failed for ' + guild.id + ':',
            error,
          ),
      );
    }
  };

  void run();

  timer = setInterval(() => {
    void run();
  }, 60 * 60 * 1000);
}
