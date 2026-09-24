import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  type ButtonInteraction,
  type Message,
  type TextChannel,
} from 'discord.js';
import { getGuildConfig, type GuildConfig } from './configService';
import { setChannelName } from './discordChannelService';
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
      /*
       * Closed tickets allow lifecycle controls plus read-only history.
       * History does not permit messages or other ticket mutations.
       */
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

  if (['open', 'claimed', 'pending', 'reopened'].includes(status)) {
    const positioning = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:panel:move-bottom')
        .setLabel('Move Controls Here')
        .setEmoji('⬇️')
        .setStyle(ButtonStyle.Secondary),
    );

    return [lifecycle, tools, positioning];
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
      await setChannelName(
        channel.id,
        newName,
        reason,
      );
      /*
       * Native REST bypasses discord.js' REST manager. Keep the cached
       * channel object synchronized so subsequent queued rename requests
       * do not operate on stale channel.name data.
       */
      channel.name = newName;
    });

  channelRenameQueues.set(channel.id, next);
  void next.finally(() => {
    if (channelRenameQueues.get(channel.id) === next) {
      channelRenameQueues.delete(channel.id);
    }
  }).catch(() => undefined);

  return next;
}


export function getTicketChannelName(
  ticketNumber: string,
  status: TicketStatus,
): string {
  /*
   * Discord text-channel names are lowercase, hyphen-separated slugs.
   * "reopened" intentionally uses the normal "open" channel name.
   */
  const channelStatus =
    status === 'reopened'
      ? 'open'
      : status === 'archived'
        ? 'archive'
        : status;

  return `ticket-${ticketNumber}-${channelStatus}`;
}

export const RESTORE_PANEL_CUSTOM_ID = 'ticket:panel:restore-move';

function isRestorePanelMessage(message: Message): boolean {
  return message.components.some(
    (row) =>
      row.type === ComponentType.ActionRow &&
      row.components.some(
        (component) =>
          'customId' in component &&
          component.customId === RESTORE_PANEL_CUSTOM_ID,
      ),
  );
}

function restorePanelButton(): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(RESTORE_PANEL_CUSTOM_ID)
    .setLabel('Restore/Move Panel')
    .setEmoji('⬇️')
    .setStyle(ButtonStyle.Secondary);
}

async function findCurrentPanelAndRestoreControl(
  channel: TextChannel,
  panelTitle: string,
  messageId: string | undefined,
): Promise<{ panel?: Message; restore?: Message }> {
  const recent = await channel.messages.fetch({ limit: 100 });

  const panel =
    (messageId ? recent.get(messageId) : undefined) ??
    recent.find(
      (message) =>
        message.author.id === channel.client.user?.id &&
        message.embeds.some((embed) => embed.title === panelTitle),
    );

  const restore = recent.find(
    (message) =>
      message.author.id === channel.client.user?.id &&
      isRestorePanelMessage(message),
  );

  return { panel, restore };
}

export async function collapseTicketPanelToRestoreButton(
  channel: TextChannel,
): Promise<void> {
  const topic = channel.topic ?? '';

  if (!topic.startsWith('supportforge:ticket')) {
    throw new Error('This channel is not a SupportForge ticket.');
  }

  const ticketNumber = getField(topic, 'number') ?? 'unknown';
  const panelTitle = `🎫 SupportForge Ticket #${ticketNumber}`;
  const messageId = getField(topic, 'message');

  const { panel, restore } = await findCurrentPanelAndRestoreControl(
    channel,
    panelTitle,
    messageId,
  );

  // Avoid creating repeated restore controls when the channel is already compacted.
  if (!panel && restore) {
    return;
  }

  const restoreMessage = await channel.send({
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        restorePanelButton(),
      ),
    ],
  });

  if (panel && panel.id !== restoreMessage.id) {
    await panel.delete().catch((error) => {
      console.warn(
        `⚠️ Could not remove full ticket panel in ${channel.id}:`,
        error,
      );
    });
  }

  if (restore && restore.id !== restoreMessage.id) {
    await restore.delete().catch(() => undefined);
  }

  console.log(
    `📦 Ticket #${ticketNumber} panel collapsed to Restore/Move Panel.`,
  );
}

export async function moveTicketPanelToBottom(
  channel: TextChannel,
): Promise<void> {
  const topic = channel.topic ?? '';

  if (!topic.startsWith('supportforge:ticket')) {
    throw new Error('This channel is not a SupportForge ticket.');
  }

  const status = getTicketStatus(topic);
  const config = await getGuildConfig(channel.guild.id);
  const ticketNumber = getField(topic, 'number') ?? 'unknown';
  const panelTitle = `🎫 SupportForge Ticket #${ticketNumber}`;
  const messageId = getField(topic, 'message');

  const { panel: currentPanel, restore: restoreControl } =
    await findCurrentPanelAndRestoreControl(
      channel,
      panelTitle,
      messageId,
    );

  const newPanel = await channel.send({
    embeds: [
      buildTicketPanelEmbed(
        channel.guild,
        channel.name,
        topic,
        config,
      ),
    ],
    components: buildTicketPanelComponents(status),
  });

  if (currentPanel && currentPanel.id !== newPanel.id) {
    await currentPanel.delete().catch((error) => {
      console.warn(
        `⚠️ Could not remove previous ticket panel in ${channel.id}:`,
        error,
      );
    });
  }

  if (restoreControl && restoreControl.id !== newPanel.id) {
    await restoreControl.delete().catch(() => undefined);
  }

  console.log(
    `📌 Ticket #${ticketNumber} controls manually moved to the bottom.`,
  );
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
