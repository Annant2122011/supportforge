import {
  ChannelType,
  EmbedBuilder,
  type Client,
  type Guild,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';

import {
  evaluateTicketInactivity,
  getTicketInactivityAnchor,
  normalizeInactivitySettings,
} from '../core/domain/ticketInactivityPolicy';
import {
  getAdvancedSettings,
} from './advancedSettingsService';
import { getGuildConfig } from './configService';
import {
  closePersistedTicketIfActivityUnchanged,
  getPersistedTicket,
  getPersistedTicketRecords,
  updatePersistedTicketMetadata,
  type PersistedTicket,
} from './ticketPersistenceService';
import { generateTranscript } from './transcriptService';
import { getField, isTicketTopic, setField } from './ticketStateService';
import { projectDurableTicketTopic } from './ticketTopicProjectionService';
import { refreshPrivateThreadPanel } from './privateThreadTicketService';
import { logTicketEvent } from './auditLogService';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const WARNING_MARKER_PREFIX = 'ResolveX inactivity warning';
const TRANSCRIPT_MARKER_PREFIX = '[ResolveX inactivity transcript';
const SYSTEM_ACTOR = {
  id: 'supportforge-system',
  attribution: 'actorKnown' as const,
  confidence: 'high' as const,
};

type InactivityChannel = TextChannel | ThreadChannel;

let scheduler: ReturnType<typeof setInterval> | null = null;

function isActiveStatus(status: string): boolean {
  return status === 'open' || status === 'claimed' || status === 'pending' || status === 'reopened';
}

function metadataString(ticket: PersistedTicket, key: string): string | null {
  const value = ticket.metadata[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function warningMarker(channelId: string, anchorAt: string): string {
  return WARNING_MARKER_PREFIX + ' | ticket=' + channelId + ' | activity=' + anchorAt;
}

function transcriptMarker(channelId: string, anchorAt: string): string {
  return TRANSCRIPT_MARKER_PREFIX + ': ' + channelId + ':' + anchorAt + ']';
}

function embedFooter(message: Message): string | null {
  for (const embed of message.embeds) {
    const footer = embed.footer?.text;
    if (footer) return footer;
  }
  return null;
}

async function resolveTicketChannel(guild: Guild, ticket: PersistedTicket): Promise<InactivityChannel | null> {
  const channel = guild.channels.cache.get(ticket.channelId)
    ?? await guild.channels.fetch(ticket.channelId);
  if (!channel) return null;

  if (ticket.metadata.workspaceKind === 'private-thread') {
    if (channel.type !== ChannelType.PrivateThread) return null;
    const topic = metadataString(ticket, 'ticketTopic');
    return topic && isTicketTopic(topic) ? channel as ThreadChannel : null;
  }

  if (channel.type !== ChannelType.GuildText) return null;
  const topic = channel.topic ?? metadataString(ticket, 'ticketTopic') ?? '';
  return isTicketTopic(topic) ? channel as TextChannel : null;
}

function isCurrentActiveTicket(ticket: PersistedTicket | undefined, anchorAt: string): ticket is PersistedTicket {
  if (!ticket || ticket.deletedAt || !isActiveStatus(ticket.status)) return false;
  return getTicketInactivityAnchor(ticket) === anchorAt;
}

async function findWarningMessage(
  channel: InactivityChannel,
  client: Client,
  marker: string,
  knownMessageId: string | null,
): Promise<Message | null> {
  if (knownMessageId) {
    const known = await channel.messages.fetch(knownMessageId).catch(() => null);
    if (known && known.author.id === client.user?.id && embedFooter(known) === marker) return known;
  }
  const recent = await channel.messages.fetch({ limit: 100 });
  return recent.find((message) =>
    message.author.id === client.user?.id && embedFooter(message) === marker,
  ) ?? null;
}

function warningEmbed(
  ticket: PersistedTicket,
  idleHours: number,
  graceHours: number,
  deadlineMs: number,
  marker: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xE6A23C)
    .setTitle('⏳ Ticket inactivity warning')
    .setDescription(
      'Ticket **#' + (ticket.ticketNumber ?? 'unknown') + '** has had no recorded activity for **' + idleHours + ' hours**. ' +
      'Reply in this ticket before <t:' + Math.floor(deadlineMs / 1000) + ':F> to keep it open. ' +
      'If no one replies during the next **' + graceHours + ' hours**, ResolveX will save a transcript and close the ticket. ' +
      'Any new message resets this timer. If you still need support, please reply here.',
    )
    .setFooter({ text: marker })
    .setTimestamp(new Date(deadlineMs - graceHours * 60 * 60 * 1000));
}

async function issueOrRecoverWarning(
  client: Client,
  channel: InactivityChannel,
  ticket: PersistedTicket,
  anchorAt: string,
  idleHours: number,
  graceHours: number,
): Promise<Message> {
  const marker = warningMarker(ticket.channelId, anchorAt);
  const knownId = metadataString(ticket, 'inactivityWarningMessageId');
  let message = await findWarningMessage(channel, client, marker, knownId);

  if (!message) {
    // Do not persist the warning stage before Discord accepts the warning.
    // If a crash happens after send but before persistence, the marker search
    // above recovers the existing message rather than sending duplicates.
    message = await channel.send({
      content: ticket.ownerId ? '<@' + ticket.ownerId + '>' : undefined,
      embeds: [warningEmbed(ticket, idleHours, graceHours, Date.now() + graceHours * 60 * 60 * 1000, marker)],
      allowedMentions: ticket.ownerId ? { users: [ticket.ownerId], parse: [] } : { parse: [] },
    });
  }

  // Derive grace from the visible warning's Discord creation timestamp. This
  // keeps the displayed deadline stable across bot restarts and partial writes.
  const deadlineAt = new Date(message.createdTimestamp + graceHours * 60 * 60 * 1000).toISOString();
  await message.edit({
    embeds: [warningEmbed(ticket, idleHours, graceHours, Date.parse(deadlineAt), marker)],
    allowedMentions: { parse: [] },
  });
  const current = await getPersistedTicket(ticket.channelId);
  if (!isCurrentActiveTicket(current, anchorAt)) return message;

  await updatePersistedTicketMetadata(ticket.channelId, {
    metadata: {
      inactivityWarningAnchorAt: anchorAt,
      inactivityWarningDeadlineAt: deadlineAt,
      inactivityWarningMessageId: message.id,
    },
  }, SYSTEM_ACTOR);
  return message;
}

async function clearWarningMetadata(ticket: PersistedTicket): Promise<void> {
  await updatePersistedTicketMetadata(ticket.channelId, {
    metadata: {
      inactivityWarningAnchorAt: null,
      inactivityWarningDeadlineAt: null,
      inactivityWarningMessageId: null,
    },
  }, SYSTEM_ACTOR);
}

async function transcriptDestination(guild: Guild): Promise<TextChannel> {
  const config = await getGuildConfig(guild.id);
  if (!config.transcriptChannelId) {
    throw new Error('Transcript channel is not configured; inactivity closure is paused for safety.');
  }
  const channel = guild.channels.cache.get(config.transcriptChannelId)
    ?? await guild.channels.fetch(config.transcriptChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('The configured transcript channel is missing or is not a text channel; inactivity closure is paused for safety.');
  }
  return channel as TextChannel;
}

async function findTranscriptMessage(channel: TextChannel, marker: string): Promise<Message | null> {
  const recent = await channel.messages.fetch({ limit: 100 });
  return recent.find((message) => message.content.includes(marker)) ?? null;
}

function makeClosedTopic(topic: string, closedAt: string, transcriptId: string): string {
  let result = setField(topic, 'status', 'closed');
  result = setField(result, 'closed_at', closedAt);
  result = setField(result, 'transcript_id', transcriptId);
  result = setField(result, 'updated_at', closedAt);
  return result;
}

async function synchronizePrivateThreadClosure(
  channel: InactivityChannel,
  closedTicket: PersistedTicket,
  closedTopic: string | null,
): Promise<void> {
  if (channel.type !== ChannelType.PrivateThread || !closedTopic) return;
  const thread = channel as ThreadChannel;
  try {
    if (!thread.archived) await thread.setArchived(true, 'ResolveX inactivity auto-close');
    if (!thread.locked) await thread.setLocked(true, 'ResolveX inactivity auto-close read-only protection');
    await refreshPrivateThreadPanel(thread, closedTicket, closedTopic);
    // Panel recovery can wake a thread. Reassert durable closure after repair.
    if (!thread.archived) await thread.setArchived(true, 'ResolveX reassert inactivity closure after panel refresh');
    if (!thread.locked) await thread.setLocked(true, 'ResolveX reassert inactivity lock after panel refresh');
  } catch (error) {
    console.warn('Private-thread inactivity closure is durable; outbox reconciliation will retry Discord synchronization:', error);
  }
}

async function autoCloseInactiveTicket(
  client: Client,
  guild: Guild,
  channel: InactivityChannel,
  candidate: PersistedTicket,
  anchorAt: string,
  idleHours: number,
  graceHours: number,
): Promise<void> {
  let fresh = await getPersistedTicket(candidate.channelId);
  if (!isCurrentActiveTicket(fresh, anchorAt)) return;

  const destination = await transcriptDestination(guild);
  const marker = transcriptMarker(candidate.channelId, anchorAt);
  let transcriptMessage = await findTranscriptMessage(destination, marker);

  if (!transcriptMessage) {
    const ticketNumber = fresh.ticketNumber ?? 'unknown';
    const metadataTopic = metadataString(fresh, 'ticketTopic')
      ?? (channel.type === ChannelType.GuildText ? channel.topic ?? '' : '');
    const openedAtRaw = metadataString(fresh, 'openedAt') ?? getField(metadataTopic, 'opened_at');
    const openedAtParsed = openedAtRaw ? new Date(openedAtRaw) : new Date(fresh.createdAt);
    const openedAt = Number.isNaN(openedAtParsed.getTime()) ? new Date(fresh.createdAt) : openedAtParsed;
    const rawSubject = metadataString(fresh, 'subject') ?? getField(metadataTopic, 'subject') ?? 'Support request';
    let subject = rawSubject;
    try { subject = decodeURIComponent(rawSubject); } catch { /* retain legacy unescaped value */ }
    const transcript = await generateTranscript({
      channel,
      ticketNumber,
      subject,
      ownerId: fresh.ownerId ?? 'unknown',
      ownerName: fresh.ownerId ? '<@' + fresh.ownerId + '>' : 'Unknown owner',
      closedBy: 'ResolveX inactivity automation',
      openedAt,
      closedAt: new Date(),
    });

    // Transcript generation is potentially expensive; re-read activity before
    // uploading it, so an in-progress customer reply prevents a stale close.
    fresh = await getPersistedTicket(candidate.channelId);
    if (!isCurrentActiveTicket(fresh, anchorAt)) return;

    transcriptMessage = await destination.send({
      content: '📄 Automatic inactivity transcript for ticket **#' + ticketNumber + '**. ' + marker,
      files: [transcript],
      allowedMentions: { parse: [] },
    });
  }

  fresh = await getPersistedTicket(candidate.channelId);
  if (!isCurrentActiveTicket(fresh, anchorAt)) return;

  const closedAt = new Date().toISOString();
  const closedTopic = fresh.metadata.workspaceKind === 'private-thread'
    ? makeClosedTopic(metadataString(fresh, 'ticketTopic') ?? projectDurableTicketTopic('', fresh), closedAt, transcriptMessage.id)
    : null;
  const metadata: Record<string, unknown> = {
    closedAt,
    closedById: client.user?.id ?? 'supportforge-system',
    closedByTag: 'ResolveX inactivity automation',
    transcriptId: transcriptMessage.id,
    transcriptDestinationId: destination.id,
    lastActivityAt: closedAt,
    inactivityAutoClosedAt: closedAt,
    inactivityAutoCloseAnchorAt: anchorAt,
    inactivityAutoCloseIdleHours: idleHours,
    inactivityAutoCloseGraceHours: graceHours,
    inactivityWarningAnchorAt: null,
    inactivityWarningDeadlineAt: null,
    inactivityWarningMessageId: null,
  };
  if (closedTopic) metadata.ticketTopic = closedTopic;

  const didClose = await closePersistedTicketIfActivityUnchanged(
    candidate.channelId,
    anchorAt,
    {
      participantIds: [...new Set([...(fresh.ownerId ? [fresh.ownerId] : []), ...fresh.participantIds])],
      metadata,
    },
    SYSTEM_ACTOR,
    closedAt,
  );
  if (!didClose) return;

  const closedTicket = await getPersistedTicket(candidate.channelId);
  if (!closedTicket) return;
  await synchronizePrivateThreadClosure(channel, closedTicket, closedTopic);

  const config = await getGuildConfig(guild.id);
  if (config.supportCategoryId) {
    void logTicketEvent(guild, config.supportCategoryId, {
      ticketNumber: fresh.ticketNumber ?? 'unknown',
      ticketChannelId: fresh.channelId,
      event: 'ticket_auto_closed_inactivity',
      actor: 'ResolveX inactivity automation',
      actorId: SYSTEM_ACTOR.id,
      actorName: 'ResolveX inactivity automation',
      detail: 'Closed after ' + idleHours + ' idle hours and a ' + graceHours +
        ' hour warning grace period. Transcript message=' + transcriptMessage.id + '.',
    }).catch((error) => console.warn('Could not write inactivity auto-close audit event:', error));
  }
}

async function sweepTicket(client: Client, guild: Guild, initial: PersistedTicket, nowMs: number): Promise<void> {
  let ticket = await getPersistedTicket(initial.channelId);
  if (!ticket || ticket.guildId !== guild.id || ticket.deletedAt || !isActiveStatus(ticket.status)) return;

  const settings = normalizeInactivitySettings((await getAdvancedSettings(guild.id)).inactivity);
  if (!settings.enabled) {
    if (
      ticket.metadata.inactivityWarningAnchorAt ||
      ticket.metadata.inactivityWarningDeadlineAt ||
      ticket.metadata.inactivityWarningMessageId
    ) {
      await clearWarningMetadata(ticket);
    }
    return;
  }

  const channel = await resolveTicketChannel(guild, ticket);
  if (!channel) return;

  const decision = evaluateTicketInactivity(ticket, settings, nowMs);
  if (decision.action === 'skip' || decision.action === 'wait') {
    const storedAnchor = metadataString(ticket, 'inactivityWarningAnchorAt');
    if (storedAnchor && storedAnchor !== decision.anchorAt) {
      await clearWarningMetadata(ticket);
    }
    return;
  }

  // Do not wake auto-archived threads during their idle wait. Unarchive only
  // when a warning is due or an existing grace period must be checked.
  if (channel.type === ChannelType.PrivateThread) {
    const thread = channel as ThreadChannel;
    if (thread.locked) return;
    if (thread.archived) await thread.setArchived(false, 'ResolveX inactivity warning/check');
  }

  if (decision.action === 'warn') {
    await issueOrRecoverWarning(client, channel, ticket, decision.anchorAt, settings.idleHours, settings.graceHours);
    return;
  }

  // A grace/close decision is actionable only while the warning message still
  // exists. If someone deletes it, send a replacement and grant a fresh grace.
  const marker = warningMarker(ticket.channelId, decision.anchorAt);
  const warning = await findWarningMessage(
    channel,
    client,
    marker,
    metadataString(ticket, 'inactivityWarningMessageId'),
  );
  if (!warning) {
    await issueOrRecoverWarning(client, channel, ticket, decision.anchorAt, settings.idleHours, settings.graceHours);
    return;
  }

  const actualDeadline = new Date(warning.createdTimestamp + settings.graceHours * 60 * 60 * 1000).toISOString();
  if (
    metadataString(ticket, 'inactivityWarningDeadlineAt') !== actualDeadline ||
    metadataString(ticket, 'inactivityWarningMessageId') !== warning.id ||
    metadataString(ticket, 'inactivityWarningAnchorAt') !== decision.anchorAt
  ) {
    await updatePersistedTicketMetadata(ticket.channelId, {
      metadata: {
        inactivityWarningAnchorAt: decision.anchorAt,
        inactivityWarningDeadlineAt: actualDeadline,
        inactivityWarningMessageId: warning.id,
      },
    }, SYSTEM_ACTOR);
  }

  ticket = await getPersistedTicket(ticket.channelId);
  if (!ticket) return;
  const refreshedDecision = evaluateTicketInactivity(ticket, settings, nowMs);
  if (refreshedDecision.action !== 'close') return;

  // Last guard before transcript work. The final database transition repeats
  // this comparison atomically under a row lock.
  const fresh = await getPersistedTicket(ticket.channelId);
  if (!isCurrentActiveTicket(fresh, decision.anchorAt)) return;
  await autoCloseInactiveTicket(client, guild, channel, fresh, decision.anchorAt, settings.idleHours, settings.graceHours);
}

export async function sweepTicketInactivityForGuild(
  client: Client,
  guild: Guild,
  nowMs = Date.now(),
): Promise<void> {
  const records = await getPersistedTicketRecords(guild.id);
  for (const ticket of records) {
    try {
      await sweepTicket(client, guild, ticket, nowMs);
    } catch (error) {
      console.warn('Ticket inactivity sweep skipped ticket ' + ticket.channelId + ' in guild ' + guild.id + ':', error);
    }
  }
}

export async function clearTicketInactivityWarningsForGuild(guildId: string): Promise<void> {
  const records = await getPersistedTicketRecords(guildId);
  for (const ticket of records) {
    if (!isActiveStatus(ticket.status) || ticket.deletedAt) continue;
    if (
      !ticket.metadata.inactivityWarningAnchorAt &&
      !ticket.metadata.inactivityWarningDeadlineAt &&
      !ticket.metadata.inactivityWarningMessageId
    ) continue;
    try {
      await clearWarningMetadata(ticket);
    } catch (error) {
      console.warn('Could not clear inactivity warning for ticket ' + ticket.channelId + ':', error);
    }
  }
}

export function startTicketInactivityScheduler(client: Client): void {
  if (scheduler) return;
  let running = false;
  const run = async (): Promise<void> => {
    if (running || !client.isReady()) return;
    running = true;
    try {
      for (const guild of client.guilds.cache.values()) {
        try {
          await sweepTicketInactivityForGuild(client, guild);
        } catch (error) {
          console.warn('Ticket inactivity scheduler failed for guild ' + guild.id + ':', error);
        }
      }
    } finally {
      running = false;
    }
  };
  void run();
  scheduler = setInterval(() => { void run(); }, SWEEP_INTERVAL_MS);
}
