import {
  ChannelType,
  Client,
  type CategoryChannel,
  type Guild,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';

import {
  getPersistedTicket,
  getPersistedTicketById,
  updatePersistedTicketMetadata,
  markPersistedTicketDeleted,
  type PersistedTicket,
} from './ticketPersistenceService';
import { getGuildConfig } from './configService';
import {
  ensureArchiveCategory,
  ensureClosedCategory,
  ensureOpenCategory,
  getOptionalStatusCategory,
} from './ticketStorageService';
import {
  getTicketChannelName,
  refreshTicketPanel,
} from './ticketPanelService';
import {
  setChannelProperties,
  type ChannelPermissionOverwrite,
} from './discordChannelService';
import { buildTicketVisibilityPlan } from '../core/domain/ticketPermissionPlan';
import type { OutboxEvent } from '../core/events/domainEvents';
import { PermanentOutboxPublishError, type OutboxPublisher } from '../core/events/outboxProcessor';
import { getField } from './ticketStateService';
import { projectDurableTicketTopic } from './ticketTopicProjectionService';
import { refreshPrivateThreadPanel } from './privateThreadTicketService';

function isUnknownChannel(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const raw = record.rawError && typeof record.rawError === 'object'
    ? record.rawError as Record<string, unknown>
    : undefined;
  return (
    Number(record.code) === 10003 ||
    Number(raw?.code) === 10003 ||
    Number(record.status) === 404
  );
}

function isUnknownGuild(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const raw = record.rawError && typeof record.rawError === 'object'
    ? record.rawError as Record<string, unknown>
    : undefined;
  return (
    Number(record.code) === 10004 ||
    Number(raw?.code) === 10004 ||
    Number(record.status) === 404
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function resolveTicketParent(
  guild: Guild,
  ticket: PersistedTicket,
): Promise<CategoryChannel | undefined> {
  switch (ticket.status) {
    case 'closed':
      return ensureClosedCategory(guild);
    case 'archived':
      return ensureArchiveCategory(guild);
    case 'claimed':
    case 'pending': {
      const optional = await getOptionalStatusCategory(guild, ticket.status);
      if (optional) return optional;
      break;
    }
    case 'open':
    case 'reopened':
      break;
  }

  const config = await getGuildConfig(guild.id);
  const department = ticket.departmentId
    ? config.departments[ticket.departmentId]
    : undefined;
  const departmentCategory = department?.categoryId
    ? guild.channels.cache.get(department.categoryId)
    : undefined;

  if (departmentCategory?.type === ChannelType.GuildCategory) {
    return departmentCategory;
  }

  return ensureOpenCategory(guild);
}

function visibilityOverwrites(
  channel: TextChannel,
  ticket: PersistedTicket,
  topic: string,
): {
  overwrites?: ChannelPermissionOverwrite[];
  roleIds: Set<string>;
} {
  const roleIds = new Set<string>([
    ...channel.guild.roles.cache.keys(),
    ...[...channel.permissionOverwrites.cache.values()]
      .filter((overwrite) => overwrite.type === 0)
      .map((overwrite) => overwrite.id),
  ]);

  const isClosed = ticket.status === 'closed' || ticket.status === 'archived';
  const existing = [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
    id: overwrite.id,
    kind: overwrite.type === 0 ? 'role' as const : 'member' as const,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  }));

  const staffRoleId = stringValue(ticket.metadata.staffRoleId) ?? getField(topic, 'staff');
  const botId = channel.guild.members.me?.id;
  const ownerId = ticket.ownerId ?? getField(topic, 'owner');
  if (isClosed && (!ownerId || !botId)) {
    throw new Error('Cannot safely reconcile a closed ticket ACL without its owner and bot member.');
  }
  const plan = buildTicketVisibilityPlan({
    existing,
    roleIds,
    staffRoleId,
    everyoneRoleId: channel.guild.roles.everyone.id,
    botId,
    ownerId: ownerId ?? '',
    userIds: ticket.participantIds.filter((id) => id !== ticket.ownerId),
    claimedModeratorIds: ticket.claimedByIds,
    formerClaimantIds: (getField(channel.topic ?? topic, 'claimed_by') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    mode: isClosed ? 'closed' : ticket.status === 'claimed' ? 'claimed' : 'unclaimed',
  });

  if (!plan.changed) return { roleIds };

  const overwrites = plan.overwrites.map((overwrite) => ({
    id: overwrite.id,
    allow: [BigInt(overwrite.allow)],
    deny: [BigInt(overwrite.deny)],
  }));

  for (const overwrite of plan.overwrites) {
    if (overwrite.kind === 'role') roleIds.add(overwrite.id);
  }

  return { overwrites, roleIds };
}

/**
 * Reconciles Discord's materialized channel state from durable ticket state.
 * It deliberately ignores the event's stale snapshot and always reads the
 * latest ticket record, so out-of-order and duplicate events converge.
 */
export class TicketOutboxPublisher implements OutboxPublisher {
  public constructor(private readonly client: Client) {}

  public async publish(event: OutboxEvent): Promise<void> {
    // Message-received events are durable activity records, not Discord mutations.
    // They must not cause a channel PATCH for every customer/staff message.
    if (event.type === 'ticket.message.received') return;
    const payloadChannelId = stringValue(event.payload.channelId);
    let ticket = payloadChannelId
      ? await getPersistedTicket(payloadChannelId)
      : await getPersistedTicketById(event.aggregateId);

    // Hard/soft deletion events have no live Discord representation to repair.
    if (!ticket || ticket.deletedAt) return;

    const guildId = stringValue(ticket.guildId);
    const ticketChannelId = stringValue(ticket.channelId);
    if (!guildId || !ticketChannelId) {
      throw new PermanentOutboxPublishError(
        'Durable ticket ' + event.aggregateId + ' has missing guild/channel identifiers.',
      );
    }

    let guild: Guild;
    try {
      guild = this.client.guilds.cache.get(guildId) ??
        await this.client.guilds.fetch(guildId);
    } catch (error) {
      if (isUnknownGuild(error)) {
        await markPersistedTicketDeleted(
          ticketChannelId,
          'Guild no longer exists or is inaccessible during outbox reconciliation.',
          {
            id: 'supportforge-system',
            attribution: 'actorUnknown',
            confidence: 'none',
          },
        );
        return;
      }
      throw error;
    }

    let fetched;
    try {
      fetched = guild.channels.cache.get(ticketChannelId) ??
        await guild.channels.fetch(ticketChannelId);
    } catch (error) {
      if (isUnknownChannel(error)) {
        await markPersistedTicketDeleted(
          ticketChannelId,
          'Ticket channel no longer exists during outbox reconciliation.',
          {
            id: 'supportforge-system',
            attribution: 'actorUnknown',
            confidence: 'none',
          },
        );
        return;
      }
      throw error;
    }

    if (!fetched) {
      throw new Error('Ticket channel fetch returned no channel during outbox reconciliation.');
    }

    if (fetched.type === ChannelType.PrivateThread && ticket.metadata.workspaceKind === 'private-thread') {
      const thread = fetched as ThreadChannel;
      const topic = projectDurableTicketTopic('', ticket);
      if (ticket.status === 'closed' || ticket.status === 'archived') {
        if (!thread.archived) await thread.setArchived(true, 'ResolveX outbox closed-ticket reconciliation');
        if (!thread.locked) await thread.setLocked(true, 'ResolveX outbox closed-ticket reconciliation');
        await refreshPrivateThreadPanel(thread, ticket, topic);
        // A missing panel may be recreated by sending a new message. Ensure
        // that such repair never leaves the durable closed ticket writable.
        if (!thread.archived) await thread.setArchived(true, 'ResolveX outbox reassert closed ticket after panel refresh');
        if (!thread.locked) await thread.setLocked(true, 'ResolveX outbox reassert closed ticket lock after panel refresh');
      } else {
        if (thread.archived) await thread.setArchived(false, 'ResolveX outbox active-ticket reconciliation');
        if (thread.locked) await thread.setLocked(false, 'ResolveX outbox active-ticket reconciliation');
        await refreshPrivateThreadPanel(thread, ticket, topic);
      }
      return;
    }

    if (fetched.type !== ChannelType.GuildText) {
      await markPersistedTicketDeleted(
        ticketChannelId,
        'Ticket channel was missing or no longer a supported ticket resource during outbox reconciliation.',
        {
          id: 'supportforge-system',
          attribution: 'actorUnknown',
          confidence: 'none',
        },
      );
      return;
    }

    const channel = fetched as TextChannel;

    /*
     * Private voice rooms are temporary resources whose lifetime is tied to
     * the claimed state. On a transition away from claimed, reconcile their
     * deletion from durable metadata before removing the recovery pointer.
     * This covers crashes between committing ticket state and deleting voice.
     */
    if (ticket.status !== 'claimed') {
      const voiceChannelId =
        stringValue(ticket.metadata.voiceChannelId) ??
        stringValue(getField(channel.topic ?? '', 'voice_channel_id'));

      if (voiceChannelId) {
        let voiceChannel;
        try {
          voiceChannel = guild.channels.cache.get(voiceChannelId) ??
            await guild.channels.fetch(voiceChannelId);
        } catch (error) {
          if (!isUnknownChannel(error)) throw error;
          voiceChannel = null;
        }

        if (voiceChannel?.type === ChannelType.GuildVoice) {
          try {
            await voiceChannel.delete(
              'ResolvX outbox reconciliation: ticket is no longer claimed',
            );
          } catch (error) {
            if (!isUnknownChannel(error)) throw error;
          }
        } else if (voiceChannel) {
          throw new PermanentOutboxPublishError(
            'Ticket ' + ticket.id + ' voice recovery pointer refers to a non-voice Discord channel.',
          );
        }

        await updatePersistedTicketMetadata(
          ticketChannelId,
          {
            metadata: {
              voiceChannelId: null,
              voiceChannelName: null,
              voiceStartedAt: null,
              voiceStartedBy: null,
            },
          },
          {
            id: 'supportforge-system',
            attribution: 'actorUnknown',
            confidence: 'none',
          },
        );

        const refreshed = await getPersistedTicket(ticketChannelId);
        if (refreshed) ticket = refreshed;
      }
    }

    const topic = projectDurableTicketTopic(channel.topic ?? '', ticket);
    const parent = await resolveTicketParent(guild, ticket);
    const name = getTicketChannelName(
      ticket.ticketNumber ?? 'unknown',
      ticket.status,
      ticket.priority ?? 'normal',
    );
    const visibility = visibilityOverwrites(channel, ticket, topic);

    const properties: {
      name?: string;
      topic?: string;
      parentId?: string;
      permissionOverwrites?: ChannelPermissionOverwrite[];
    } = {};

    if (channel.name !== name) properties.name = name;
    if ((channel.topic ?? '') !== topic) properties.topic = topic;
    if (parent && channel.parentId !== parent.id) properties.parentId = parent.id;
    if (visibility.overwrites) properties.permissionOverwrites = visibility.overwrites;

    if (Object.keys(properties).length) {
      await setChannelProperties(
        channel.id,
        properties,
        visibility.roleIds,
        'Reconcile ticket from durable outbox event ' + event.id,
        { deferLongRateLimit: false },
      );
      if (properties.name !== undefined) channel.name = properties.name;
      if (properties.topic !== undefined) channel.topic = properties.topic;
    }

    await refreshTicketPanel(channel, topic);
  }
}
