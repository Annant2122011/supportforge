import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './configService';

export interface AuditEvent {
  ticketNumber: string;
  event: string;
  actor?: string;
  detail?: string;
}

const AUDIT_TOPIC = 'supportforge:audit';
const AUDIT_NAME = '📒 supportforge-audit-log';

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
    return existing;
  }

  const bot = guild.members.me;
  if (!bot) throw new Error('SupportForge bot member could not be resolved.');

  const staffRoleIds = (await getGuildConfig(guild.id)).departments;
  const uniqueStaffRoleIds = [
    ...new Set(
      Object.values(staffRoleIds)
        .map((department) => department.staffRoleId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

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

  await updateGuildConfig(guild.id, (config) => {
    config.auditChannelId = channel.id;
  });

  return channel;
}

export async function logTicketEvent(
  guild: Guild,
  parentCategoryId: string,
  event: AuditEvent,
): Promise<void> {
  try {
    const channel = await getOrCreateAuditChannel(guild, parentCategoryId);

    const detail = [
      event.actor ? `**Actor:** ${event.actor}` : null,
      event.detail ? `**Detail:** ${event.detail}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('SupportForge Audit Log')
          .setDescription(
            `🎫 **Ticket #${event.ticketNumber}**\n**${event.event}**${detail ? `\n\n${detail}` : ''}`,
          )
          .setTimestamp(),
      ],
    });
  } catch (error) {
    console.error('❌ Failed to write audit log:', error);
  }
}
