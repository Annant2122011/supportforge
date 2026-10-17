import type { EventActor } from '../core/events/domainEvents';
import type { TicketMetadataUpdates } from '../repositories/ticketRepository';
import { buildTicketVisibilityPlan } from '../core/domain/ticketPermissionPlan';

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import {
  getGuildConfig,
  getTier,
  isPremiumOrHigher,
} from '../services/configService';

import { getAdvancedSettings, type TicketPriority } from '../services/advancedSettingsService';
import { projectDurableTicketTopic } from '../services/ticketTopicProjectionService';
import { getThemeColor } from '../services/uiThemeService';

import {
  getOrCreateAuditChannel,
  getTicketAuditHistory,
  logTicketEvent,
} from '../services/auditLogService';

import {
  getField,
  getTicketStatus,
  removeField,
  setField,
} from '../services/ticketStateService';

import {
  getTicketChannelName,
  queueTicketChannelRename,
  refreshTicketPanel,
  moveTicketPanelToBottom,
} from '../services/ticketPanelService';
import {
  endTicketVoiceMode,
  syncTicketVoiceParticipants,
} from '../services/voiceModeService';

import {
  getPersistedTicket,
  getPersistedTicketPriority,
  getPersistedTicketStatus,
  transitionPersistedTicket,
  setPersistedTicketStatus,
  updatePersistedTicketMetadata,
} from '../services/ticketPersistenceService';

import { setChannelPermissionOverwrite, setChannelTopic, setChannelProperties, type ChannelPermissionOverwrite } from '../services/discordChannelService';
import {
  executeTicketLifecycleCommand,
  executeTicketRoutingCommand,
  executeTicketVoiceCommand,
  executeTicketReportCommand,
  showTicketCreationModalFromCommand,
} from './ticketInteractions';

import {
  ensureArchiveCategory,
  moveTicketToCategory,
} from '../services/ticketStorageService';

const PRIORITIES = new Set([
  'low',
  'normal',
  'high',
  'urgent',
  'critical',
]);

async function getTicketContext(
  interaction: ChatInputCommandInteraction,
) {
  const channel = interaction.channel;

  if (
    !channel ||
    channel.type !== ChannelType.GuildText
  ) {
    throw new Error(
      'This command must be used in a text ticket channel.',
    );
  }

  const rawTopic = channel.topic ?? '';
  const persisted = await getPersistedTicket(channel.id);

  /*
   * The durable record owns metadata. A missing row allows legacy recovery,
   * but database failures are not swallowed and cannot silently use stale data.
   */
  const topic = persisted
    ? projectDurableTicketTopic(rawTopic, persisted)
    : rawTopic;

  if (
    !topic.startsWith('supportforge:ticket')
  ) {
    throw new Error(
      'This channel is not a SupportForge ticket.',
    );
  }

  const guild = interaction.guild;

  if (!guild) {
    throw new Error(
      'This command can only be used inside a server.',
    );
  }

  const config = await getGuildConfig(
    guild.id,
  );

  const member = await guild.members.fetch(
    interaction.user.id,
  );

  const staffRoleId = getField(
    topic,
    'staff',
  );

  const isStaff = Boolean(
    staffRoleId &&
      staffRoleId !== 'none' &&
      member.roles.cache.has(staffRoleId),
  );

  return {
    guild,
    channel,
    topic,
    config,
    isStaff,
    isAdmin: Boolean(
      interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator,
      ) ||
      interaction.memberPermissions?.has(
        PermissionFlagsBits.ManageGuild,
      ),
    ),
    isAuthorized:
      isStaff ||
      Boolean(
        interaction.memberPermissions?.has(
          PermissionFlagsBits.Administrator,
        ) ||
        interaction.memberPermissions?.has(
          PermissionFlagsBits.ManageGuild,
        ),
      ),
    ticketNumber:
      getField(topic, 'number') ??
      'Unknown',
    ownerId: getField(
      topic,
      'owner',
    ),
    claimedBy: getField(
      topic,
      'claimed_by',
    ),
    claimedByIds: (getField(topic, 'claimed_by') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    assignedAt: getField(
      topic,
      'assigned_at',
    ),
    previousAssignee: getField(
      topic,
      'previous_assignee',
    ),
    status:
      (await getPersistedTicketStatus(channel.id)) ??
      getTicketStatus(topic),
  };
}

async function audit(
  interaction: ChatInputCommandInteraction,
  context: Awaited<
    ReturnType<typeof getTicketContext>
  >,
  event: string,
  detail?: string,
): Promise<void> {
  if (!context.config.supportCategoryId) {
    return;
  }

  await logTicketEvent(
    context.guild,
    context.config.supportCategoryId,
    {
      ticketNumber:
        context.ticketNumber,
      ticketChannelId: context.channel.id,
      event,
      actor:
        interaction.user.tag,
      detail,
    },
  );
}

async function syncCommandTicketVisibility(
  context: Awaited<ReturnType<typeof getTicketContext>>,
  oldTopic: string,
  newTopic: string,
): Promise<void> {
  const ownerId = getField(newTopic, 'owner');
  if (!ownerId) {
    throw new Error('Cannot reconcile SupportForge ticket visibility without an owner ID.');
  }

  const staffRoleId = getField(newTopic, 'staff');
  const oldClaimants = (getField(oldTopic, 'claimed_by') ?? '')
    .split(',').map((id) => id.trim()).filter(Boolean);
  const newClaimants = (getField(newTopic, 'claimed_by') ?? '')
    .split(',').map((id) => id.trim()).filter(Boolean);
  const users = (getField(newTopic, 'users') ?? '')
    .split(',').map((id) => id.trim()).filter(Boolean);
  const status = getTicketStatus(newTopic);
  const existing = [...context.channel.permissionOverwrites.cache.values()].map((overwrite) => ({
    id: overwrite.id,
    kind: overwrite.type === 0 ? 'role' as const : 'member' as const,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  }));
  const roleIds = new Set<string>([
    ...context.guild.roles.cache.keys(),
    ...existing.filter((overwrite) => overwrite.kind === 'role').map((overwrite) => overwrite.id),
  ]);
  const plan = buildTicketVisibilityPlan({
    existing,
    roleIds,
    staffRoleId,
    ownerId,
    userIds: users,
    claimedModeratorIds: status === 'claimed' ? newClaimants : [],
    formerClaimantIds: oldClaimants,
    mode: status === 'claimed' ? 'claimed' : 'unclaimed',
  });

  const properties: {
    topic?: string;
    name?: string;
    parentId?: string;
    permissionOverwrites?: ChannelPermissionOverwrite[];
  } = {};
  if ((context.channel.topic ?? '') !== newTopic) properties.topic = newTopic;
  const desiredStatus = getTicketStatus(newTopic);
  if (desiredStatus === 'archived') {
    const archiveCategory = await ensureArchiveCategory(context.guild);
    if (context.channel.parentId !== archiveCategory.id) {
      properties.parentId = archiveCategory.id;
    }
  }

  const ticketNumber = getField(newTopic, 'number');
  if (ticketNumber) {
    const desiredName = getTicketChannelName(
      ticketNumber,
      status,
      (getField(newTopic, 'priority') ?? 'normal') as 'low' | 'normal' | 'high' | 'urgent' | 'critical',
    );
    if (context.channel.name !== desiredName) properties.name = desiredName;
  }

  if (plan.changed) {
    properties.permissionOverwrites = plan.overwrites.map((overwrite) => ({
      id: overwrite.id,
      allow: [BigInt(overwrite.allow)],
      deny: [BigInt(overwrite.deny)],
    }));
    for (const overwrite of plan.overwrites) {
      if (overwrite.kind === 'role') roleIds.add(overwrite.id);
    }
  }

  if (!Object.keys(properties).length) return;

  await setChannelProperties(
    context.channel.id,
    properties,
    roleIds,
    'Synchronize SupportForge ticket topic, channel name, and visibility in one PATCH',
    { deferLongRateLimit: false },
  );
  if (properties.topic !== undefined) context.channel.topic = properties.topic;
  if (properties.name !== undefined) context.channel.name = properties.name;
}

async function saveTopic(
  context: Awaited<ReturnType<typeof getTicketContext>>,
  requestedTopic: string,
  actor: EventActor = {
    id: 'supportforge-system',
    attribution: 'actorUnknown',
    confidence: 'none',
  },
): Promise<void> {
  const oldTopic = context.topic;
  const persisted = await getPersistedTicket(context.channel.id);
  if (!persisted || persisted.deletedAt) {
    throw new Error('Cannot update a SupportForge ticket without an active durable ticket record.');
  }

  let topic = requestedTopic;
  const persistedPriority = persisted.priority ?? await getPersistedTicketPriority(context.channel.id);
  if (persistedPriority) topic = setField(topic, 'priority', persistedPriority);

  const now = new Date().toISOString();
  topic = setField(topic, 'updated_at', now);
  const status = getTicketStatus(topic);
  const ownerId = getField(topic, 'owner') ?? persisted.ownerId ?? undefined;
  const users = (getField(topic, 'users') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const claimedByIds = (getField(topic, 'claimed_by') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const participantIds = [...new Set([...(ownerId ? [ownerId] : []), ...users])];

  const updates: TicketMetadataUpdates = {};
  const departmentId = getField(topic, 'department') ?? null;
  const tagId = getField(topic, 'tag') ?? getField(topic, 'tags') ?? null;
  const nextPriority = (getField(topic, 'priority') ?? 'normal') as TicketPriority;
  if (persisted.departmentId !== departmentId) updates.departmentId = departmentId;
  if (persisted.tagId !== tagId) updates.tagId = tagId;
  if (persisted.ownerId !== (ownerId ?? null)) updates.ownerId = ownerId ?? null;
  if (persisted.priority !== nextPriority) updates.priority = nextPriority;
  if (JSON.stringify(persisted.claimedByIds) !== JSON.stringify(claimedByIds)) {
    updates.claimedByIds = claimedByIds;
  }
  if (JSON.stringify(persisted.participantIds) !== JSON.stringify(participantIds)) {
    updates.participantIds = participantIds;
  }

  const metadataPatch: Record<string, unknown> = {
    lastActivityAt: now,
    lastStaffActivityAt: now,
  };
  if (status === 'pending' && persisted.status !== 'pending') {
    metadataPatch.pendingSince = getField(topic, 'pending_since') ?? now;
  } else if (persisted.status === 'pending' && status !== 'pending') {
    metadataPatch.pendingSince = null;
  }
  if (status === 'claimed') {
    metadataPatch.claimedAt = getField(topic, 'claimed_at') ?? now;
    metadataPatch.assignedAt = getField(topic, 'assigned_at') ?? now;
  }
  if (status === 'closed') metadataPatch.closedAt = getField(topic, 'closed_at') ?? now;
  if (status === 'archived') metadataPatch.archivedAt = getField(topic, 'archived_at') ?? now;
  if (status === 'reopened') {
    metadataPatch.reopenedAt = getField(topic, 'reopened_at') ?? now;
    metadataPatch.closedAt = null;
    metadataPatch.archivedAt = null;
    metadataPatch.transcriptId = null;
    metadataPatch.transcriptDestinationId = null;
    metadataPatch.pendingSince = null;
  }
  updates.metadata = metadataPatch;

  /*
   * Durable ticket status, metadata and corresponding events/outbox intents
   * commit before Discord is changed. A failed channel mutation is recoverable
   * by the outbox worker, which reads the latest state and reconciles it.
   */
  await transitionPersistedTicket(
    context.channel.id,
    status,
    updates,
    actor,
    now,
  );

  // Voice cleanup happens only after the durable lifecycle transition. If
  // Discord refuses deletion, retain the voice pointer for later repair.
  if (getField(topic, 'voice_channel_id') && status !== 'claimed') {
    try {
      topic = await endTicketVoiceMode(
        context.guild,
        context.channel,
        topic,
        status,
        'SupportForge voice mode ended by ticket command transition',
        { deferTicketTopicUpdate: true, queueRename: false },
      );
      await updatePersistedTicketMetadata(
        context.channel.id,
        {
          metadata: {
            voiceChannelId: null,
            voiceChannelName: null,
            voiceStartedAt: null,
            voiceStartedBy: null,
          },
        },
        actor,
      );
      topic = setField(topic, 'updated_at', now);
    } catch (error) {
      console.warn(
        'SupportForge ticket state committed, but private voice cleanup is pending:',
        error,
      );
    }
  }

  try {
    await syncCommandTicketVisibility(context, oldTopic, topic);
  } catch (error) {
    console.warn(
      'SupportForge ticket state is durable; Discord topic/name/permissions will be reconciled by the outbox:',
      error,
    );
  }

  if (getField(topic, 'voice_channel_id') && status === 'claimed') {
    await syncTicketVoiceParticipants(context.guild, topic);
  }

  await refreshTicketPanel(context.channel, topic);
}

export async function executeTicketCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // Ticket creation opens its own modal before deferring the interaction.
  // The modal submit then uses the same durable creation pipeline as the panel button.
  if (interaction.options.getSubcommand() === 'create') {
    await showTicketCreationModalFromCommand(interaction);
    return;
  }

  /*
   * A slash-command interaction must be acknowledged
   * immediately. Do not perform configuration/database
   * work before this point.
   */
  if (
    !interaction.deferred &&
    !interaction.replied
  ) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    const context =
      await getTicketContext(
        interaction,
      );

    const subcommand =
      interaction.options.getSubcommand();

    const tier = await getTier(
      interaction.guild!.id,
    );

    /*
     * Only configured department staff or
     * administrators can manage tickets.
     */
    if (!context.isAuthorized && !(subcommand === 'close' && context.ownerId === interaction.user.id)) {
      await interaction.editReply(
        '❌ Only the configured department staff or an administrator can use ticket management commands.',
      );

      return;
    }

    /*
     * Premium-only features.
     */
    if (
      [
        'priority',
        'note',
        'history',
      ].includes(subcommand) &&
      !isPremiumOrHigher(tier)
    ) {
      await interaction.editReply(
        '🔒 This feature is available in Premium/Pro demo mode. Run `/supportforge premium toggle-demo` as an administrator to preview it.',
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /* Panel-only workflows exposed through slash commands               */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'close' || subcommand === 'reopen') {
      // Execute the same lifecycle service used by the panel button directly.
      // A slash command must remain a real fallback, not just display another button.
      await executeTicketLifecycleCommand(interaction, subcommand);
      return;
    }

    if (subcommand === 'department' || subcommand === 'tag') {
      await executeTicketRoutingCommand(interaction, subcommand);
      return;
    }

    if (subcommand === 'voice') {
      const voiceAction = interaction.options.getString('action', true) as 'start' | 'end' | 'join';
      await executeTicketVoiceCommand(interaction, voiceAction);
      return;
    }

    if (subcommand === 'report') {
      await executeTicketReportCommand(interaction);
      return;
    }

    if (subcommand === 'move-panel') {
      await moveTicketPanelToBottom(context.channel);
      await interaction.editReply('Ticket controls have been moved to the bottom of this channel.');
      await audit(interaction, context, 'Ticket panel moved', 'Moved ticket controls to the bottom through slash command.');
      return;
    }

    /* ------------------------------------------------------------------ */
    /* Archive                                                            */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'archive') {
      if (context.status !== 'closed') {
        await interaction.editReply(
          `❌ Ticket #${context.ticketNumber} must be **closed** before it can be archived.`,
        );
        return;
      }

      const transitionAt = new Date().toISOString();
      const topic = setField(
        setField(context.topic, 'status', 'archived'),
        'archived_at',
        transitionAt,
      );

      await saveTopic(context, topic, {
        id: interaction.user.id,
        attribution: 'actorKnown',
        confidence: 'high',
      });

      await interaction.editReply(
        `🗄️ Ticket #${context.ticketNumber} has been archived and moved to the Archive section.`,
      );

      await audit(
        interaction,
        context,
        'Ticket archived',
        'Ticket moved to the Archive category.',
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /* Panel controls                                                     */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'panel') {
      const ticketNumber = context.ticketNumber;
      const messageId = getField(context.topic, 'message');

      let panelMessage =
        messageId
          ? context.channel.messages.cache.get(messageId) ??
            await context.channel.messages.fetch(messageId).catch(() => undefined)
          : undefined;

      if (!panelMessage) {
        const recent = await context.channel.messages.fetch({ limit: 100 });
        panelMessage = recent.find(
          (message) =>
            message.author.id === interaction.client.user?.id &&
            message.embeds.some(
              (embed) =>
                embed.title ===
                `🎫 SupportForge Ticket #${ticketNumber}`,
            ),
        );
      }

      const rows = [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('ticket:panel:move-bottom')
            .setLabel('Move Panel to Bottom')
            .setEmoji('⬇️')
            .setStyle(ButtonStyle.Secondary),
          ...(panelMessage
            ? [
                new ButtonBuilder()
                  .setLabel('Locate Panel')
                  .setEmoji('📍')
                  .setStyle(ButtonStyle.Link)
                  .setURL(panelMessage.url),
              ]
            : []),
        ),
      ];

      await interaction.editReply({
        content:
          '🎛️ **SupportForge Panel Controls**\n\n' +
          'Move the ticket controls to the bottom of the conversation when needed. ' +
          'Automatic activity-based repositioning is re-armed after each move, so the panel can be surfaced repeatedly as the conversation grows.',
        components: rows,
      });

      return;
    }

    /* ------------------------------------------------------------------ */
    /* Claim                                                              */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'claim') {
      if (
        context.status === 'closed' ||
        context.status === 'archived'
      ) {
        await interaction.editReply(
          `❌ Ticket #${context.ticketNumber} is **${context.status}** and cannot be claimed.`,
        );
        return;
      }

      if (context.status === 'pending') {
        await interaction.editReply(
          `⏳ Ticket #${context.ticketNumber} is currently **pending**. Resume it before claiming.`,
        );
        return;
      }

      const claimedIds = context.claimedByIds;

      if (claimedIds.includes(interaction.user.id)) {
        await interaction.editReply(
          `ℹ️ You already have ticket #${context.ticketNumber} claimed.`,
        );
        return;
      }

      if (context.status === 'claimed') {
        const settings = await getAdvancedSettings(interaction.guild!.id);
        if (claimedIds.length >= settings.ticketDefaults.maxClaimedModerators) {
          await interaction.editReply(
            `❌ Ticket #${context.ticketNumber} already has the maximum of **${settings.ticketDefaults.maxClaimedModerators}** moderators assisting.`,
          );
          return;
        }
      }

      let topic = setField(
        context.topic,
        'status',
        'claimed',
      );

      topic = setField(
        topic,
        'claimed_by',
        [...claimedIds, interaction.user.id].join(','),
      );

      topic = setField(
        topic,
        'claimed_at',
        new Date().toISOString(),
      );

      topic = setField(
        topic,
        'assigned_at',
        new Date().toISOString(),
      );

      topic = removeField(
        topic,
        'pending_since',
      );

      topic = removeField(
        topic,
        'previous_assignee',
      );

      await saveTopic(context, topic, {
        id: interaction.user.id,
        attribution: 'actorKnown',
        confidence: 'high',
      });

      await context.channel.send(
        `🎯 ${interaction.user} claimed ticket #${context.ticketNumber}.`,
      );

      await audit(
        interaction,
        context,
        `Ticket claimed by ${interaction.user.tag}`,
      );

      await interaction.editReply(
        `✅ Ticket #${context.ticketNumber} is now **claimed by you**.`,
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /* Unclaim                                                            */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'unclaim') {
      if (context.status !== 'claimed') {
        await interaction.editReply(
          `ℹ️ Ticket #${context.ticketNumber} is not currently claimed.`,
        );
        return;
      }

      const claimedIds = context.claimedByIds;

      if (
        !claimedIds.includes(interaction.user.id) &&
        !context.isAdmin
      ) {
        await interaction.editReply(
          '❌ Only an assisting moderator or an administrator can unclaim this ticket.',
        );
        return;
      }

      const remaining = context.isAdmin && !claimedIds.includes(interaction.user.id)
        ? []
        : claimedIds.filter((id) => id !== interaction.user.id);

      let topic: string;

      if (remaining.length) {
        topic = setField(context.topic, 'claimed_by', remaining.join(','));
        topic = setField(topic, 'status', 'claimed');
      } else {
        topic = setField(context.topic, 'status', 'open');
        topic = removeField(topic, 'claimed_by');
        topic = removeField(topic, 'claimed_at');
        topic = removeField(topic, 'assigned_at');
        topic = removeField(topic, 'previous_assignee');
      }

      await saveTopic(context, topic, {
        id: interaction.user.id,
        attribution: 'actorKnown',
        confidence: 'high',
      });

      await context.channel.send(
        remaining.length
          ? `↩️ ${interaction.user} left ticket #${context.ticketNumber}. Other assigned moderators remain on it.`
          : `↩️ Ticket #${context.ticketNumber} was fully unclaimed by ${interaction.user}.`,
      );

      await audit(
        interaction,
        context,
        remaining.length
          ? `Moderator left ticket #${context.ticketNumber}`
          : `Ticket fully unclaimed by ${interaction.user.tag}`,
      );

      await interaction.editReply(
        remaining.length
          ? `✅ You left ticket #${context.ticketNumber}. It remains claimed by the other assisting moderator(s).`
          : `✅ Ticket #${context.ticketNumber} is now **open**.`,
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /* Reassign                                                           */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'reassign') {
      if (
        context.status === 'closed' ||
        context.status === 'archived'
      ) {
        await interaction.editReply(
          `❌ Ticket #${context.ticketNumber} is **${context.status}** and cannot be reassigned.`,
        );

        return;
      }

      if (context.status === 'pending') {
        await interaction.editReply(
          `⏳ Ticket #${context.ticketNumber} is currently **pending**. Resume it before reassigning.`,
        );

        return;
      }

      const target =
        interaction.options.getUser(
          'staff',
          true,
        );

      const targetMember =
        await context.guild.members.fetch(
          target.id,
        );

      const staffRoleId = getField(
        context.topic,
        'staff',
      );

      if (
        !staffRoleId ||
        staffRoleId === 'none'
      ) {
        await interaction.editReply(
          '❌ This ticket does not have a configured staff role, so it cannot be safely reassigned.',
        );

        return;
      }

      if (
        !targetMember.roles.cache.has(
          staffRoleId,
        )
      ) {
        await interaction.editReply(
          `❌ ${target} is not a member of this ticket department's staff role.`,
        );

        return;
      }

      if (
        context.claimedBy ===
        target.id
      ) {
        await interaction.editReply(
          `ℹ️ Ticket #${context.ticketNumber} is already assigned to ${target}.`,
        );

        return;
      }

      const previousAssignee =
        context.claimedBy;

      const now =
        new Date().toISOString();

      let topic = setField(
        context.topic,
        'status',
        'claimed',
      );

      topic = setField(
        topic,
        'claimed_by',
        target.id,
      );

      topic = setField(
        topic,
        'claimed_at',
        now,
      );

      topic = setField(
        topic,
        'assigned_at',
        now,
      );

      if (previousAssignee) {
        topic = setField(
          topic,
          'previous_assignee',
          previousAssignee,
        );
      } else {
        topic = removeField(
          topic,
          'previous_assignee',
        );
      }

      topic = removeField(
        topic,
        'pending_since',
      );

      await saveTopic(context, topic, {
        id: interaction.user.id,
        attribution: 'actorKnown',
        confidence: 'high',
      });

      const reason =
        interaction.options
          .getString(
            'reason',
          )
          ?.trim();

      const previousText =
        previousAssignee
          ? `<@${previousAssignee}>`
          : 'unassigned';

      const reasonText =
        reason
          ? `\n📝 Reason: ${reason}`
          : '';

      await context.channel.send(
        `🔄 Ticket #${context.ticketNumber} was reassigned from ${previousText} to ${target} by ${interaction.user}.${reasonText}`,
      );

      await audit(
        interaction,
        context,
        `Ticket reassigned from ${
          previousAssignee
            ? `<@${previousAssignee}>`
            : 'unassigned'
        } to ${target.tag}`,
        reason
          ? `Reason: ${reason}`
          : undefined,
      );

      await interaction.editReply(
        `✅ Ticket #${context.ticketNumber} has been reassigned to ${target}.`,
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /* Pending                                                            */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'pending') {
      if (
        context.status === 'closed' ||
        context.status === 'archived'
      ) {
        await interaction.editReply(
          `❌ Ticket #${context.ticketNumber} is **${context.status}** and cannot be marked pending.`,
        );
        return;
      }

      if (context.status === 'pending') {
        await interaction.editReply(
          `ℹ️ Ticket #${context.ticketNumber} is already pending.`,
        );
        return;
      }

      let topic = setField(
        context.topic,
        'status',
        'pending',
      );

      topic = setField(
        topic,
        'pending_since',
        new Date().toISOString(),
      );

      topic = removeField(
        topic,
        'claimed_by',
      );

      topic = removeField(
        topic,
        'claimed_at',
      );

      await saveTopic(context, topic, {
        id: interaction.user.id,
        attribution: 'actorKnown',
        confidence: 'high',
      });

      await context.channel.send(
        `⏳ Ticket #${context.ticketNumber} has been marked **pending** by ${interaction.user}.`,
      );

      await audit(
        interaction,
        context,
        `Ticket marked pending by ${interaction.user.tag}`,
      );

      await interaction.editReply(
        `⏳ Ticket #${context.ticketNumber} is now **pending**.`,
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /* Resume                                                             */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'resume') {
      if (context.status !== 'pending') {
        await interaction.editReply(
          `ℹ️ Ticket #${context.ticketNumber} is not pending.`,
        );
        return;
      }

      let topic = setField(
        context.topic,
        'status',
        'open',
      );

      topic = removeField(
        topic,
        'pending_since',
      );

      await saveTopic(context, topic, {
        id: interaction.user.id,
        attribution: 'actorKnown',
        confidence: 'high',
      });

      await context.channel.send(
        `▶️ Ticket #${context.ticketNumber} has been resumed by ${interaction.user}.`,
      );

      await audit(
        interaction,
        context,
        `Ticket resumed by ${interaction.user.tag}`,
      );

      await interaction.editReply(
        `✅ Ticket #${context.ticketNumber} is now **open** again.`,
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /* Add/remove user                                                    */
    /* ------------------------------------------------------------------ */

    if (
      subcommand === 'add-user' ||
      subcommand === 'remove-user'
    ) {
      const target =
        interaction.options.getUser(
          'user',
          true,
        );

      if (
        subcommand === 'remove-user' &&
        target.id === context.ownerId
      ) {
        await interaction.editReply(
          '❌ You cannot remove the ticket owner.',
        );
        return;
      }

      const users =
        new Set(
          (
            getField(
              context.topic,
              'users',
            ) ?? ''
          )
            .split(',')
            .filter(Boolean),
        );

      if (subcommand === 'add-user') {
        users.add(target.id);
      } else {
        users.delete(target.id);
      }

      const topic =
        setField(
          context.topic,
          'users',
          [...users].join(','),
        );

      await saveTopic(context, topic, {
        id: interaction.user.id,
        attribution: 'actorKnown',
        confidence: 'high',
      });

      await context.channel.send(
        subcommand === 'add-user'
          ? '➕ ' + target.toString() + ' was added by ' + interaction.user.toString() + '.'
          : '➖ ' + target.toString() + ' was removed by ' + interaction.user.toString() + '.',
      );

      await audit(
        interaction,
        context,
        `${
          subcommand ===
          'add-user'
            ? 'User added'
            : 'User removed'
        }: ${target.tag}`,
      );

      await interaction.editReply(
        subcommand === 'add-user'
          ? `✅ ${target} now has access to ticket #${context.ticketNumber}.`
          : `✅ ${target} was removed from ticket #${context.ticketNumber}.`,
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /* Priority                                                           */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'priority') {
      const level =
        interaction.options.getString(
          'level',
          true,
        );

      if (!PRIORITIES.has(level)) {
        await interaction.editReply(
          '❌ Invalid priority.',
        );
        return;
      }

      const priority = level as TicketPriority;
      const transitionAt = new Date().toISOString();
      const topic = setField(
        setField(context.topic, 'priority', priority),
        'updated_at',
        transitionAt,
      );

      /*
       * Priority, audit event and outbox intent commit together. The outbox
       * batches the channel name/topic reconciliation and observes Discord's
       * Retry-After instead of launching a second rename retry queue.
       */
      await transitionPersistedTicket(
        context.channel.id,
        context.status,
        {
          priority,
          metadata: {
            lastActivityAt: transitionAt,
            lastStaffActivityAt: transitionAt,
          },
        },
        {
          id: interaction.user.id,
          attribution: 'actorKnown',
          confidence: 'high',
        },
        transitionAt,
      );

      context.channel.topic = topic;
      await refreshTicketPanel(context.channel, topic);

      await audit(
        interaction,
        context,
        `Priority changed to ${level}`,
      );

      await interaction.editReply(
        `✅ Ticket #${context.ticketNumber} priority is now **${level}**.`,
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /* Internal note                                                      */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'note') {
      const text =
        interaction.options
          .getString(
            'text',
            true,
          )
          .trim();

      const auditChannel =
        await getOrCreateAuditChannel(
          context.guild,
          context.config.supportCategoryId!,
        );

      await auditChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(getThemeColor(context.config.theme))
            .setTitle(
              `🔒 Internal note • Ticket #${context.ticketNumber}`,
            )
            .setDescription(text)
            .setFooter({
              text: `Added by ${interaction.user.tag}`,
            })
            .setTimestamp(),
        ],
      });

      await interaction.editReply(
        '✅ Internal note recorded in the staff-only audit log.',
      );

      await audit(
        interaction,
        context,
        'Internal note added',
        'Staff internal note recorded in the audit history.',
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /* History                                                             */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'history') {
      const events = await getTicketAuditHistory(
        context.guild.id,
        context.ticketNumber,
        context.channel.id,
      );

      const recent = events.slice(-20).reverse();

      if (!recent.length) {
        await interaction.editReply(
          `📜 **Recent history for ticket #${context.ticketNumber}**

No audit events have been recorded for this ticket yet.`,
        );
        return;
      }

      const lines: string[] = [];
      for (const event of recent) {
        const timestampValue = new Date(event.timestamp).getTime();
        const timestamp = Number.isFinite(timestampValue)
          ? Math.floor(timestampValue / 1000)
          : Math.floor(Date.now() / 1000);
        const detail = event.detail?.trim();

        const line =
          '• <t:' +
          timestamp +
          ':f> • **' +
          event.action
            .split('_')
            .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
            .join(' ') +
          '** • ' +
          (event.actorName || 'Unknown') +
          (detail ? ' • ' + detail.slice(0, 180) : '');

        const projected = lines.length
          ? lines.join('\n') + '\n' + line
          : line;

        if (projected.length > 1_850) {
          break;
        }

        lines.push(line);
      }

      const omitted = recent.length - lines.length;
      await interaction.editReply(
        `📜 **Recent history for ticket #${context.ticketNumber}**

` +
          lines.join('\n') +
          (omitted > 0 ? '\n\n…and ' + omitted + ' older event(s) were omitted to fit Discord’s message limit.' : ''),
      );

      return;
    }

    await interaction.editReply(
      '❌ Unsupported ticket command.',
    );
  } catch (error) {
    console.error(
      '❌ Ticket command failed:',
      error,
    );

    try {
      if (
        interaction.deferred ||
        interaction.replied
      ) {
        await interaction.editReply(
          `❌ ${
            error instanceof Error
              ? error.message
              : 'Ticket command failed.'
          }`,
        );
      }
    } catch (replyError) {
      console.error(
        '❌ Failed to send ticket command error:',
        replyError,
      );
    }
  }
}
