import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
} from 'discord.js';

const AUDIT_LOG_CHANNEL_NAME = '📒 supportforge-audit-log';

/**
 * Audit logging is a Premium-tier feature. Callers are expected to
 * check tierService.isPremiumOrHigher() before calling this — this
 * function does not check tier itself, to keep it a plain utility.
 */
async function findOrCreateAuditLogChannel(
  guild: Guild,
  parentCategoryId?: string,
) {
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.name === AUDIT_LOG_CHANNEL_NAME,
  );

  if (existing && existing.type === ChannelType.GuildText) {
    return existing;
  }

  const botMember = guild.members.me;

  if (!botMember) {
    return null;
  }

  try {
    return await guild.channels.create({
      name: AUDIT_LOG_CHANNEL_NAME,
      type: ChannelType.GuildText,
      parent: parentCategoryId,
      topic:
        'SupportForge audit log (Premium demo feature). ' +
        'Do not delete this channel.',

      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: botMember.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ],
    });
  } catch (error) {
    console.error(
      '❌ Failed to create SupportForge audit log channel:',
      error,
    );

    return null;
  }
}

export async function logTicketEvent(
  guild: Guild,
  options: {
    ticketNumber: string;
    event: string;
    detail?: string;
    parentCategoryId?: string;
  },
): Promise<void> {
  try {
    const channel = await findOrCreateAuditLogChannel(
      guild,
      options.parentCategoryId,
    );

    if (!channel) {
      return;
    }

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x2b2d31)
          .setDescription(
            `🎫 **#${options.ticketNumber}** — ${options.event}` +
              (options.detail ? `\n${options.detail}` : ''),
          )
          .setTimestamp(),
      ],
    });
  } catch (error) {
    console.error(
      '❌ Failed to write SupportForge audit log entry:',
      error,
    );
  }
}
