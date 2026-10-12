import {
  ChannelType,
  Client,
  type CategoryChannel,
  type Guild,
  type TextChannel,
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

  if (ticket.status === 'closed' || ticket.status === 'archived') {
    return { roleIds };
  }

  const existing = [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
    id: overwrite.id,
    kind: overwrite.type === 0 ? 'role' as const : 'member' as const,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  }));

  const staffRoleId = stringValue(ticket.metadata.staffRoleId);
  const plan = buildTicketVisibilityPlan({
    existing,
    roleIds,
    staffRoleId,
    ownerId: ticket.ownerId ?? '',
    userIds: ticket.participantIds.filter((id) => id !== ticket.ownerId),
    claimedModeratorIds: ticket.claimedByIds,
    formerClaimantIds: (getField(channel.topic ?? topic, 'claimed_by') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    mode: ticket.status === 'claimed' ? 'claimed' : 'unclaimed',
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

    if (!fetched || fetched.type !== ChannelType.GuildText) {
      await markPersistedTicketDeleted(
        ticketChannelId,
        'Ticket channel was missing or no longer a text channel during outbox reconciliation.',
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
              'SupportForge outbox reconciliation: ticket is no longer claimed',
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
      );
      if (properties.name !== undefined) channel.name = properties.name;
      if (properties.topic !== undefined) channel.topic = properties.topic;
    }

    await refreshTicketPanel(channel, topic);
  }
}
