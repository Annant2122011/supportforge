import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
  type VoiceChannel,
} from 'discord.js';

import { setChannelTopic } from './discordChannelService';
import { getField, removeField, setField } from './ticketStateService';
import { getTicketChannelName, queueTicketChannelRename } from './ticketPanelService';
import type { TicketPriority } from './advancedSettingsService';
import type { TicketStatus } from './ticketStateService';

const VOICE_TOPIC_RETRY_MAX_DELAY_MS = 15 * 60 * 1000;
const voiceTopicRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getRetryDelayMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/another\s+(\d+)s\b/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min((seconds + 1) * 1000, VOICE_TOPIC_RETRY_MAX_DELAY_MS);
}

function participantOverwrites(guild: Guild, ownerId: string, moderatorId: string) {
  const botId = guild.members.me?.id;
  if (!botId) throw new Error('SupportForge bot member could not be resolved.');

  const participantAllow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    PermissionFlagsBits.Stream,
    PermissionFlagsBits.UseVAD,
  ];

  return [
    {
      id: guild.roles.everyone.id,
      deny: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
      ],
    },
    {
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.MoveMembers,
      ],
    },
    { id: ownerId, allow: participantAllow },
    { id: moderatorId, allow: participantAllow },
  ];
}

async function updateVoiceTopic(channel: TextChannel, topic: string, reason: string): Promise<string> {
  channel.topic = topic;
  const previous = voiceTopicRetryTimers.get(channel.id);
  if (previous) clearTimeout(previous);
  voiceTopicRetryTimers.delete(channel.id);

  try {
    await setChannelTopic(channel.id, topic, reason);
  } catch (error) {
    const delay = getRetryDelayMs(error);
    if (delay !== null) {
      const retry = setTimeout(() => {
        voiceTopicRetryTimers.delete(channel.id);
        void setChannelTopic(channel.id, topic, reason).catch(() => undefined);
      }, delay);
      retry.unref?.();
      voiceTopicRetryTimers.set(channel.id, retry);
    }
    console.warn('⚠️ Voice ticket metadata update was delayed:', error);
  }

  return topic;
}

export async function startTicketVoiceMode(
  guild: Guild,
  ticketChannel: TextChannel,
  topic: string,
): Promise<{ voiceChannel: VoiceChannel; topic: string }> {
  const ownerId = getField(topic, 'owner');
  const moderatorId = getField(topic, 'claimed_by');
  const number = getField(topic, 'number') ?? 'unknown';

  if (!ownerId || !moderatorId) {
    throw new Error('Voice mode requires a ticket owner and claiming moderator.');
  }

  const existingId = getField(topic, 'voice_channel_id');
  if (existingId) {
    const existing = guild.channels.cache.get(existingId);
    if (existing?.type === ChannelType.GuildVoice) {
      return { voiceChannel: existing, topic };
    }
  }

  const voiceChannel = await guild.channels.create({
    name: 'ticket-' + number + '-voice',
    type: ChannelType.GuildVoice,
    parent: ticketChannel.parentId ?? undefined,
    userLimit: 2,
    permissionOverwrites: participantOverwrites(guild, ownerId, moderatorId),
    reason: 'SupportForge private voice mode for ticket #' + number,
  }) as VoiceChannel;

  let newTopic = setField(topic, 'voice_channel_id', voiceChannel.id);
  newTopic = setField(newTopic, 'voice_started_at', new Date().toISOString());
  newTopic = setField(newTopic, 'voice_started_by', moderatorId);
  newTopic = setField(newTopic, 'voice_channel_name', voiceChannel.name);
  newTopic = await updateVoiceTopic(
    ticketChannel,
    newTopic,
    'SupportForge voice mode metadata for ticket #' + number,
  );

  void queueTicketChannelRename(
    ticketChannel,
    'ticket-' + number + '-voice',
    'Ticket #' + number + ' promoted to private voice mode',
  ).catch(() => undefined);

  return { voiceChannel, topic: newTopic };
}

export async function endTicketVoiceMode(
  guild: Guild,
  ticketChannel: TextChannel,
  topic: string,
  status: TicketStatus,
  reason: string,
): Promise<string> {
  const voiceId = getField(topic, 'voice_channel_id');
  const number = getField(topic, 'number') ?? 'unknown';
  const voiceChannel = voiceId ? guild.channels.cache.get(voiceId) : undefined;

  if (voiceChannel?.type === ChannelType.GuildVoice) {
    await voiceChannel.delete(reason).catch((error) => {
      console.warn('⚠️ Could not delete SupportForge voice channel ' + voiceId + ':', error);
    });
  }

  let newTopic = removeField(topic, 'voice_channel_id');
  newTopic = removeField(newTopic, 'voice_started_at');
  newTopic = removeField(newTopic, 'voice_started_by');
  newTopic = removeField(newTopic, 'voice_channel_name');
  newTopic = await updateVoiceTopic(
    ticketChannel,
    newTopic,
    'Clear voice mode metadata for ticket #' + number,
  );

  const priority = getField(newTopic, 'priority') ?? 'normal';
  void queueTicketChannelRename(
    ticketChannel,
    getTicketChannelName(number, status, priority as TicketPriority),
    reason,
  ).catch(() => undefined);

  return newTopic;
}
