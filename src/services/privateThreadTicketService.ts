import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type ThreadChannel,
  type TextChannel,
} from 'discord.js';

import { getGuildConfig, updateGuildConfig, type DepartmentConfig } from './configService';
import { getAdvancedSettings, updateAdvancedSettings } from './advancedSettingsService';
import {
  getPersistedTicket,
  getPersistedTicketStatus,
  registerTicket,
  transitionPersistedTicket,
  updatePersistedTicketMetadata,
  type PersistedTicket,
} from './ticketPersistenceService';
import { getField, getTicketStatus, isTicketTopic, setField, type TicketStatus } from './ticketStateService';
import { projectDurableTicketTopic } from './ticketTopicProjectionService';
import { buildTicketPanelEmbed } from './ticketPanelService';
import { logTicketEvent } from './auditLogService';
import { canPrivateThreadTicketAction, getPrivateThreadTicketActions, normalizeTicketWorkspaceMode, type PrivateThreadTicketAction, type TicketWorkspaceMode } from '../core/domain/privateThreadTicketPolicy';

const THREAD_PARENT_PREFIX = 'supportforge:ticket-thread-parent';

export async function getTicketWorkspaceMode(guildId: string): Promise<TicketWorkspaceMode> {
  const settings = await getAdvancedSettings(guildId);
  return normalizeTicketWorkspaceMode(settings.ticketWorkspace?.mode);
}

export async function setTicketWorkspaceMode(guildId: string, mode: TicketWorkspaceMode): Promise<void> {
  await updateAdvancedSettings(guildId, (settings) => {
    settings.ticketWorkspace.mode = normalizeTicketWorkspaceMode(mode);
  });
}

function threadParentTopic(guildId: string, departmentId: string): string {
  return THREAD_PARENT_PREFIX + ' guild=' + guildId + ' department=' + departmentId;
}

function baseParentOverwrites(guild: Guild, botId: string) {
  return [
    {
      id: guild.roles.everyone.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessagesInThreads,
      ],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.ManageThreads,
      ],
    },
    {
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.ManageThreads,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ],
      deny: [],
    },
  ];
}

async function ensurePrivateThreadParent(
  guild: Guild,
  department: DepartmentConfig,
): Promise<TextChannel> {
  const config = await getGuildConfig(guild.id);
  if (!config.supportCategoryId) {
    throw new Error('SupportForge setup must be completed before private-thread tickets can be created.');
  }
  const category = guild.channels.cache.get(config.supportCategoryId);
  if (category?.type !== ChannelType.GuildCategory) {
    throw new Error('The SupportForge category is missing. Run /supportforge repair before opening a private-thread ticket.');
  }
  const bot = guild.members.me;
  if (!bot) throw new Error('The bot member could not be resolved for private-thread setup.');

  const expectedTopic = threadParentTopic(guild.id, department.id);
  let parent: TextChannel | undefined;
  if (department.threadParentChannelId) {
    const saved = guild.channels.cache.get(department.threadParentChannelId)
      ?? await guild.channels.fetch(department.threadParentChannelId).catch(() => null);
    if (saved?.type === ChannelType.GuildText && saved.topic === expectedTopic) {
      parent = saved;
    }
  }
  if (!parent) {
    const existing = guild.channels.cache.find((channel) =>
      channel.type === ChannelType.GuildText && channel.topic === expectedTopic,
    );
    if (existing?.type === ChannelType.GuildText) parent = existing;
  }

  if (!parent) {
    const slug = department.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'support';
    parent = await guild.channels.create({
      name: 'ticket-threads-' + slug,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: expectedTopic,
      permissionOverwrites: baseParentOverwrites(guild, bot.id),
      reason: 'ResolveX private-thread ticket workspace for department ' + department.name,
    });
  } else {
    if (parent.parentId !== category.id || parent.topic !== expectedTopic) {
      await parent.edit({
        parent: category.id,
        lockPermissions: false,
        topic: expectedTopic,
        reason: 'ResolveX private-thread workspace reconciliation',
      });
    }
    await parent.permissionOverwrites.edit(guild.roles.everyone.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessagesInThreads: true,
      SendMessages: false,
      CreatePrivateThreads: false,
      CreatePublicThreads: false,
      ManageThreads: false,
    });
    await parent.permissionOverwrites.edit(bot.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      SendMessagesInThreads: true,
      CreatePrivateThreads: true,
      ManageThreads: true,
      EmbedLinks: true,
      AttachFiles: true,
    });

    const previousStaffRoleId = department.threadParentStaffRoleId;
    if (previousStaffRoleId && previousStaffRoleId !== department.staffRoleId) {
      await parent.permissionOverwrites.delete(previousStaffRoleId).catch(() => undefined);
    }
  }

  if (department.staffRoleId) {
    const role = guild.roles.cache.get(department.staffRoleId)
      ?? await guild.roles.fetch(department.staffRoleId).catch(() => null);
    if (!role || role.managed) {
      throw new Error('The configured department staff role is missing or managed. Update the department staff role before using private threads.');
    }
    await parent.permissionOverwrites.edit(role.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      SendMessagesInThreads: true,
      ManageThreads: true,
    });
  } else if (department.threadParentStaffRoleId) {
    await parent.permissionOverwrites.delete(department.threadParentStaffRoleId).catch(() => undefined);
  }

  await updateGuildConfig(guild.id, (current) => {
    const savedDepartment = current.departments[department.id];
    if (!savedDepartment) return;
    savedDepartment.threadParentChannelId = parent!.id;
    savedDepartment.threadParentStaffRoleId = department.staffRoleId ?? null;
  });
  return parent;
}

export async function createPrivateThreadTicket(
  guild: Guild,
  department: DepartmentConfig,
  ticketNumber: string,
  subject: string,
  ownerId: string,
): Promise<{ thread: ThreadChannel; parent: TextChannel }> {
  const parent = await ensurePrivateThreadParent(guild, department);
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42) || 'request';
  const thread = await parent.threads.create({
    name: ('ticket-' + ticketNumber + '-' + slug).slice(0, 100),
    type: ChannelType.PrivateThread,
    autoArchiveDuration: 1440,
    invitable: false,
    reason: 'ResolveX ticket #' + ticketNumber + ' for ' + ownerId,
  });
  try {
    await thread.members.add(ownerId);
  } catch (error) {
    await thread.delete('ResolveX could not grant the ticket owner private-thread access').catch(() => undefined);
    throw new Error('Private ticket thread was created but the ticket owner could not be added. The new thread was removed to avoid leaving an inaccessible ticket.', { cause: error });
  }
  return { thread, parent };
}

export function buildPrivateThreadTicketComponents(status: TicketStatus): ActionRowBuilder<ButtonBuilder>[] {
  const actions = getPrivateThreadTicketActions(status);
  const labels: Record<PrivateThreadTicketAction, { label: string; emoji: string; style: ButtonStyle }> = {
    claim: { label: 'Claim', emoji: '🙋', style: ButtonStyle.Success },
    unclaim: { label: 'Unclaim', emoji: '↩️', style: ButtonStyle.Secondary },
    pending: { label: 'Pending', emoji: '⏳', style: ButtonStyle.Secondary },
    resume: { label: 'Resume', emoji: '▶️', style: ButtonStyle.Success },
    close: { label: 'Close', emoji: '🔒', style: ButtonStyle.Danger },
    reopen: { label: 'Reopen', emoji: '🔓', style: ButtonStyle.Success },
    archive: { label: 'Archive', emoji: '🗄️', style: ButtonStyle.Secondary },
  };
  const buttons = actions.map((action) => new ButtonBuilder()
    .setCustomId('ticket:thread:' + action)
    .setLabel(labels[action].label)
    .setEmoji(labels[action].emoji)
    .setStyle(labels[action].style));
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(index, index + 5)));
  }
  if (!rows.length) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('ticket:thread:archived').setLabel('Archived').setEmoji('🗄️').setStyle(ButtonStyle.Secondary).setDisabled(true),
    ));
  }
  return rows;
}

function parseTicketTopic(ticket: PersistedTicket): string {
  const stored = ticket.metadata?.ticketTopic;
  if (typeof stored === 'string' && isTicketTopic(stored)) return stored;
  return projectDurableTicketTopic('', ticket);
}

function actor(interaction: ButtonInteraction | ChatInputCommandInteraction) {
  return { id: interaction.user.id, attribution: 'actorKnown' as const, confidence: 'high' as const };
}

async function isDepartmentStaffOrAdmin(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  staffRoleId: string | undefined,
): Promise<boolean> {
  if (
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) return true;
  if (!interaction.guild || !staffRoleId) return false;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  return Boolean(member?.roles.cache.has(staffRoleId));
}

async function refreshPrivateThreadPanel(
  thread: ThreadChannel,
  ticket: PersistedTicket,
  topic: string,
): Promise<void> {
  const config = await getGuildConfig(thread.guild.id);
  const embeds = [buildTicketPanelEmbed(thread.guild, thread.name, topic, config)];
  const components = buildPrivateThreadTicketComponents(ticket.status);
  const messageId = typeof ticket.metadata.panelMessageId === 'string' ? ticket.metadata.panelMessageId : null;
  let panel = messageId
    ? await thread.messages.fetch(messageId).catch(() => null)
    : null;
  if (!panel) {
    const recent = await thread.messages.fetch({ limit: 100 }).catch(() => null);
    panel = recent?.find((message) =>
      message.author.id === thread.client.user?.id &&
      message.embeds.some((embed) => embed.title === '🎫 SupportForge Ticket #' + ticket.ticketNumber),
    ) ?? null;
  }
  if (panel) {
    await panel.edit({ embeds, components });
    if (panel.id !== messageId) {
      await updatePersistedTicketMetadata(thread.id, {
        metadata: { panelMessageId: panel.id, panelChannelId: thread.id, ticketTopic: topic },
      }, { id: 'supportforge-system', attribution: 'actorKnown', confidence: 'high' });
    }
  } else {
    const next = await thread.send({ embeds, components, allowedMentions: { parse: [] } });
    await updatePersistedTicketMetadata(thread.id, {
      metadata: { panelMessageId: next.id, panelChannelId: thread.id, ticketTopic: topic },
    }, { id: 'supportforge-system', attribution: 'actorKnown', confidence: 'high' });
  }
}

function nextTicketTopic(
  ticket: PersistedTicket,
  topic: string,
  status: TicketStatus,
  now: string,
  claimedByIds: string[],
): string {
  let next = setField(topic, 'status', status);
  next = setField(next, 'claimed_by', claimedByIds.join(','));
  next = setField(next, 'updated_at', now);
  if (status === 'pending') next = setField(next, 'pending_since', now);
  if (status === 'closed') next = setField(next, 'closed_at', now);
  if (status === 'reopened') next = setField(next, 'reopened_at', now);
  if (status === 'archived') next = setField(next, 'archived_at', now);
  if (status === 'open') {
    next = setField(next, 'pending_since', '');
    next = setField(next, 'closed_at', '');
    next = setField(next, 'archived_at', '');
  }
  return next;
}

async function performThreadAction(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  action: PrivateThreadTicketAction,
): Promise<void> {
  const guild = interaction.guild;
  const channel = interaction.channel;
  if (!guild || channel?.type !== ChannelType.PrivateThread) {
    throw new Error('This action must be used in a ResolveX private ticket thread.');
  }
  const thread = channel as ThreadChannel;
  const ticket = await getPersistedTicket(thread.id);
  if (
    !ticket ||
    ticket.guildId !== guild.id ||
    ticket.deletedAt ||
    ticket.metadata.workspaceKind !== 'private-thread'
  ) {
    throw new Error('This private thread is not linked to an active durable ResolveX ticket.');
  }
  const topic = parseTicketTopic(ticket);
  const staffRoleId = typeof ticket.metadata.staffRoleId === 'string'
    ? ticket.metadata.staffRoleId
    : getField(topic, 'staff');
  const staff = await isDepartmentStaffOrAdmin(interaction, staffRoleId);
  const owner = ticket.ownerId === interaction.user.id;
  if (!staff && !(action === 'close' && owner)) {
    throw new Error('Only this department’s configured staff, a server administrator, or the ticket owner closing their own ticket may do that.');
  }

  let nextStatus: TicketStatus;
  let claimedByIds = [...ticket.claimedByIds];
  if (!canPrivateThreadTicketAction(ticket.status, action)) {
    throw new Error('That action is not available while this ticket is ' + ticket.status + '.');
  }
  switch (action) {
    case 'claim':
      nextStatus = 'claimed';
      claimedByIds = [...new Set([...claimedByIds, interaction.user.id])];
      break;
    case 'unclaim':
      if (!claimedByIds.includes(interaction.user.id) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        throw new Error('You can only remove your own claim, unless you are a server administrator.');
      }
      claimedByIds = claimedByIds.filter((id) => id !== interaction.user.id);
      nextStatus = claimedByIds.length ? 'claimed' : 'open';
      break;
    case 'pending':
      nextStatus = 'pending';
      break;
    case 'resume':
      nextStatus = 'open';
      claimedByIds = [];
      break;
    case 'close':
      nextStatus = 'closed';
      claimedByIds = [];
      break;
    case 'reopen':
      nextStatus = 'reopened';
      claimedByIds = [];
      break;
    case 'archive':
      nextStatus = 'archived';
      claimedByIds = [];
      break;
  }

  if (thread.archived || thread.locked) {
    await thread.setArchived(false, 'ResolveX ticket lifecycle update');
    if (thread.locked) await thread.setLocked(false, 'ResolveX ticket lifecycle update');
  }

  const now = new Date().toISOString();
  const nextTopic = nextTicketTopic(ticket, topic, nextStatus, now, claimedByIds);
  const nextParticipants = [...new Set([
    ...(ticket.ownerId ? [ticket.ownerId] : []),
    ...ticket.participantIds.filter((id) => id !== ticket.ownerId),
  ])];
  await transitionPersistedTicket(thread.id, nextStatus, {
    claimedByIds,
    participantIds: nextParticipants,
    metadata: {
      ticketTopic: nextTopic,
      lastActivityAt: now,
      ...(nextStatus === 'closed' ? { closedAt: now } : {}),
      ...(nextStatus === 'reopened' ? { reopenedAt: now } : {}),
      ...(nextStatus === 'archived' ? { archivedAt: now } : {}),
    },
  }, actor(interaction), now);

  const updated = await getPersistedTicket(thread.id);
  if (!updated) throw new Error('The ticket state was saved, but its updated record could not be reloaded.');
  await refreshPrivateThreadPanel(thread, updated, nextTopic);

  const config = await getGuildConfig(guild.id);
  const eventName: Record<PrivateThreadTicketAction, string> = {
    claim: 'ticket_claimed',
    unclaim: 'ticket_unclaimed',
    pending: 'ticket_pending',
    resume: 'ticket_resumed',
    close: 'ticket_closed',
    reopen: 'ticket_reopened',
    archive: 'ticket_archived',
  };
  if (config.supportCategoryId) {
    void logTicketEvent(guild, config.supportCategoryId, {
      ticketNumber: ticket.ticketNumber ?? 'unknown',
      ticketChannelId: thread.id,
      event: eventName[action],
      actor: interaction.user.tag,
      actorId: interaction.user.id,
      actorName: interaction.user.tag,
      detail: 'Private-thread ticket action: ' + action + ' (' + ticket.status + ' → ' + nextStatus + ').',
    }).catch((error) => console.warn('Could not write private-thread ticket audit event:', error));
  }

  if (nextStatus === 'closed' || nextStatus === 'archived') {
    await thread.setArchived(true, 'ResolveX ticket ' + nextStatus);
    if (nextStatus === 'archived') await thread.setLocked(true, 'ResolveX ticket archived');
  }
  const text = action === 'claim'
    ? '✅ Ticket claimed.'
    : action === 'unclaim'
      ? '✅ Your claim has been released.'
      : action === 'pending'
        ? '⏳ Ticket marked as pending.'
        : action === 'resume'
          ? '▶️ Ticket resumed.'
          : action === 'close'
            ? '🔒 Ticket closed and archived. Reopen it with the ticket control or slash command.'
            : action === 'reopen'
              ? '🔓 Ticket reopened.'
              : '🗄️ Ticket archived.';
  if (interaction.isButton()) {
    await interaction.editReply({ content: text, components: [] });
  } else {
    await interaction.editReply(text);
  }
}

export async function handlePrivateThreadTicketButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith('ticket:thread:')) return false;
  const rawAction = interaction.customId.slice('ticket:thread:'.length);
  if (!['claim', 'unclaim', 'pending', 'resume', 'close', 'reopen', 'archive'].includes(rawAction)) {
    await interaction.reply({ content: 'This ticket control is no longer available.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
  try {
    await performThreadAction(interaction, rawAction as PrivateThreadTicketAction);
  } catch (error) {
    await interaction.editReply('❌ ' + (error instanceof Error ? error.message : 'Private-thread ticket action failed.')).catch(() => undefined);
  }
  return true;
}

export async function executePrivateThreadTicketCommand(
  interaction: ChatInputCommandInteraction,
  action: string,
): Promise<boolean> {
  if (interaction.channel?.type !== ChannelType.PrivateThread) return false;
  const allowed: PrivateThreadTicketAction[] = ['claim', 'unclaim', 'pending', 'resume', 'close', 'reopen', 'archive'];
  if (!allowed.includes(action as PrivateThreadTicketAction)) {
    await interaction.editReply('This ticket command is not supported inside private-thread workspaces yet. Use claim, unclaim, pending, resume, close, reopen or archive. No state was changed.');
    return true;
  }
  try {
    await performThreadAction(interaction, action as PrivateThreadTicketAction);
  } catch (error) {
    await interaction.editReply('❌ ' + (error instanceof Error ? error.message : 'Private-thread ticket action failed.'));
  }
  return true;
}

export async function registerInitialPrivateThreadTicket(
  guildId: string,
  thread: ThreadChannel,
  registration: {
    ticketNumber: string;
    departmentId: string;
    tagId: string;
    ownerId: string;
    priority: 'low' | 'normal' | 'high' | 'urgent' | 'critical';
    createdAt: string;
    staffRoleId: string | null;
    ticketTopic: string;
    threadParentChannelId: string;
    subject: string;
  },
): Promise<void> {
  await registerTicket(thread.id, {
    guildId,
    ticketNumber: registration.ticketNumber,
    departmentId: registration.departmentId,
    tagId: registration.tagId,
    ownerId: registration.ownerId,
    priority: registration.priority,
    createdAt: registration.createdAt,
    participantIds: [registration.ownerId],
    metadata: {
      ticketChannelType: 'private-thread',
      workspaceKind: 'private-thread',
      threadParentChannelId: registration.threadParentChannelId,
      staffRoleId: registration.staffRoleId,
      subject: registration.subject,
      openedAt: registration.createdAt,
      lastActivityAt: registration.createdAt,
      lastCustomerMessageAt: registration.createdAt,
      ticketTopic: registration.ticketTopic,
    },
  }, { id: registration.ownerId, attribution: 'actorKnown', confidence: 'high' });
}
