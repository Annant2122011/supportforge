import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type ThreadChannel,
  type UserSelectMenuInteraction,
} from 'discord.js';

import { getGuildConfig, getTier, isPremiumOrHigher } from './configService';
import type { TicketPriority } from './advancedSettingsService';
import {
  getPersistedTicket,
  getPersistedTicketEventHistory,
  transitionPersistedTicket,
  updatePersistedTicketMetadata,
  type PersistedTicket,
} from './ticketPersistenceService';
import { getField, isTicketTopic, setField, type TicketStatus } from './ticketStateService';
import { projectDurableTicketTopic } from './ticketTopicProjectionService';
import { buildPrivateThreadTicketComponents, refreshPrivateThreadPanel } from './privateThreadTicketService';
import { logTicketEvent } from './auditLogService';
import { archiveTicketChannelSnapshot, archiveTicketMessage, beginTicketButtonDeletion, cancelTicketButtonDeletion } from './ticketArchiveService';
import { applyQueryFixrBranding, queryFixrFooter } from '../interactions/brandPresentation';
import { getThemeColor } from './uiThemeService';

type AuxInteraction = ButtonInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction | ModalSubmitInteraction;
type Note = { id: string; actorId: string; actorName: string; text: string; createdAt: string };
type Context = { guild: Guild; thread: ThreadChannel; ticket: PersistedTicket; topic: string; staffRoleId?: string; staff: boolean };

async function getContext(interaction: AuxInteraction): Promise<Context> {
  const guild = interaction.guild;
  const channel = interaction.channel;
  if (!guild || channel?.type !== ChannelType.PrivateThread) throw new Error('Use this control inside a QueryFixr private ticket thread.');
  const thread = channel as ThreadChannel;
  const ticket = await getPersistedTicket(thread.id);
  if (!ticket || ticket.guildId !== guild.id || ticket.deletedAt || ticket.metadata.workspaceKind !== 'private-thread') {
    throw new Error('This thread is not linked to a live durable private-thread ticket.');
  }
  const topicValue = ticket.metadata.ticketTopic;
  const topic = typeof topicValue === 'string' && isTicketTopic(topicValue)
    ? topicValue
    : projectDurableTicketTopic('', ticket);
  const roleValue = typeof ticket.metadata.staffRoleId === 'string' ? ticket.metadata.staffRoleId : getField(topic, 'staff');
  const staffRoleId = roleValue && roleValue !== 'none' ? roleValue : undefined;
  let staff = Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
  );
  if (!staff && staffRoleId) {
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    staff = Boolean(member?.roles.cache.has(staffRoleId));
  }
  return { guild, thread, ticket, topic, staffRoleId, staff };
}

function requireStaff(context: Context): void {
  if (!context.staff) throw new Error('Only the configured department staff or a server administrator can use this control.');
}

function requireActive(context: Context): void {
  if (context.ticket.status === 'closed' || context.ticket.status === 'archived') throw new Error('Reopen the ticket before changing its assignment, priority or participants.');
}

function notesFor(ticket: PersistedTicket): Note[] {
  if (!Array.isArray(ticket.metadata.internalNotes)) return [];
  return ticket.metadata.internalNotes.filter((item): item is Note => {
    if (!item || typeof item !== 'object') return false;
    const note = item as Partial<Note>;
    return typeof note.id === 'string' && typeof note.actorId === 'string' &&
      typeof note.actorName === 'string' && typeof note.text === 'string' &&
      typeof note.createdAt === 'string';
  });
}

async function requirePremium(guildId: string, label: string): Promise<void> {
  if (!isPremiumOrHigher(await getTier(guildId))) throw new Error(label + ' requires Premium or a higher tier.');
}

async function audit(context: Context, interaction: AuxInteraction, event: string, detail: string): Promise<void> {
  const config = await getGuildConfig(context.guild.id);
  if (!config.supportCategoryId) return;
  await logTicketEvent(context.guild, config.supportCategoryId, {
    ticketNumber: context.ticket.ticketNumber ?? 'unknown',
    ticketChannelId: context.thread.id,
    event,
    actor: interaction.user.tag,
    actorId: interaction.user.id,
    actorName: interaction.user.tag,
    detail,
  });
}

async function updatePanel(context: Context, topic: string): Promise<void> {
  const ticket = await getPersistedTicket(context.thread.id);
  if (ticket) await refreshPrivateThreadPanel(context.thread, ticket, topic);
}

async function setPriority(interaction: AuxInteraction, rawPriority: string): Promise<string> {
  const context = await getContext(interaction);
  requireStaff(context); requireActive(context);
  const values: TicketPriority[] = ['low', 'normal', 'high', 'urgent', 'critical'];
  if (!values.includes(rawPriority as TicketPriority)) throw new Error('Choose a valid ticket priority.');
  const priority = rawPriority as TicketPriority;
  const now = new Date().toISOString();
  const topic = setField(setField(context.topic, 'priority', priority), 'updated_at', now);
  await transitionPersistedTicket(context.thread.id, context.ticket.status, {
    priority,
    metadata: { ticketTopic: topic, lastActivityAt: now },
  }, { id: interaction.user.id, attribution: 'actorKnown', confidence: 'high' }, now);
  await updatePanel(context, topic);
  await audit(context, interaction, 'ticket_priority_changed', 'Priority changed from ' + (context.ticket.priority ?? 'unknown') + ' to ' + priority + '.');
  return '✅ Ticket priority updated to **' + priority + '**.';
}

async function addInternalNote(interaction: AuxInteraction, raw: string): Promise<string> {
  const context = await getContext(interaction);
  requireStaff(context); requireActive(context);
  await requirePremium(context.guild.id, 'Internal notes');
  const text = raw.trim();
  if (!text) throw new Error('Internal note cannot be empty.');
  if (text.length > 4000) throw new Error('Internal notes are limited to 4,000 characters.');
  const now = new Date().toISOString();
  const next = [...notesFor(context.ticket), { id: randomUUID(), actorId: interaction.user.id, actorName: interaction.user.tag, text, createdAt: now }].slice(-100);
  await updatePersistedTicketMetadata(context.thread.id, { metadata: { internalNotes: next, lastStaffActivityAt: now } }, {
    id: interaction.user.id, attribution: 'actorKnown', confidence: 'high',
  });
  await audit(context, interaction, 'ticket_internal_note_added', 'An internal note was saved to Neon metadata and was not posted to the customer thread.');
  return '✅ Internal note saved privately. It was not posted in the customer conversation.';
}

async function historyEmbed(context: Context): Promise<EmbedBuilder> {
  await requirePremium(context.guild.id, 'Ticket history');
  const events = await getPersistedTicketEventHistory(context.thread.id, 100);
  const recent = [...events].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 12);
  const description = recent.length ? recent.map((event) => {
    const instant = Date.parse(event.occurredAt);
    const when = Number.isFinite(instant) ? '<t:' + Math.floor(instant / 1000) + ':R>' : event.occurredAt;
    const changed = Array.isArray(event.payload.changedFields) ? ' · ' + event.payload.changedFields.slice(0, 4).join(', ') : '';
    return when + ' **' + event.type.replace(/[<>]/g, '') + '**' + changed + '\nActor ID: ' + event.actorId;
  }).join('\n\n') : 'No durable ticket events are recorded yet.';
  const notes = notesFor(context.ticket).slice(-4).reverse();
  const theme = getThemeColor((await getGuildConfig(context.guild.id)).theme);
  const embed = applyQueryFixrBranding(
    new EmbedBuilder(),
    'Private Ticket History',
    theme,
  )
    .setTitle('📜 Ticket History · #' + (context.ticket.ticketNumber ?? 'unknown'))
    .setDescription(description.slice(0, 3400))
    .setFooter({ text: queryFixrFooter('Private history', 'Internal notes are staff-only · Ephemeral view') });
  if (notes.length) embed.addFields({
    name: 'Recent internal notes',
    value: notes.map((note) => '**' + note.actorName.slice(0, 80) + '** · ' + note.createdAt + '\n' + note.text.slice(0, 450)).join('\n\n').slice(0, 1000),
  });
  return embed;
}

async function changeParticipant(interaction: AuxInteraction, operation: 'add-user' | 'remove-user', targetId: string): Promise<string> {
  const context = await getContext(interaction);
  requireStaff(context); requireActive(context);
  const target = await context.guild.members.fetch(targetId).catch(() => null);
  if (!target) throw new Error('The selected user is not a member of this server.');
  if (target.user.bot) throw new Error('Bot accounts cannot be added as ticket participants.');
  if (operation === 'remove-user' && targetId === context.ticket.ownerId) throw new Error('The original ticket owner cannot be removed.');
  const participants = new Set(context.ticket.participantIds);
  if (operation === 'add-user' && participants.has(targetId)) return 'That user is already a ticket participant.';
  if (operation === 'remove-user' && !participants.has(targetId)) return 'That user is not a ticket participant.';
  if (operation === 'add-user') participants.add(targetId); else participants.delete(targetId);
  if (context.ticket.ownerId) participants.add(context.ticket.ownerId);
  const wasMember = await context.thread.members.fetch(targetId).then(() => true).catch(() => false);
  const now = new Date().toISOString();
  const ids = [...participants];
  const topic = setField(setField(context.topic, 'users', ids.filter((id) => id !== context.ticket.ownerId).join(',')), 'updated_at', now);
  try {
    if (operation === 'add-user' && !wasMember) await context.thread.members.add(targetId);
    if (operation === 'remove-user' && wasMember) await context.thread.members.remove(targetId);
    await transitionPersistedTicket(context.thread.id, context.ticket.status, {
      participantIds: ids,
      metadata: { ticketTopic: topic, lastActivityAt: now },
    }, { id: interaction.user.id, attribution: 'actorKnown', confidence: 'high' }, now);
    await updatePanel(context, topic);
  } catch (error) {
    if (operation === 'add-user' && !wasMember) await context.thread.members.remove(targetId).catch(() => undefined);
    if (operation === 'remove-user' && wasMember) await context.thread.members.add(targetId).catch(() => undefined);
    throw error;
  }
  await audit(context, interaction, operation === 'add-user' ? 'ticket_participant_added' : 'ticket_participant_removed', (operation === 'add-user' ? 'Added participant ' : 'Removed participant ') + targetId + '.');
  return operation === 'add-user' ? '✅ Added <@' + targetId + '> to this private ticket.' : '✅ Removed <@' + targetId + '> from this private ticket.';
}

async function reassign(interaction: AuxInteraction, targetId: string, reason = ''): Promise<string> {
  const context = await getContext(interaction);
  requireStaff(context); requireActive(context);
  if (context.ticket.status === 'pending') throw new Error('Resume the pending ticket before reassigning it.');
  if (!context.staffRoleId) throw new Error('Configure a department staff role before reassigning tickets.');
  const target = await context.guild.members.fetch(targetId).catch(() => null);
  if (!target || target.user.bot) throw new Error('Choose a real server member in the department staff role.');
  if (!target.roles.cache.has(context.staffRoleId)) throw new Error('The selected user is not in this department’s staff role.');
  const wasMember = await context.thread.members.fetch(targetId).then(() => true).catch(() => false);
  if (!wasMember) await context.thread.members.add(targetId);
  const now = new Date().toISOString();
  let topic = setField(context.topic, 'status', 'claimed');
  topic = setField(topic, 'claimed_by', targetId);
  topic = setField(topic, 'claimed_at', now);
  topic = setField(topic, 'assigned_at', now);
  try {
    await transitionPersistedTicket(context.thread.id, 'claimed', {
      claimedByIds: [targetId],
      metadata: {
        ticketTopic: topic, lastActivityAt: now,
        reassignedBy: interaction.user.id, reassignedAt: now,
        reassignmentReason: reason.trim().slice(0, 500) || null,
      },
    }, { id: interaction.user.id, attribution: 'actorKnown', confidence: 'high' }, now);
    await updatePanel(context, topic);
  } catch (error) {
    if (!wasMember) await context.thread.members.remove(targetId).catch(() => undefined);
    throw error;
  }
  await audit(context, interaction, 'ticket_reassigned', 'Reassigned ticket to ' + targetId + (reason.trim() ? '. Reason: ' + reason.trim().slice(0, 300) : '.'));
  return '✅ Ticket reassigned to <@' + targetId + '> and marked as claimed.';
}

async function archiveBeforeThreadDelete(thread: ThreadChannel): Promise<void> {
  await archiveTicketChannelSnapshot(thread);
  let before: string | undefined;
  let pages = 0;
  while (pages < 1000) {
    const page = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!page.size) return;
    const ordered = [...page.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
    for (const message of ordered) await archiveTicketMessage(message);
    const oldest = ordered[0]?.id;
    if (!oldest || page.size < 100) return;
    if (oldest === before) throw new Error('Ticket archive pagination stopped making progress.');
    before = oldest;
    pages += 1;
  }
  throw new Error('Ticket history exceeds the safe 100,000-message pre-deletion archive bound. Deletion was cancelled.');
}

function deleteRows(threadId: string, userId: string, step: 'confirm1' | 'confirm2'): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('ticket:thread:delete:' + step + ':' + threadId + ':' + userId)
      .setLabel(step === 'confirm1' ? 'Continue' : 'Confirm Delete Ticket').setEmoji(step === 'confirm1' ? '➡️' : '🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket:thread:delete:cancel:' + threadId + ':' + userId).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
  );
}

function deleteEmbed(context: Context, step: 1 | 2): EmbedBuilder {
  return applyQueryFixrBranding(
    new EmbedBuilder(),
    'Destructive Action',
    0xD64545,
  )
    .setTitle(step === 1 ? '⚠️ Delete Private Ticket?' : '🛑 Final Ticket Deletion Confirmation')
    .setDescription(step === 1
      ? 'QueryFixr will first save the channel snapshot and paginate through accessible history into Neon. Continue only if this is the intended ticket.'
      : 'Delete ticket **#' + (context.ticket.ticketNumber ?? 'unknown') + '**? The thread is deleted only after archival. Accidental deletions can be restored through Settings → Repair System → Ticket Deletion Review.')
    .setFooter({ text: queryFixrFooter('Deletion confirmation', 'Bound to this ticket thread and requesting user') });
}

async function deleteConfirm(interaction: ButtonInteraction): Promise<boolean> {
  const parts = interaction.customId.split(':');
  const step = parts[3];
  const threadId = parts[4];
  const actorId = parts[5];
  if (!threadId || !actorId || !['confirm1', 'confirm2', 'cancel'].includes(step ?? '')) {
    await interaction.reply({ content: 'This deletion confirmation is invalid or expired.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return true;
  }
  if (interaction.user.id !== actorId || interaction.channel?.type !== ChannelType.PrivateThread || interaction.channel.id !== threadId) {
    await interaction.reply({ content: 'This confirmation belongs to another user or ticket. Nothing was deleted.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return true;
  }
  if (step === 'cancel') {
    await interaction.update({ content: '✅ Ticket deletion cancelled. No ticket state was changed.', embeds: [], components: [] });
    return true;
  }
  let context: Context;
  try {
    context = await getContext(interaction); requireStaff(context);
  } catch (error) {
    await interaction.reply({ content: '❌ ' + (error instanceof Error ? error.message : 'Deletion was not authorized.'), flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return true;
  }
  if (step === 'confirm1') {
    await interaction.update({ content: '', embeds: [deleteEmbed(context, 2)], components: [deleteRows(threadId, actorId, 'confirm2')] });
    return true;
  }
  await interaction.deferUpdate();
  let intent = false;
  try {
    await archiveBeforeThreadDelete(context.thread);
    await beginTicketButtonDeletion(context.thread, interaction.user.id, interaction.user.tag);
    intent = true;
    await context.thread.delete('QueryFixr ticket Delete button after two confirmations; actor ' + interaction.user.id);
    await interaction.editReply({ content: '✅ Ticket deleted after archival. If accidental, use Settings → Repair System → Ticket Deletion Review.', embeds: [], components: [] }).catch(() => undefined);
  } catch (error) {
    if (intent) await cancelTicketButtonDeletion(context.thread.id).catch(() => undefined);
    await interaction.editReply({ content: '❌ Deletion did not complete. The thread was preserved where possible. ' + (error instanceof Error ? error.message : 'Unknown failure.'), embeds: [], components: [] }).catch(() => undefined);
  }
  return true;
}

export async function handlePrivateThreadAuxButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith('ticket:thread:')) return false;
  const parts = interaction.customId.split(':');
  const action = parts[2] ?? '';
  if (action === 'delete' && ['confirm1', 'confirm2', 'cancel'].includes(parts[3] ?? '')) return deleteConfirm(interaction);
  const threadId = parts[3];
  if (!threadId || interaction.channel?.type !== ChannelType.PrivateThread || interaction.channel.id !== threadId) {
    await interaction.reply({ content: 'This ticket control is stale or belongs to a different thread.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return true;
  }
  if (!['add-user', 'remove-user', 'priority', 'note', 'history', 'reassign', 'delete'].includes(action)) return false;
  if (action === 'note') {
    const modal = new ModalBuilder().setCustomId('ticket:thread:note:submit:' + threadId + ':' + interaction.user.id)
      .setTitle('Private Internal Note')
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('note').setLabel('Internal note (staff only)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000),
      ));
    await interaction.showModal(modal);
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
  try {
    const context = await getContext(interaction);
    requireStaff(context);
    if (action === 'delete') {
      await interaction.editReply({ embeds: [deleteEmbed(context, 1)], components: [deleteRows(threadId, interaction.user.id, 'confirm1')] });
    } else if (action === 'history') {
      await interaction.editReply({ embeds: [await historyEmbed(context)], components: [] });
    } else if (action === 'priority') {
      await interaction.editReply({
        content: 'Choose the new ticket priority.',
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder().setCustomId('ticket:thread:priority:select:' + threadId + ':' + interaction.user.id)
            .setPlaceholder('Select priority').addOptions(
              { label: 'Low', value: 'low', emoji: '🟢' },
              { label: 'Normal', value: 'normal', emoji: '🟡' },
              { label: 'High', value: 'high', emoji: '🟠' },
              { label: 'Urgent', value: 'urgent', emoji: '🔴' },
              { label: 'Critical', value: 'critical', emoji: '🟣' },
            ),
        )],
      });
    } else {
      const placeholder = action === 'add-user' ? 'Select a user to add'
        : action === 'remove-user' ? 'Select a ticket participant to remove'
          : 'Select a member of the department staff role';
      await interaction.editReply({
        content: placeholder,
        components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
          new UserSelectMenuBuilder().setCustomId('ticket:thread:' + action + ':select:' + threadId + ':' + interaction.user.id)
            .setPlaceholder('Choose a server member').setMinValues(1).setMaxValues(1),
        )],
      });
    }
  } catch (error) {
    await interaction.editReply({ content: '❌ ' + (error instanceof Error ? error.message : 'Ticket control failed.'), components: [] }).catch(() => undefined);
  }
  return true;
}

export async function handlePrivateThreadAuxComponent(
  interaction: StringSelectMenuInteraction | UserSelectMenuInteraction | ModalSubmitInteraction,
): Promise<boolean> {
  if (!interaction.customId.startsWith('ticket:thread:')) return false;
  const parts = interaction.customId.split(':');
  const action = parts[2] ?? '';
  const operation = parts[3] ?? '';
  const threadId = parts[4];
  const actorId = parts[5];
  if (!threadId || !actorId || interaction.user.id !== actorId || interaction.channel?.type !== ChannelType.PrivateThread || interaction.channel.id !== threadId) {
    await interaction.reply({ content: 'This ticket control has expired or belongs to another user or thread.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return true;
  }
  if (interaction.isModalSubmit()) {
    if (action !== 'note' || operation !== 'submit') {
      await interaction.reply({ content: 'This ticket modal is not supported.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
    try {
      await interaction.editReply(await addInternalNote(interaction, interaction.fields.getTextInputValue('note')));
    } catch (error) {
      await interaction.editReply('❌ ' + (error instanceof Error ? error.message : 'Could not save internal note.')).catch(() => undefined);
    }
    return true;
  }
  if (interaction.isStringSelectMenu()) {
    if (action !== 'priority' || operation !== 'select') {
      await interaction.reply({ content: 'This selection menu is not supported.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return true;
    }
    await interaction.deferUpdate().catch(() => undefined);
    try {
      await interaction.editReply({ content: await setPriority(interaction, interaction.values[0] ?? ''), components: [] });
    } catch (error) {
      await interaction.editReply({ content: '❌ ' + (error instanceof Error ? error.message : 'Could not update priority.'), components: [] }).catch(() => undefined);
    }
    return true;
  }
  if (interaction.isUserSelectMenu()) {
    if (operation !== 'select' || !['add-user', 'remove-user', 'reassign'].includes(action)) {
      await interaction.reply({ content: 'This user selection is not supported.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return true;
    }
    await interaction.deferUpdate().catch(() => undefined);
    try {
      const userId = interaction.values[0];
      const response = action === 'reassign'
        ? await reassign(interaction, userId)
        : await changeParticipant(interaction, action as 'add-user' | 'remove-user', userId);
      await interaction.editReply({ content: response, components: [] });
    } catch (error) {
      await interaction.editReply({ content: '❌ ' + (error instanceof Error ? error.message : 'Could not update ticket access.'), components: [] }).catch(() => undefined);
    }
    return true;
  }
  return true;
}

export async function executePrivateThreadAuxCommand(interaction: ChatInputCommandInteraction, action: string): Promise<boolean> {
  if (interaction.channel?.type !== ChannelType.PrivateThread) return false;
  try {
    if (action === 'priority') {
      await interaction.editReply(await setPriority(interaction, interaction.options.getString('level', true)));
      return true;
    }
    if (action === 'note') {
      await interaction.editReply(await addInternalNote(interaction, interaction.options.getString('text', true)));
      return true;
    }
    if (action === 'history') {
      const context = await getContext(interaction); requireStaff(context);
      await interaction.editReply({ embeds: [await historyEmbed(context)] });
      return true;
    }
    if (action === 'add-user' || action === 'remove-user') {
      await interaction.editReply(await changeParticipant(interaction, action, interaction.options.getUser('user', true).id));
      return true;
    }
    if (action === 'reassign') {
      await interaction.editReply(await reassign(interaction, interaction.options.getUser('staff', true).id, interaction.options.getString('reason') ?? ''));
      return true;
    }
    if (action === 'delete') {
      const context = await getContext(interaction); requireStaff(context);
      await interaction.editReply({ embeds: [deleteEmbed(context, 1)], components: [deleteRows(context.thread.id, interaction.user.id, 'confirm1')] });
      return true;
    }
    return false;
  } catch (error) {
    await interaction.editReply('❌ ' + (error instanceof Error ? error.message : 'Private-thread ticket control failed.'));
    return true;
  }
}
