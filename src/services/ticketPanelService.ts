import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  ChannelType,
  type ButtonInteraction,
  type Message,
  type TextChannel,
  type Guild,
} from 'discord.js';
import { getGuildConfig, type GuildConfig } from './configService';
import { getPersistedTicketPriority, getPersistedTicketStatus } from './ticketPersistenceService';
import type { TicketPriority } from './advancedSettingsService';
import { setChannelName, setChannelTopic } from './discordChannelService';
import {
  getField,
  getTicketStatus,
  isTicketTopic,
  removeField,
  setField,
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
  const claimedModerators = (claimedBy ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const priority = getField(topic, 'priority') ?? 'normal';
  const tagId = getField(topic, 'tags');
  const ticketTag = department?.tags?.[tagId ?? ''];
  const users = getField(topic, 'users') ?? '';
  const pendingSince = getField(topic, 'pending_since');
  const closedAt = getField(topic, 'closed_at');
  const reopenedAt = getField(topic, 'reopened_at');
  const archivedAt = getField(topic, 'archived_at');
  const ticketNumber = getField(topic, 'number') ?? 'Unknown';

  return new EmbedBuilder()
    .setColor(priorityColor(priority))
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
      { name: '🙋 Moderators', value: claimedModerators.length ? claimedModerators.map((id) => `<@${id}>`).join(', ') : 'Unclaimed', inline: true },
      {
        name: '🏷️ Tag',
        value: ticketTag?.name ?? tagId ?? 'Not configured',
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

export function buildTicketPanelComponents(
  status: TicketStatus,
  topic = '',
): ActionRowBuilder<ButtonBuilder>[] {
  const lifecycle = new ActionRowBuilder<ButtonBuilder>();

  if (status === 'open' || status === 'reopened') {
    lifecycle.addComponents(
      new ButtonBuilder().setCustomId('ticket:claim').setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ticket:pending').setLabel('Pending').setEmoji('⏳').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    );
  } else if (status === 'claimed') {
    lifecycle.addComponents(
      new ButtonBuilder().setCustomId('ticket:claim').setLabel('Claim / Join').setEmoji('🙋').setStyle(ButtonStyle.Success),
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
      new ButtonBuilder().setCustomId('ticket:panel:department').setLabel('Department').setEmoji('📂').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ticket:panel:tag').setLabel('Tag').setEmoji('🏷️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ticket:panel:note').setLabel('Note').setEmoji('📝').setStyle(ButtonStyle.Secondary),
    );
  }

  if (['open', 'claimed', 'pending', 'reopened'].includes(status)) {
    const voiceChannelId = getField(topic, 'voice_channel_id');
    const claimedBy = getField(topic, 'claimed_by');
    const voiceControls = new ActionRowBuilder<ButtonBuilder>();

    if (status === 'claimed') {
      if (voiceChannelId) {
        /*
         * An active voice session always gets an explicit close control.
         * Keep it visible alongside Join Voice so moderators do not have to
         * hunt through lifecycle controls to end the temporary voice chat.
         */
        voiceControls.addComponents(
          new ButtonBuilder()
            .setCustomId('ticket:panel:voice:end')
            .setLabel('Close Voice Chat')
            .setEmoji('🔚')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('ticket:panel:voice:join')
            .setLabel('Join Voice')
            .setEmoji('🎙️')
            .setStyle(ButtonStyle.Secondary),
        );
      } else {
        voiceControls.addComponents(
          new ButtonBuilder()
            .setCustomId('ticket:panel:voice:start')
            .setLabel('Turn On Voice Mode')
            .setEmoji('🎙️')
            .setStyle(ButtonStyle.Primary),
        );
      }
    }

    const safety = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:panel:report')
        .setLabel('Report User')
        .setEmoji('🛡️')
        .setStyle(ButtonStyle.Primary),
    );

    const positioning = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:panel:move-bottom')
        .setLabel('Move Controls Here')
        .setEmoji('⬇️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('ticket:panel:history')
        .setLabel('History')
        .setEmoji('📜')
        .setStyle(ButtonStyle.Secondary),
    );

    return voiceControls.components.length
      ? [lifecycle, tools, voiceControls, safety, positioning]
      : [lifecycle, tools, safety, positioning];
  }

  return status === 'archived' ? [lifecycle] : [lifecycle, tools];
}


export async function refreshTicketPanel(
  channel: TextChannel,
  topicOverride?: string,
): Promise<void> {
  let effectiveTopic = topicOverride ?? channel.topic ?? '';
  const persistedStatus = await getPersistedTicketStatus(channel.id).catch(() => undefined);
  const persistedPriority = await getPersistedTicketPriority(channel.id).catch(() => undefined);

  if (persistedStatus) {
    effectiveTopic = setField(effectiveTopic, 'status', persistedStatus);
  }

  if (persistedPriority) {
    effectiveTopic = setField(effectiveTopic, 'priority', persistedPriority);
  }
  const messageId = getField(effectiveTopic, 'message');
  if (!messageId) return;

  const config = await getGuildConfig(channel.guild.id);
  const message =
    channel.messages.cache.get(messageId) ??
    (await channel.messages.fetch(messageId));

  await message.edit({
    embeds: [
      buildTicketPanelEmbed(
        channel.guild,
        channel.name,
        effectiveTopic,
        config,
      ),
    ],
    components: buildTicketPanelComponents(
      getTicketStatus(effectiveTopic),
      effectiveTopic,
    ),
  });
}

const channelRenameQueues = new Map<string, Promise<void>>();
const desiredChannelNames = new Map<string, string>();
const channelRenameRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getRateLimitRetryDelayMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/another\s+(\d+)s\b/i);
  if (!match) return null;

  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0
    ? (seconds + 1) * 1000
    : null;
}

async function performQueuedChannelRename(
  channel: TextChannel,
  newName: string,
  reason: string,
): Promise<void> {
  if (desiredChannelNames.get(channel.id) !== newName) {
    return;
  }

  if (channel.name === newName) {
    desiredChannelNames.delete(channel.id);
    return;
  }

  try {
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
    desiredChannelNames.delete(channel.id);

    const existingTimer = channelRenameRetryTimers.get(channel.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
      channelRenameRetryTimers.delete(channel.id);
    }

    console.log(
      `✅ Ticket channel renamed to ${newName}: ${channel.id}`,
    );
  } catch (error) {
    const retryDelayMs = getRateLimitRetryDelayMs(error);

    if (retryDelayMs !== null) {
      console.warn(
        `⏳ Ticket rename delayed for ${Math.ceil(retryDelayMs / 1000)}s by Discord rate limit: ${channel.id}`,
      );

      const existingTimer = channelRenameRetryTimers.get(channel.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        channelRenameRetryTimers.delete(channel.id);
        if (desiredChannelNames.get(channel.id) !== newName) {
          return;
        }
        void performQueuedChannelRename(channel, newName, reason);
      }, retryDelayMs);

      channelRenameRetryTimers.set(channel.id, timer);
      return;
    }

    throw error;
  }
}

export function queueTicketChannelRename(
  channel: TextChannel,
  newName: string,
  reason: string,
): Promise<void> {
  desiredChannelNames.set(channel.id, newName);

  const previous = channelRenameQueues.get(channel.id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => performQueuedChannelRename(channel, newName, reason));

  channelRenameQueues.set(channel.id, next);
  void next.finally(() => {
    if (
      channelRenameQueues.get(channel.id) === next &&
      desiredChannelNames.get(channel.id) === newName
    ) {
      channelRenameQueues.delete(channel.id);
    }
  }).catch(() => undefined);

  return next;
}


export function getTicketChannelName(
  ticketNumber: string,
  status: TicketStatus,
  priority: TicketPriority = 'normal',
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

  return `${priorityIndicator(priority)}-ticket-${ticketNumber}-${channelStatus}`;
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

  let panel = messageId
    ? (recent.get(messageId) ??
      await channel.messages.fetch(messageId).catch(() => null))
    : undefined;

  panel ??= recent.find(
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

  /*
   * If the panel is already compacted, keep the restore control unique but
   * move it to the newest position. This allows the automatic activity
   * threshold to trigger again after the user continues the conversation.
   */
  if (!panel && restore) {
    const restoreMessage = await channel.send({
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          restorePanelButton(),
        ),
      ],
    });

    if (restore.id !== restoreMessage.id) {
      await restore.delete().catch((error) => {
        console.warn(
          `⚠️ Could not remove previous Restore/Move Panel control in ${channel.id}:`,
          error,
        );
      });
    }

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

  const collapsedTopic = removeField(topic, 'message');
  channel.topic = collapsedTopic;
  await setChannelTopic(
    channel.id,
    collapsedTopic,
    'SupportForge panel collapsed to restore control',
  ).catch(() => undefined);

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

  const status =
    (await getPersistedTicketStatus(channel.id).catch(() => undefined)) ??
    getTicketStatus(topic);
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
    components: buildTicketPanelComponents(status, topic),
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

  const movedTopic = setField(topic, 'message', newPanel.id);
  channel.topic = movedTopic;
  await setChannelTopic(
    channel.id,
    movedTopic,
    'SupportForge ticket panel pointer moved to latest panel',
  ).catch(() => undefined);

  console.log(
    `📌 Ticket #${ticketNumber} controls manually moved to the bottom.`,
  );
}

export async function refreshTicketPanelControls(guild: Guild): Promise<void> {
  const ticketChannels = guild.channels.cache.filter(
    (channel): channel is TextChannel =>
      channel.type === ChannelType.GuildText &&
      isTicketTopic(channel.topic ?? ''),
  );

  for (const channel of ticketChannels.values()) {
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!recent) continue;

    const restore = recent.find(
      (message) =>
        message.author.id === channel.client.user?.id &&
        isRestorePanelMessage(message),
    );

    if (restore) {
      await restore.edit({
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            restorePanelButton(),
          ),
        ],
      }).catch(() => undefined);
      continue;
    }

    await refreshTicketPanel(channel).catch(() => undefined);
  }
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

function normalizedPriority(priority: string): TicketPriority {
  return ['low', 'normal', 'high', 'urgent', 'critical'].includes(priority)
    ? priority as TicketPriority
    : 'normal';
}

export function priorityIndicator(priority: string): string {
  return {
    low: '🟢',
    normal: '🟡',
    high: '🟠',
    urgent: '🔴',
    critical: '🟣',
  }[normalizedPriority(priority)];
}

function priorityColor(priority: string): number {
  return {
    low: 0x2ecc71,
    normal: 0xf1c40f,
    high: 0xe67e22,
    urgent: 0xe74c3c,
    critical: 0x9b59b6,
  }[normalizedPriority(priority)];
}

function priorityLabel(priority: string): string {
  const normalized = normalizedPriority(priority);
  const labels: Record<TicketPriority, string> = {
    low: '🟢 Low',
    normal: '🟡 Normal',
    high: '🟠 High',
    urgent: '🔴 Urgent',
    critical: '🟣 Critical',
  };
  return labels[normalized];
}
