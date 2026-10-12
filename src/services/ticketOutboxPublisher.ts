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
import type { OutboxPublisher } from '../core/events/outboxProcessor';
import {
  TICKET_PREFIX,
  getField,
  isTicketTopic,
  removeField,
  setField,
} from './ticketStateService';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function idArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function setOrRemove(topic: string, key: string, value: unknown): string {
  const string = stringValue(value);
  return string ? setField(topic, key, string) : removeField(topic, key);
}

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

function mergeDurableTicketTopic(
  currentTopic: string,
  ticket: PersistedTicket,
): string {
  let topic = isTicketTopic(currentTopic) ? currentTopic : TICKET_PREFIX;
  const metadata = ticket.metadata ?? {};

  topic = setField(topic, 'v', '2');
  topic = setField(topic, 'status', ticket.status);
  topic = setOrRemove(topic, 'number', ticket.ticketNumber);
  topic = setOrRemove(topic, 'owner', ticket.ownerId);
  topic = setOrRemove(topic, 'department', ticket.departmentId);
  topic = setOrRemove(topic, 'tag', ticket.tagId);
  topic = setOrRemove(topic, 'tags', ticket.tagId);
  topic = setField(topic, 'priority', ticket.priority ?? 'normal');
  topic = setOrRemove(topic, 'staff', metadata.staffRoleId);
  if (!stringValue(metadata.staffRoleId)) topic = setField(topic, 'staff', 'none');

  topic = setOrRemove(topic, 'claimed_by', ticket.claimedByIds.join(','));
  const participants = ticket.participantIds.filter((id) => id !== ticket.ownerId);
  topic = setOrRemove(topic, 'users', participants.join(','));
  topic = setOrRemove(topic, 'subject', stringValue(metadata.subject)
    ? encodeURIComponent(String(metadata.subject))
    : undefined);
  topic = setOrRemove(topic, 'message', metadata.panelMessageId ?? getField(topic, 'message'));
  topic = setOrRemove(topic, 'opened_at', metadata.openedAt ?? ticket.createdAt);
  topic = setOrRemove(topic, 'updated_at', ticket.updatedAt);

  for (const [metadataKey, topicKey] of [
    ['pendingSince', 'pending_since'],
    ['closedAt', 'closed_at'],
    ['reopenedAt', 'reopened_at'],
    ['archivedAt', 'archived_at'],
    ['transcriptId', 'transcript_id'],
    ['voiceChannelId', 'voice_channel_id'],
    ['voiceChannelName', 'voice_channel_name'],
    ['voiceStartedAt', 'voice_started_at'],
  ] as const) {
    topic = setOrRemove(topic, topicKey, metadata[metadataKey]);
  }

  return topic;
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
    formerClaimantIds: (getField(topic, 'claimed_by') ?? '')
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
    const ticket = payloadChannelId
      ? await getPersistedTicket(payloadChannelId)
      : await getPersistedTicketById(event.aggregateId);

    // Hard/soft deletion events have no live Discord representation to repair.
    if (!ticket || ticket.deletedAt) return;

    let guild: Guild;
    try {
      guild = this.client.guilds.cache.get(ticket.guildId) ??
        await this.client.guilds.fetch(ticket.guildId);
    } catch (error) {
      if (isUnknownGuild(error)) {
        await markPersistedTicketDeleted(
          ticket.channelId,
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
      fetched = guild.channels.cache.get(ticket.channelId) ??
        await guild.channels.fetch(ticket.channelId);
    } catch (error) {
      if (isUnknownChannel(error)) {
        await markPersistedTicketDeleted(
          ticket.channelId,
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
        ticket.channelId,
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
    const topic = mergeDurableTicketTopic(channel.topic ?? '', ticket);
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
