import { ChannelType, type Guild } from 'discord.js';

import { getPersistedTicket, registerTicket } from './ticketPersistenceService';
import { getField, getTicketStatus, isTicketTopic } from './ticketStateService';
import { type TicketPriority } from './advancedSettingsService';

/**
 * Rebuild only missing durable ticket rows from validated legacy channel topics.
 * Existing PostgreSQL records always win and are never overwritten from Discord.
 */
export async function recoverMissingTicketRecords(guild: Guild): Promise<number> {
  let recoveredTickets = 0;
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText || !isTicketTopic(channel.topic ?? '')) continue;
    const topic = channel.topic ?? '';
    const persisted = await getPersistedTicket(channel.id);
    if (persisted) continue;

    const ownerId = getField(topic, 'owner');
    const departmentId = getField(topic, 'department');
    const ticketNumber = getField(topic, 'number');
    if (!ownerId || !departmentId || !ticketNumber || !/^\d{1,12}$/.test(ticketNumber)) {
      console.warn('Skipping durable ticket recovery for malformed QueryFixr topic on channel ' + channel.id + '.');
      continue;
    }

    const priorityValue = getField(topic, 'priority');
    const priority: TicketPriority =
      priorityValue === 'low' || priorityValue === 'normal' || priorityValue === 'high' ||
      priorityValue === 'urgent' || priorityValue === 'critical'
        ? priorityValue
        : 'normal';
    const parseIds = (key: string): string[] =>
      (getField(topic, key) ?? '').split(',').map((value) => value.trim()).filter((value) => /^\d{17,20}$/.test(value));
    const claimedByIds = parseIds('claimed_by');
    const participantIds = Array.from(new Set([ownerId, ...parseIds('users'), ...claimedByIds]));
    const rawCreatedAt = getField(topic, 'opened_at');
    const parsedCreatedAt = rawCreatedAt ? new Date(rawCreatedAt) : new Date(channel.createdTimestamp);
    const createdAt = Number.isNaN(parsedCreatedAt.getTime())
      ? new Date(channel.createdTimestamp).toISOString()
      : parsedCreatedAt.toISOString();
    const rawUpdatedAt = getField(topic, 'updated_at');
    const parsedUpdatedAt = rawUpdatedAt ? new Date(rawUpdatedAt) : parsedCreatedAt;
    const lastActivityAt = Number.isNaN(parsedUpdatedAt.getTime())
      ? createdAt
      : parsedUpdatedAt.toISOString();

    await registerTicket(
      channel.id,
      {
        guildId: guild.id,
        status: getTicketStatus(topic),
        ticketNumber,
        departmentId,
        tagId: getField(topic, 'tag') ?? getField(topic, 'tags') ?? '',
        ownerId,
        priority,
        createdAt,
        claimedByIds,
        participantIds,
        metadata: {
          lastActivityAt,
          recoveredFromChannelTopic: true,
          panelMessageId: getField(topic, 'message') ?? null,
          formSubmissionInteractionId: getField(topic, 'form_submission') ?? null,
        },
      },
      {
        id: 'system',
        attribution: 'actorUnknown',
        confidence: 'none',
      },
    );
    recoveredTickets += 1;
  }
  return recoveredTickets;
}
