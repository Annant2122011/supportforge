import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type TextChannel,
} from 'discord.js';
import { getGuildConfig, type GuildConfig } from './configService';
import {
  getField,
  getTicketStatus,
  type TicketStatus,
} from './ticketStateService';

function decodeSubject(raw: string | undefined): string {
  if (!raw) return 'Unknown subject';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function formatInstant(value: string | undefined): string {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

export function buildTicketPanelEmbed(
  guild: { name: string },
  channelName: string,
  topic: string,
  config: GuildConfig,
): EmbedBuilder {
  const status = getTicketStatus(topic);
  const departmentId = getField(topic, 'department');
  const department = departmentId ? config.departments[departmentId] : undefined;
  const ownerId = getField(topic, 'owner');
  const claimedBy = getField(topic, 'claimed_by');
  const priority = getField(topic, 'priority') ?? 'normal';
  const tags = getField(topic, 'tags') ?? '';
  const users = getField(topic, 'users') ?? '';
  const pendingSince = getField(topic, 'pending_since');
  const closedAt = getField(topic, 'closed_at');
  const reopenedAt = getField(topic, 'reopened_at');
  const archivedAt = getField(topic, 'archived_at');
  const ticketNumber = getField(topic, 'number') ?? 'Unknown';

  return new EmbedBuilder()
    .setTitle(`🎫 SupportForge Ticket #${ticketNumber}`)
    .setDescription(
      `**${decodeSubject(getField(topic, 'subject'))}**\n\n` +
        `Use the controls below to manage this ticket.`,
    )
    .addFields(
      { name: '📊 Status', value: `${statusEmoji(status)} **${capitalize(status)}**`, inline: true },
      { name: '📂 Department', value: department?.name ?? departmentId ?? 'Unknown', inline: true },
      { name: '⚡ Priority', value: priorityLabel(priority), inline: true },
      { name: '👤 Owner', value: ownerId ? `<@${ownerId}>` : 'Unknown', inline: true },
      { name: '🙋 Claimed by', value: claimedBy ? `<@${claimedBy}>` : 'Unclaimed', inline: true },
      {
        name: '🏷️ Tags',
        value: tags ? tags.split(',').map((tag) => `\`${tag}\``).join(' ') : 'None',
        inline: true,
      },
      {
        name: '👥 Added users',
        value: users ? users.split(',').map((id) => `<@${id}>`).join(', ') : 'None',
      },
    )
    .addFields(
      { name: '⏳ Pending since', value: formatInstant(pendingSince), inline: true },
      { name: '🔒 Closed', value: formatInstant(closedAt), inline: true },
      { name: '🔓 Reopened', value: formatInstant(reopenedAt), inline: true },
      { name: '🗄️ Archived', value: formatInstant(archivedAt), inline: true },
    )
    .setFooter({ text: `${guild.name} • #${channelName}` })
    .setTimestamp();
}

export function buildTicketPanelComponents(status: TicketStatus): ActionRowBuilder<ButtonBuilder>[] {
  const lifecycle = new ActionRowBuilder<ButtonBuilder>();

  if (status === 'open' || status === 'reopened') {
    lifecycle.addComponents(
      new ButtonBuilder().setCustomId('ticket:claim').setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ticket:pending').setLabel('Pending').setEmoji('⏳').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    );
  } else if (status === 'claimed') {
    lifecycle.addComponents(
      new ButtonBuilder().setCustomId('ticket:unclaim').setLabel('Unclaim').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ticket:pending').setLabel('Pending').setEmoji('⏳').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    );
  } else if (status === 'pending') {
    lifecycle.addComponents(
      new ButtonBuilder().setCustomId('ticket:resume').setLabel('Resume').setEmoji('▶️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    );
  } else if (status === 'closed') {
    lifecycle.addComponents(
      new ButtonBuilder().setCustomId('ticket:reopen').setLabel('Reopen').setEmoji('🔓').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ticket:archive').setLabel('Archive').setEmoji('🗄️').setStyle(ButtonStyle.Secondary),
    );
  } else {
    lifecycle.addComponents(
      new ButtonBuilder().setCustomId('ticket:archived').setLabel('Archived').setEmoji('🗄️').setStyle(ButtonStyle.Secondary).setDisabled(true),
    );
  }

  const tools = new ActionRowBuilder<ButtonBuilder>();
  if (status !== 'archived') {
    if (status === 'closed') {
      tools.addComponents(
        new ButtonBuilder().setCustomId('ticket:panel:history').setLabel('History').setEmoji('📜').setStyle(ButtonStyle.Secondary),
      );
      return [lifecycle, tools];
    }

    tools.addComponents(
      new ButtonBuilder().setCustomId('ticket:panel:add-user').setLabel('Add User').setEmoji('👥').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ticket:panel:priority').setLabel('Priority').setEmoji('⚡').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ticket:panel:tag').setLabel('Tag').setEmoji('🏷️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ticket:panel:note').setLabel('Note').setEmoji('📝').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ticket:panel:history').setLabel('History').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    );
  }

  return status === 'archived' ? [lifecycle] : [lifecycle, tools];
}


export async function refreshTicketPanel(
  channel: TextChannel,
  topicOverride?: string,
): Promise<void> {
  const topic = topicOverride ?? channel.topic ?? '';
  const messageId = getField(topic, 'message');
  if (!messageId) return;

  const config = await getGuildConfig(channel.guild.id);
  const message =
    channel.messages.cache.get(messageId) ??
    (await channel.messages.fetch(messageId));

  await message.edit({
    embeds: [buildTicketPanelEmbed(channel.guild, channel.name, topic, config)],
    components: buildTicketPanelComponents(getTicketStatus(topic)),
  });
}

const channelRenameQueues = new Map<string, Promise<void>>();

export function queueTicketChannelRename(
  channel: TextChannel,
  newName: string,
  reason: string,
): Promise<void> {
  const previous = channelRenameQueues.get(channel.id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (channel.name === newName) return;
      await channel.setName(newName, reason);
    });

  channelRenameQueues.set(channel.id, next);
  void next.finally(() => {
    if (channelRenameQueues.get(channel.id) === next) {
      channelRenameQueues.delete(channel.id);
    }
  }).catch(() => undefined);

  return next;
}

export function isPanelButton(interaction: ButtonInteraction): boolean {
  return interaction.customId.startsWith('ticket:panel:');
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function statusEmoji(status: TicketStatus): string {
  return {
    open: '🟢',
    claimed: '🙋',
    pending: '⏳',
    closed: '🔒',
    reopened: '🔓',
    archived: '🗄️',
  }[status];
}

function priorityLabel(priority: string): string {
  const labels: Record<string, string> = {
    low: '🟢 Low',
    normal: '⚪ Normal',
    high: '🟠 High',
    urgent: '🔴 Urgent',
    critical: '🟣 Critical',
  };
  return labels[priority] ?? priority;
}
