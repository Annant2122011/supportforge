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
  findLatestHumanActivityAfter,
  getTicketInactivityAnchor,
  normalizeInactivitySettings,
} from '../core/domain/ticketInactivityPolicy';
import { hasExemptInactivityRole, isDepartmentExemptFromInactivity } from '../core/domain/ticketInactivityExemptions';
import {
  getAdvancedSettings,
  type AdvancedGuildSettings,
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

function warningMarker(channelId: string, anchorAt: string, generation: number): string {
  return WARNING_MARKER_PREFIX + ' | ticket=' + channelId + ' | activity=' + anchorAt + ' | generation=' + generation;
}

async function cancelIfInactivityPolicyChanged(
  client: Client,
  guild: Guild,
  channel: InactivityChannel,
  ticket: PersistedTicket,
  generation: number,
  idleHours: number,
  graceHours: number,
): Promise<boolean> {
  const policy = (await getAdvancedSettings(guild.id)).inactivity;
  if (
    policy.enabled &&
    policy.generation === generation &&
    policy.idleHours === idleHours &&
    policy.graceHours === graceHours
  ) return false;

  const current = await getPersistedTicket(ticket.channelId);
  if (current) {
    await cancelVisibleWarnings(channel, client, current);
    if (
      current.metadata.inactivityWarningAnchorAt ||
      current.metadata.inactivityWarningDeadlineAt ||
      current.metadata.inactivityWarningMessageId
    ) {
      await clearWarningMetadata(current);
    }
  } else {
    await cancelVisibleWarnings(channel, client, ticket);
  }
  return true;
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
  const liveTopic = channel.topic ?? '';
  const storedTopic = metadataString(ticket, 'ticketTopic') ?? '';
  const topic = isTicketTopic(liveTopic) ? liveTopic : storedTopic;
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

async function cancelVisibleWarnings(
  channel: InactivityChannel,
  client: Client,
  ticket: PersistedTicket,
): Promise<void> {
  const prefix = WARNING_MARKER_PREFIX + ' | ticket=' + ticket.channelId + ' |';
  const candidates = new Map<string, Message>();
  const knownId = metadataString(ticket, 'inactivityWarningMessageId');
  if (knownId) {
    const known = await channel.messages.fetch(knownId).catch(() => null);
    if (known) candidates.set(known.id, known);
  }
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  for (const message of recent?.values() ?? []) candidates.set(message.id, message);
  for (const message of candidates.values()) {
    const footer = embedFooter(message);
    if (
      message.author.id !== client.user?.id ||
      !footer?.startsWith(prefix) ||
      footer.endsWith('| CANCELLED')
    ) continue;
    await message.edit({
      embeds: [
        new EmbedBuilder()
          .setColor(0x7B8794)
          .setTitle('Inactivity auto-close cancelled')
          .setDescription('This ticket has received activity or the server inactivity policy changed. The old warning and grace period are cancelled.')
          .setFooter({ text: footer + ' | CANCELLED' })
          .setTimestamp(message.createdAt),
      ],
      allowedMentions: { parse: [] },
    }).catch((error) => console.warn('Could not mark an inactivity warning as cancelled:', error));
  }
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
  generation: number,
): Promise<Message | null> {
  if (await cancelIfInactivityPolicyChanged(client, channel.guild, channel, ticket, generation, idleHours, graceHours)) return null;
  let latestTicket = await getPersistedTicket(ticket.channelId);
  if (!isCurrentActiveTicket(latestTicket, anchorAt)) return null;
  ticket = latestTicket;
  const marker = warningMarker(ticket.channelId, anchorAt, generation);
  const knownId = metadataString(ticket, 'inactivityWarningMessageId');
  let message = await findWarningMessage(channel, client, marker, knownId);

  if (!message) {
    if (await cancelIfInactivityPolicyChanged(client, channel.guild, channel, ticket, generation, idleHours, graceHours)) return null;
    latestTicket = await getPersistedTicket(ticket.channelId);
    if (!isCurrentActiveTicket(latestTicket, anchorAt)) return null;
    ticket = latestTicket;
    // The marker allows recovery if Discord accepts the send but the process
    // stops before the warning ID/deadline is persisted to PostgreSQL.
    message = await channel.send({
      content: ticket.ownerId ? '<@' + ticket.ownerId + '>' : undefined,
      embeds: [warningEmbed(ticket, idleHours, graceHours, Date.now() + graceHours * 60 * 60 * 1000, marker)],
      allowedMentions: ticket.ownerId ? { users: [ticket.ownerId], parse: [] } : { parse: [] },
    });
  }

  const deadlineAt = new Date(message.createdTimestamp + graceHours * 60 * 60 * 1000).toISOString();
  await message.edit({
    embeds: [warningEmbed(ticket, idleHours, graceHours, Date.parse(deadlineAt), marker)],
    allowedMentions: { parse: [] },
  });
  const current = await getPersistedTicket(ticket.channelId);
  if (!isCurrentActiveTicket(current, anchorAt)) {
    await cancelVisibleWarnings(channel, client, ticket);
    return null;
  }
  if (await cancelIfInactivityPolicyChanged(client, channel.guild, channel, current, generation, idleHours, graceHours)) return null;

  await updatePersistedTicketMetadata(ticket.channelId, {
    metadata: {
      // Establish an explicit stable anchor for legacy rows that predate lastActivityAt.
      ...(metadataString(current, 'lastActivityAt') ? {} : { lastActivityAt: anchorAt }),
      inactivityWarningAnchorAt: anchorAt,
      inactivityWarningDeadlineAt: deadlineAt,
      inactivityWarningMessageId: message.id,
    },
  }, SYSTEM_ACTOR);

  // Catch a reply that committed during the metadata write; the final close
  // path separately checks the activity anchor atomically under a row lock.
  const committed = await getPersistedTicket(ticket.channelId);
  if (!isCurrentActiveTicket(committed, anchorAt)) {
    await cancelVisibleWarnings(channel, client, ticket);
    if (committed) await clearWarningMetadata(committed);
    return null;
  }
  if (await cancelIfInactivityPolicyChanged(client, channel.guild, channel, committed, generation, idleHours, graceHours)) return null;
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

const MAX_ACTIVITY_GUARD_MESSAGES = 1_000;

/**
 * Reconcile the persisted activity cursor against recent Discord history before
 * creating a warning or closing. A messageCreate handler may be delayed behind
 * archive I/O or a database retry, so PostgreSQL alone is not enough to prove
 * that nobody has just replied. If the history window cannot be checked back
 * to the anchor within the safety cap, automation pauses instead of guessing.
 */
async function guardAgainstUnpersistedHumanActivity(
  client: Client,
  channel: InactivityChannel,
  ticket: PersistedTicket,
  anchorAt: string,
  maxMessages = MAX_ACTIVITY_GUARD_MESSAGES,
  recentWindowOnly = false,
): Promise<boolean> {
  const anchorMs = Date.parse(anchorAt);
  if (!Number.isFinite(anchorMs)) return true;

  let before: string | undefined;
  let scanned = 0;
  let reachedAnchor = false;

  while (scanned < maxMessages) {
    const batch = await channel.messages.fetch({
      limit: Math.min(100, maxMessages - scanned),
      ...(before ? { before } : {}),
    });
    if (batch.size === 0) {
      reachedAnchor = true;
      break;
    }

    const activity = findLatestHumanActivityAfter(anchorAt, [...batch.values()].map((message) => ({
      createdAt: message.createdAt.toISOString(),
      messageId: message.id,
      authorId: message.author.id,
      authorIsBot: message.author.bot || Boolean(message.webhookId),
    })));

    if (activity) {
      const current = await getPersistedTicket(ticket.channelId);
      if (!isCurrentActiveTicket(current, anchorAt)) return true;

      await updatePersistedTicketMetadata(ticket.channelId, {
        metadata: { lastActivityAt: activity.at },
      }, SYSTEM_ACTOR);
      const updated = await getPersistedTicket(ticket.channelId);
      if (updated) {
        await cancelVisibleWarnings(channel, client, updated);
        if (
          updated.metadata.inactivityWarningAnchorAt ||
          updated.metadata.inactivityWarningDeadlineAt ||
          updated.metadata.inactivityWarningMessageId
        ) {
          await clearWarningMetadata(updated);
        }
      } else {
        await cancelVisibleWarnings(channel, client, current);
      }
      return true;
    }

    scanned += batch.size;
    const oldest = [...batch.values()].reduce((previous, current) =>
      previous.createdTimestamp <= current.createdTimestamp ? previous : current,
    );
    if (oldest.createdTimestamp <= anchorMs || batch.size < 100) {
      reachedAnchor = true;
      break;
    }

    before = oldest.id;
  }

  // false means we proved no human reply newer than the anchor exists. True
  // means a reply was found or we hit the history cap and must fail closed.
  return recentWindowOnly ? false : !reachedAnchor;
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

async function findTranscriptMessage(
  channel: TextChannel,
  marker: string,
  knownMessageId: string | null,
): Promise<Message | null> {
  if (knownMessageId) {
    const known = await channel.messages.fetch(knownMessageId).catch(() => null);
    if (known && known.content.includes(marker)) return known;
  }
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
  policyGeneration: number,
): Promise<void> {
  let fresh = await getPersistedTicket(candidate.channelId);
  if (!isCurrentActiveTicket(fresh, anchorAt)) return;
  if (await cancelIfInactivityPolicyChanged(client, guild, channel, fresh, policyGeneration, idleHours, graceHours)) return;
  if (await guardAgainstUnpersistedHumanActivity(client, channel, fresh, anchorAt, 100, true)) return;

  const destination = await transcriptDestination(guild);
  const marker = transcriptMarker(candidate.channelId, anchorAt);
  const knownTranscriptId = metadataString(fresh, 'inactivityTranscriptAnchorAt') === anchorAt
    ? metadataString(fresh, 'inactivityTranscriptMessageId')
    : null;
  let transcriptMessage = await findTranscriptMessage(destination, marker, knownTranscriptId);

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
    if (await cancelIfInactivityPolicyChanged(client, guild, channel, fresh, policyGeneration, idleHours, graceHours)) return;

    transcriptMessage = await destination.send({
      content: '📄 Automatic inactivity transcript for ticket **#' + ticketNumber + '**. ' + marker,
      files: [transcript],
      allowedMentions: { parse: [] },
    });
  }

  fresh = await getPersistedTicket(candidate.channelId);
  if (!isCurrentActiveTicket(fresh, anchorAt)) return;
  if (await cancelIfInactivityPolicyChanged(client, guild, channel, fresh, policyGeneration, idleHours, graceHours)) return;
  // Recheck recent Discord messages after transcript upload and just before the
  // receipt/close transaction. A late event-handler write must not be the sole
  // protection against closing a ticket after its owner has just replied.
  if (await guardAgainstUnpersistedHumanActivity(client, channel, fresh, anchorAt, 100, true)) return;

  // Save the upload receipt before the lifecycle commit. If that commit or an
  // outbox insert fails, a later scheduler pass can fetch this message directly
  // by ID even after it has fallen outside the transcript channel's recent 100.
  await updatePersistedTicketMetadata(candidate.channelId, {
    metadata: {
      inactivityTranscriptAnchorAt: anchorAt,
      inactivityTranscriptMessageId: transcriptMessage.id,
    },
  }, SYSTEM_ACTOR);
  fresh = await getPersistedTicket(candidate.channelId);
  if (!isCurrentActiveTicket(fresh, anchorAt)) return;
  if (await cancelIfInactivityPolicyChanged(client, guild, channel, fresh, policyGeneration, idleHours, graceHours)) return;

  // The transcript receipt adds another round-trip between the last check and
  // the close commit. Check again as late as possible before the PostgreSQL
  // compare-and-close transaction to narrow that unavoidable Discord/DB gap.
  if (await guardAgainstUnpersistedHumanActivity(client, channel, fresh, anchorAt, 100, true)) return;
  fresh = await getPersistedTicket(candidate.channelId);
  if (!isCurrentActiveTicket(fresh, anchorAt)) return;

  // Final policy-generation check immediately before building and committing
  // the close request. The settings document and ticket row cannot share a
  // cross-document transaction, so this is the narrowest practical window.
  if (await cancelIfInactivityPolicyChanged(client, guild, channel, fresh, policyGeneration, idleHours, graceHours)) return;

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

async function hasConfiguredInactivityExemption(
  guild: Guild,
  ticket: PersistedTicket,
  policy: AdvancedGuildSettings['inactivity'],
): Promise<boolean> {
  if (isDepartmentExemptFromInactivity(ticket.departmentId, policy.exemptDepartmentIds ?? [])) return true;

  const exemptRoleIds = Array.isArray(policy.exemptRoleIds) ? policy.exemptRoleIds : [];
  if (exemptRoleIds.length === 0) return false;

  // A role exemption applies to the ticket owner (VIP/customer role) or to
  // an assigned staff member. If Discord cannot confirm membership, fail
  // safe and do not auto-close this ticket during this sweep.
  const candidateIds = [...new Set([
    ticket.ownerId,
    ...(ticket.claimedByIds ?? []),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0))];

  for (const memberId of candidateIds) {
    let member = guild.members.cache.get(memberId);
    if (!member) {
      try {
        member = await guild.members.fetch(memberId);
      } catch {
        return true;
      }
    }
    if (hasExemptInactivityRole([...member.roles.cache.keys()], exemptRoleIds)) return true;
  }
  return false;
}

async function sweepTicket(
  client: Client,
  guild: Guild,
  initial: PersistedTicket,
  policy: AdvancedGuildSettings['inactivity'],
  nowMs: number,
): Promise<void> {
  let ticket = await getPersistedTicket(initial.channelId);
  if (!ticket || ticket.guildId !== guild.id) return;

  const hasWarningState = Boolean(
    ticket.metadata.inactivityWarningAnchorAt ||
    ticket.metadata.inactivityWarningDeadlineAt ||
    ticket.metadata.inactivityWarningMessageId,
  );
  if (ticket.deletedAt || !isActiveStatus(ticket.status)) {
    // Manual close/archive can beat an already scheduled inactivity deadline.
    // Retire any still-visible warning so it cannot claim closure is pending.
    if (hasWarningState) {
      try {
        const channel = await resolveTicketChannel(guild, ticket);
        if (channel) await cancelVisibleWarnings(channel, client, ticket);
      } catch (error) {
        console.warn('Could not cancel a stale inactivity warning for terminal ticket ' + ticket.channelId + ':', error);
      }
      await clearWarningMetadata(ticket).catch((error) => {
        console.warn('Could not clear stale inactivity metadata for terminal ticket ' + initial.channelId + ':', error);
      });
    }
    return;
  }

  const settings = normalizeInactivitySettings(policy);
  const policyGeneration = Number.isInteger(policy.generation) && policy.generation > 0
    ? policy.generation
    : 1;
  if (!settings.enabled) return;

  const channel = await resolveTicketChannel(guild, ticket);
  if (!channel) return;

  const configuredExemption = await hasConfiguredInactivityExemption(guild, ticket, policy);
  if (configuredExemption) {
    if (hasWarningState) {
      await cancelVisibleWarnings(channel, client, ticket);
      await clearWarningMetadata(ticket);
    }
    return;
  }

  const decision = evaluateTicketInactivity(ticket, settings, nowMs);
  if (decision.action === 'skip') {
    if (
      decision.reason === 'exempt' &&
      (ticket.metadata.inactivityWarningAnchorAt ||
        ticket.metadata.inactivityWarningDeadlineAt ||
        ticket.metadata.inactivityWarningMessageId)
    ) {
      await cancelVisibleWarnings(channel, client, ticket);
      await clearWarningMetadata(ticket);
    }
    return;
  }
  if (decision.action === 'wait') {
    const storedAnchor = metadataString(ticket, 'inactivityWarningAnchorAt');
    if (storedAnchor && storedAnchor !== decision.anchorAt) {
      await cancelVisibleWarnings(channel, client, ticket);
      await clearWarningMetadata(ticket);
    }
    return;
  }

  if (await guardAgainstUnpersistedHumanActivity(client, channel, ticket, decision.anchorAt)) return;

  // Do not wake auto-archived threads during their idle wait. Unarchive only
  // when a warning is due or an existing grace period must be checked.
  if (channel.type === ChannelType.PrivateThread) {
    const thread = channel as ThreadChannel;
    if (thread.locked) return;
    if (thread.archived) await thread.setArchived(false, 'ResolveX inactivity warning/check');
  }

  if (decision.action === 'warn') {
    await issueOrRecoverWarning(client, channel, ticket, decision.anchorAt, settings.idleHours, settings.graceHours, policyGeneration);
    return;
  }

  // A grace/close decision is actionable only while the warning message still
  // exists. If someone deletes it, send a replacement and grant a fresh grace.
  const marker = warningMarker(ticket.channelId, decision.anchorAt, policyGeneration);
  const warning = await findWarningMessage(
    channel,
    client,
    marker,
    metadataString(ticket, 'inactivityWarningMessageId'),
  );
  if (!warning) {
    await issueOrRecoverWarning(client, channel, ticket, decision.anchorAt, settings.idleHours, settings.graceHours, policyGeneration);
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
  await autoCloseInactiveTicket(client, guild, channel, fresh, decision.anchorAt, settings.idleHours, settings.graceHours, policyGeneration);
}

export async function sweepTicketInactivityForGuild(
  client: Client,
  guild: Guild,
  nowMs = Date.now(),
): Promise<void> {
  const records = await getPersistedTicketRecords(guild.id);
  const policy = (await getAdvancedSettings(guild.id)).inactivity;
  if (!policy.enabled) {
    for (const ticket of records) {
      if (
        !ticket.metadata.inactivityWarningAnchorAt &&
        !ticket.metadata.inactivityWarningDeadlineAt &&
        !ticket.metadata.inactivityWarningMessageId
      ) continue;
      try {
        const channel = ticket.deletedAt
          ? null
          : await resolveTicketChannel(guild, ticket).catch(() => null);
        if (channel) await cancelVisibleWarnings(channel, client, ticket);
      } catch (error) {
        console.warn('Could not cancel a disabled inactivity warning for ticket ' + ticket.channelId + ':', error);
      }
      await clearWarningMetadata(ticket).catch((error) => {
        console.warn('Could not clear disabled inactivity metadata for ticket ' + ticket.channelId + ':', error);
      });
    }
    return;
  }
  for (const ticket of records) {
    try {
      await sweepTicket(client, guild, ticket, policy, nowMs);
    } catch (error) {
      console.warn('Ticket inactivity sweep skipped ticket ' + ticket.channelId + ' in guild ' + guild.id + ':', error);
    }
  }
}

export async function clearTicketInactivityWarningsForGuild(guild: Guild): Promise<void> {
  const records = await getPersistedTicketRecords(guild.id);
  for (const ticket of records) {
    if (
      !ticket.metadata.inactivityWarningAnchorAt &&
      !ticket.metadata.inactivityWarningDeadlineAt &&
      !ticket.metadata.inactivityWarningMessageId
    ) continue;
    try {
      const channel = ticket.deletedAt
        ? null
        : await resolveTicketChannel(guild, ticket).catch(() => null);
      if (channel) await cancelVisibleWarnings(channel, guild.client, ticket);
    } catch (error) {
      console.warn('Could not cancel inactivity warning for ticket ' + ticket.channelId + ':', error);
    }
    await clearWarningMetadata(ticket).catch((error) => {
      console.warn('Could not clear inactivity metadata for ticket ' + ticket.channelId + ':', error);
    });
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
