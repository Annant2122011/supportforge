import {
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

const TICKET_PREFIX = 'supportforge:ticket';

const PRIORITIES = new Set([
  'low',
  'normal',
  'high',
  'urgent',
  'critical',
]);

const PRIORITY_EMOJI: Record<string, string> = {
  low: '🟢',
  normal: '⚪',
  high: '🟠',
  urgent: '🔴',
  critical: '🟣',
};

type TicketStatus =
  | 'open'
  | 'claimed'
  | 'pending'
  | 'closed'
  | 'reopened'
  | 'archived';

/**
 * Read a key=value field from a ticket channel topic.
 *
 * Example:
 * supportforge:ticket status=open owner=123 number=5726
 */
function field(topic: string, key: string): string | undefined {
  const match = topic.match(
    new RegExp(`(?:^|\\s)${key}=([^\\s]*)`),
  );

  return match?.[1] || undefined;
}

/**
 * Read the current ticket status.
 *
 * Older tickets that do not have a status field are treated as open
 * for backwards compatibility.
 */
function getTicketStatus(topic: string): TicketStatus {
  const status = field(topic, 'status');

  switch (status) {
    case 'open':
    case 'claimed':
    case 'pending':
    case 'closed':
    case 'reopened':
    case 'archived':
      return status;

    default:
      return 'open';
  }
}

/**
 * Add or replace a key=value field inside the ticket topic.
 */
function setTopicField(
  topic: string,
  key: string,
  value: string,
): string {
  const pattern = new RegExp(`(?:^|\\s)${key}=[^\\s]*`);

  if (pattern.test(topic)) {
    return topic.replace(pattern, (match) => {
      const prefix = match.startsWith(' ') ? ' ' : '';
      return `${prefix}${key}=${value}`;
    });
  }

  return `${topic} ${key}=${value}`.trim();
}

/**
 * Remove a key=value field from the ticket topic.
 */
function removeTopicField(
  topic: string,
  key: string,
): string {
  return topic
    .replace(
      new RegExp(`(?:^|\\s)${key}=[^\\s]*`),
      '',
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Check whether the interaction user is a Discord administrator.
 */
function isAdmin(
  interaction: ChatInputCommandInteraction,
): boolean {
  return Boolean(
    interaction.memberPermissions?.has(
      PermissionFlagsBits.Administrator,
    ),
  );
}

/**
 * Load all information required to manage the current ticket.
 */
async function loadContext(
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

  if (!topic.startsWith(TICKET_PREFIX)) {
    throw new Error(
      'This channel is not a SupportForge ticket.',
    );
  }

  if (!interaction.guild) {
    throw new Error(
      'This command can only be used inside a server.',
    );
  }

  const config = await getGuildConfig(
    interaction.guild.id,
  );

  const department =
    config.departments[
      field(topic, 'department') ?? ''
    ];

  const staffRoleId = field(topic, 'staff');

  const member =
    await interaction.guild.members.fetch(
      interaction.user.id,
    );

  const isStaff = Boolean(
    staffRoleId &&
      staffRoleId !== 'none' &&
      member.roles.cache.has(staffRoleId),
  );

  return {
    channel,
    topic,
    config,
    department,

    staffRoleId:
      staffRoleId && staffRoleId !== 'none'
        ? staffRoleId
        : null,

    isStaff,

    isAuthorized:
      isStaff || isAdmin(interaction),

    ticketNumber:
      field(topic, 'number') ?? 'Unknown',

    ownerId:
      field(topic, 'owner'),

    status:
      getTicketStatus(topic),

    claimedBy:
      field(topic, 'claimed_by'),

    pendingSince:
      field(topic, 'pending_since'),
  };
}

/**
 * Write a ticket lifecycle event to the audit log.
 */
async function auditLifecycleEvent(
  interaction: ChatInputCommandInteraction,
  context: Awaited<ReturnType<typeof loadContext>>,
  event: string,
): Promise<void> {
  if (!interaction.guild) return;

  if (!context.config.supportCategoryId) {
    return;
  }

  await logTicketEvent(
    interaction.guild,
    context.config.supportCategoryId,
    {
      ticketNumber: context.ticketNumber,
      event,
      actor: interaction.user.tag,
    },
  );
}

/**
 * Execute /supportforge ticket ...
 */
export async function executeTicketCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  try {
    const context = await loadContext(interaction);

    const subcommand =
      interaction.options.getSubcommand();

    const tier = await getTier(
      interaction.guild!.id,
    );

    /*
     * Only configured department staff or administrators
     * can manage tickets.
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
      ['priority', 'tag', 'note', 'history'].includes(
        subcommand,
      ) &&
      !isPremiumOrHigher(tier)
    ) {
      await interaction.editReply(
        '🔒 This feature is available in Premium/Pro demo mode. Run `/supportforge premium toggle-demo` as an administrator to preview it.',
      );

      return;
    }

    /*
     * =========================================================
     * CLAIM
     * =========================================================
     */
    if (subcommand === 'claim') {
      const status = getTicketStatus(
        context.topic,
      );

      if (
        status === 'closed' ||
        status === 'archived'
      ) {
        await interaction.editReply(
          `❌ Ticket #${context.ticketNumber} is **${status}** and cannot be claimed.`,
        );

        return;
      }

      if (status === 'pending') {
        await interaction.editReply(
          `⏳ Ticket #${context.ticketNumber} is currently **pending**. Resume it before claiming.`,
        );

        return;
      }

      if (status === 'claimed') {
        if (
          context.claimedBy ===
          interaction.user.id
        ) {
          await interaction.editReply(
            `ℹ️ You already have ticket #${context.ticketNumber} claimed.`,
          );
        } else {
          const claimant = context.claimedBy
            ? `<@${context.claimedBy}>`
            : 'another staff member';

          await interaction.editReply(
            `❌ Ticket #${context.ticketNumber} is already claimed by ${claimant}.`,
          );
        }

        return;
      }

      const topic = setTopicField(
        setTopicField(
          context.topic,
          'status',
          'claimed',
        ),
        'claimed_by',
        interaction.user.id,
      );

      const finalTopic = setTopicField(
        topic,
        'claimed_at',
        new Date().toISOString(),
      );

      await context.channel.setTopic(
        finalTopic,
      );

      await context.channel.send(
        `🎯 ${interaction.user} claimed ticket #${context.ticketNumber}.`,
      );

      await auditLifecycleEvent(
        interaction,
        context,
        `Ticket claimed by ${interaction.user.tag}`,
      );

      await interaction.editReply(
        `✅ Ticket #${context.ticketNumber} is now **claimed by you**.`,
      );

      return;
    }

    /*
     * =========================================================
     * UNCLAIM
     * =========================================================
     */
    if (subcommand === 'unclaim') {
      const status = getTicketStatus(
        context.topic,
      );

      if (status !== 'claimed') {
        await interaction.editReply(
          `ℹ️ Ticket #${context.ticketNumber} is not currently claimed.`,
        );

        return;
      }

      const isCurrentClaimant =
        context.claimedBy ===
        interaction.user.id;

      const isAdministrator =
        isAdmin(interaction);

      if (
        !isCurrentClaimant &&
        !isAdministrator
      ) {
        await interaction.editReply(
          '❌ Only the current claimant or an administrator can unclaim this ticket.',
        );

        return;
      }

      let topic = setTopicField(
        context.topic,
        'status',
        'open',
      );

      topic = removeTopicField(
        topic,
        'claimed_by',
      );

      topic = removeTopicField(
        topic,
        'claimed_at',
      );

      await context.channel.setTopic(topic);

      await context.channel.send(
        `↩️ Ticket #${context.ticketNumber} was unclaimed by ${interaction.user}.`,
      );

      await auditLifecycleEvent(
        interaction,
        context,
        `Ticket unclaimed by ${interaction.user.tag}`,
      );

      await interaction.editReply(
        `✅ Ticket #${context.ticketNumber} is now **open**.`,
      );

      return;
    }

    /*
     * =========================================================
     * PENDING
     * =========================================================
     */
    if (subcommand === 'pending') {
      const status = getTicketStatus(
        context.topic,
      );

      if (
        status === 'closed' ||
        status === 'archived'
      ) {
        await interaction.editReply(
          `❌ Ticket #${context.ticketNumber} is **${status}** and cannot be marked pending.`,
        );

        return;
      }

      if (status === 'pending') {
        await interaction.editReply(
          `ℹ️ Ticket #${context.ticketNumber} is already pending.`,
        );

        return;
      }

      /*
       * Pending tickets are unassigned in this v1 lifecycle.
       *
       * Flow:
       * OPEN -> CLAIMED -> PENDING -> OPEN
       */
      let topic = setTopicField(
        context.topic,
        'status',
        'pending',
      );

      topic = setTopicField(
        topic,
        'pending_since',
        new Date().toISOString(),
      );

      topic = removeTopicField(
        topic,
        'claimed_by',
      );

      topic = removeTopicField(
        topic,
        'claimed_at',
      );

      await context.channel.setTopic(topic);

      await context.channel.send(
        `⏳ Ticket #${context.ticketNumber} has been marked **pending** by ${interaction.user}.`,
      );

      await auditLifecycleEvent(
        interaction,
        context,
        `Ticket marked pending by ${interaction.user.tag}`,
      );

      await interaction.editReply(
        `⏳ Ticket #${context.ticketNumber} is now **pending**.`,
      );

      return;
    }

    /*
     * =========================================================
     * RESUME
     * =========================================================
     */
    if (subcommand === 'resume') {
      const status = getTicketStatus(
        context.topic,
      );

      if (status !== 'pending') {
        await interaction.editReply(
          `ℹ️ Ticket #${context.ticketNumber} is not pending.`,
        );

        return;
      }

      let topic = setTopicField(
        context.topic,
        'status',
        'open',
      );

      topic = removeTopicField(
        topic,
        'pending_since',
      );

      await context.channel.setTopic(topic);

      await context.channel.send(
        `▶️ Ticket #${context.ticketNumber} has been resumed by ${interaction.user}.`,
      );

      await auditLifecycleEvent(
        interaction,
        context,
        `Ticket resumed by ${interaction.user.tag}`,
      );

      await interaction.editReply(
        `✅ Ticket #${context.ticketNumber} is now **open** again.`,
      );

      return;
    }

    /*
     * =========================================================
     * ADD / REMOVE USER
     * =========================================================
     */
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

      const encodedUsers =
        field(context.topic, 'users') ?? '';

      const currentUsers = new Set(
        encodedUsers
          .split(',')
          .filter(Boolean),
      );

      if (subcommand === 'add-user') {
        currentUsers.add(target.id);

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

        await interaction.editReply(
          `✅ ${target} now has access to ticket #${context.ticketNumber}.`,
        );
      } else {
        currentUsers.delete(target.id);

        await context.channel.permissionOverwrites.delete(
          target.id,
        );

        await context.channel.send(
          `➖ ${target} was removed by ${interaction.user}.`,
        );

        await interaction.editReply(
          `✅ ${target} was removed from ticket #${context.ticketNumber}.`,
        );
      }

      const newUsers =
        [...currentUsers].join(',');

      const newTopic =
        context.topic.replace(
          /(?:^|\s)users=[^\s]*/,
          ` users=${newUsers}`,
        );

      await context.channel.setTopic(
        newTopic.includes(' users=')
          ? newTopic
          : `${newTopic} users=${newUsers}`,
      );

      return;
    }

    /*
     * =========================================================
     * PRIORITY
     * =========================================================
     */
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

      let topic = context.topic;

      if (
        /(?:^|\s)priority=/.test(topic)
      ) {
        topic = topic.replace(
          /(?:^|\s)priority=[^\s]*/,
          ` priority=${level}`,
        );
      } else {
        topic += ` priority=${level}`;
      }

      await context.channel.setTopic(topic);

      const base =
        context.channel.name.replace(
          /^[🟢⚪🟠🔴🟣]\s*/u,
          '',
        );

      await context.channel.setName(
        level === 'normal'
          ? base
          : `${PRIORITY_EMOJI[level]}${base}`,
      );

      await auditLifecycleEvent(
        interaction,
        context,
        `Priority changed to ${level}`,
      );

      await interaction.editReply(
        `✅ Ticket #${context.ticketNumber} priority is now **${level}**.`,
      );

      return;
    }

    /*
     * =========================================================
     * TAG
     * =========================================================
     */
    if (subcommand === 'tag') {
      const value =
        interaction.options
          .getString('name', true)
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '-');

      if (!value) {
        await interaction.editReply(
          '❌ Tag cannot be empty.',
        );

        return;
      }

      const current = new Set(
        (
          field(context.topic, 'tags') ??
          ''
        )
          .split(',')
          .filter(Boolean),
      );

      if (current.has(value)) {
        await interaction.editReply(
          `ℹ️ Tag \`${value}\` is already on this ticket.`,
        );

        return;
      }

      current.add(value);

      let topic = context.topic;

      if (
        /(?:^|\s)tags=/.test(topic)
      ) {
        topic = topic.replace(
          /(?:^|\s)tags=[^\s]*/,
          ` tags=${[...current].join(',')}`,
        );
      } else {
        topic += ` tags=${[
          ...current,
        ].join(',')}`;
      }

      await context.channel.setTopic(topic);

      await context.channel.send(
        `🏷️ Tag \`${value}\` added by ${interaction.user}.`,
      );

      await auditLifecycleEvent(
        interaction,
        context,
        `Tag added: ${value}`,
      );

      await interaction.editReply(
        `✅ Added tag \`${value}\`.`,
      );

      return;
    }

    /*
     * =========================================================
     * INTERNAL NOTE
     * =========================================================
     */
    if (subcommand === 'note') {
      const text =
        interaction.options
          .getString('text', true)
          .trim();

      const audit =
        await getOrCreateAuditChannel(
          interaction.guild!,
          context.config.supportCategoryId!,
        );

      await audit.send({
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

      return;
    }

    /*
     * =========================================================
     * HISTORY
     * =========================================================
     */
    if (subcommand === 'history') {
      const auditId =
        context.config.auditChannelId;

      const audit = auditId
        ? interaction.guild!.channels.cache.get(
            auditId,
          )
        : null;

      if (
        !audit ||
        audit.type !== ChannelType.GuildText
      ) {
        await interaction.editReply(
          'ℹ️ No audit history exists for this ticket yet.',
        );

        return;
      }

      const messages =
        await audit.messages.fetch({
          limit: 50,
        });

      const matching = messages
        .filter((message) =>
          message.embeds.some(
            (embed) =>
              embed.description?.includes(
                `Ticket #${context.ticketNumber}`,
              ),
          ),
        )
        .first(10);

      const lines = matching.length
        ? matching
            .map(
              (message) =>
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

    /*
     * =========================================================
     * UNKNOWN COMMAND
     * =========================================================
     */
    await interaction.editReply(
      '❌ Unsupported ticket command.',
    );
  } catch (error) {
    console.error(
      '❌ Ticket command failed:',
      error,
    );

    await interaction.editReply(
      `❌ ${
        error instanceof Error
          ? error.message
          : 'Ticket command failed.'
      }`,
    );
  }
}