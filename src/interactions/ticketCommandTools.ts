import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';

import {
  getGuildConfig,
  getTier,
  isPremiumOrHigher,
} from '../services/configService';

import {
  getOrCreateAuditChannel,
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
} from '../services/ticketPanelService';

import {
  getPersistedTicketStatus,
  setPersistedTicketStatus,
} from '../services/ticketPersistenceService';

import { setChannelTopic } from '../services/discordChannelService';

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

  const topic = channel.topic ?? '';

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
      ),
    ),
    isAuthorized:
      isStaff ||
      Boolean(
        interaction.memberPermissions?.has(
          PermissionFlagsBits.Administrator,
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
  if (
    !context.config.supportCategoryId ||
    !isPremiumOrHigher(
      context.config.tier,
    )
  ) {
    return;
  }

  await logTicketEvent(
    context.guild,
    context.config.supportCategoryId,
    {
      ticketNumber:
        context.ticketNumber,
      event,
      actor:
        interaction.user.tag,
      detail,
    },
  );
}

async function saveTopic(
  context: Awaited<
    ReturnType<typeof getTicketContext>
  >,
  topic: string,
): Promise<void> {
  /*
   * Keep metadata topics and persisted lifecycle state synchronized for
   * slash-command mutations. Native REST is used here so topic changes
   * share the same rate-limit-aware queue as other channel mutations.
   * Persist only after Discord accepts the topic update.
   */
  await setChannelTopic(
    context.channel.id,
    topic,
    'SupportForge ticket metadata update',
  );

  await setPersistedTicketStatus(
    context.channel.id,
    getTicketStatus(topic),
  );


  await refreshTicketPanel(
    context.channel,
    topic,
  );

  const ticketNumber = getField(topic, 'number');
  if (ticketNumber) {
    const expectedName = getTicketChannelName(
      ticketNumber,
      getTicketStatus(topic),
    );

    if (context.channel.name !== expectedName) {
      void queueTicketChannelRename(
        context.channel,
        expectedName,
        'SupportForge ticket status name synchronization',
      ).catch((error) => {
        console.error(
          '⚠️ Failed to synchronize ticket channel name:',
          error,
        );
      });
    }
  }
}

export async function executeTicketCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
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
    if (!context.isAuthorized) {
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
        'tag',
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
    /* Archive                                                            */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'archive') {
      if (context.status !== 'closed') {
        await interaction.editReply(
          `❌ Ticket #${context.ticketNumber} must be **closed** before it can be archived.`,
        );
        return;
      }

      let topic = setField(
        context.topic,
        'status',
        'archived',
      );

      topic = setField(
        topic,
        'archived_at',
        new Date().toISOString(),
      );

      await setPersistedTicketStatus(
        context.channel.id,
        'archived',
      );

      try {
        await moveTicketToCategory(
          context.channel,
          await ensureArchiveCategory(context.guild),
        );
      } catch (error) {
        console.warn(
          '⚠️ Archive storage transition failed:',
          error,
        );
      }

      try {
        await setChannelTopic(
          context.channel.id,
          topic,
          'SupportForge archive metadata update',
        );
      } catch (error) {
        console.warn(
          '⚠️ Archive topic update failed; persisted lifecycle state remains authoritative:',
          error,
        );
      }

      await refreshTicketPanel(
        context.channel,
        topic,
      );

      const expectedName = getTicketChannelName(
        context.ticketNumber,
        'archived',
      );

      if (context.channel.name !== expectedName) {
        void queueTicketChannelRename(
          context.channel,
          expectedName,
          `Ticket #${context.ticketNumber} archived`,
        ).catch((error) => {
          console.error(
            '⚠️ Failed to rename archived ticket:',
            error,
          );
        });
      }

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

      if (context.status === 'claimed') {
        await interaction.editReply(
          context.claimedBy ===
            interaction.user.id
            ? `ℹ️ You already have ticket #${context.ticketNumber} claimed.`
            : `❌ Ticket #${context.ticketNumber} is already claimed by <@${context.claimedBy ?? '0'}>.`,
        );
        return;
      }

      let topic = setField(
        context.topic,
        'status',
        'claimed',
      );

      topic = setField(
        topic,
        'claimed_by',
        interaction.user.id,
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

      await saveTopic(
        context,
        topic,
      );

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

      if (
        context.claimedBy !==
          interaction.user.id &&
        !context.isAdmin
      ) {
        await interaction.editReply(
          '❌ Only the current claimant or an administrator can unclaim this ticket.',
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
        'claimed_by',
      );

      topic = removeField(
        topic,
        'claimed_at',
      );

      topic = removeField(
        topic,
        'assigned_at',
      );

      topic = removeField(
        topic,
        'previous_assignee',
      );

      await saveTopic(
        context,
        topic,
      );

      await context.channel.send(
        `↩️ Ticket #${context.ticketNumber} was unclaimed by ${interaction.user}.`,
      );

      await audit(
        interaction,
        context,
        `Ticket unclaimed by ${interaction.user.tag}`,
      );

      await interaction.editReply(
        `✅ Ticket #${context.ticketNumber} is now **open**.`,
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

      await saveTopic(
        context,
        topic,
      );

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

      await saveTopic(
        context,
        topic,
      );

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

      await saveTopic(
        context,
        topic,
      );

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

      if (
        subcommand === 'add-user'
      ) {
        users.add(target.id);

        await context.channel.permissionOverwrites.edit(
          target.id,
          {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
            EmbedLinks: true,
          },
        );

        await context.channel.send(
          `➕ ${target} was added by ${interaction.user}.`,
        );
      } else {
        users.delete(
          target.id,
        );

        await context.channel.permissionOverwrites.delete(
          target.id,
        );

        await context.channel.send(
          `➖ ${target} was removed by ${interaction.user}.`,
        );
      }

      const topic =
        setField(
          context.topic,
          'users',
          [...users].join(','),
        );

      await saveTopic(
        context,
        topic,
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

      const topic =
        setField(
          context.topic,
          'priority',
          level,
        );

      await saveTopic(
        context,
        topic,
      );

      const emoji =
        (
          {
            low: '🟢',
            normal: '',
            high: '🟠',
            urgent: '🔴',
            critical: '🟣',
          } as Record<
            string,
            string
          >
        )[level];

      const baseName =
        context.channel.name.replace(
          /^[🟢⚪🟠🔴🟣]\s*/u,
          '',
        );

      await queueTicketChannelRename(
        context.channel,
        level === 'normal'
          ? baseName
          : `${emoji}${baseName}`,
        `SupportForge priority changed to ${level}`,
      );

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
    /* Tag                                                                */
    /* ------------------------------------------------------------------ */

    if (subcommand === 'tag') {
      const value =
        interaction.options
          .getString(
            'name',
            true,
          )
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '-');

      if (!value) {
        await interaction.editReply(
          '❌ Tag cannot be empty.',
        );
        return;
      }

      const tags =
        new Set(
          (
            getField(
              context.topic,
              'tags',
            ) ?? ''
          )
            .split(',')
            .filter(Boolean),
        );

      if (tags.has(value)) {
        await interaction.editReply(
          `ℹ️ Tag \`${value}\` is already on this ticket.`,
        );
        return;
      }

      tags.add(value);

      const topic =
        setField(
          context.topic,
          'tags',
          [...tags].join(','),
        );

      await saveTopic(
        context,
        topic,
      );

      await context.channel.send(
        `🏷️ Tag \`${value}\` added by ${interaction.user}.`,
      );

      await audit(
        interaction,
        context,
        `Tag added: ${value}`,
      );

      await interaction.editReply(
        `✅ Added tag \`${value}\`.`,
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
      const auditId =
        context.config.auditChannelId;

      const auditChannel =
        auditId
          ? context.guild.channels.cache.get(
              auditId,
            )
          : null;

      if (
        !auditChannel ||
        auditChannel.type !==
          ChannelType.GuildText
      ) {
        await interaction.editReply(
          'ℹ️ No audit history exists for this ticket yet.',
        );
        return;
      }

      const messages =
        await auditChannel.messages.fetch({
          limit: 50,
        });

      const matching =
        messages
          .filter(
            (
              message,
            ) =>
              message.embeds.some(
                (embed) =>
                  embed.description?.includes(
                    `Ticket #${context.ticketNumber}`,
                  ) ??
                  false,
              ),
          )
          .first(10);

      const lines =
        matching.length
          ? matching
              .map(
                (
                  message,
                ) =>
                  `${message.createdAt.toLocaleString(
                    'en-IN',
                  )} • ${
                    message.embeds[0]
                      ?.description ??
                    'Event'
                  }`,
              )
              .join('\n')
          : 'No recent audit events found.';

      await interaction.editReply(
        `📜 **Recent history for ticket #${context.ticketNumber}**\n\n${lines}`,
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
