import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type TextChannel,
} from 'discord.js';

import {
  allocateTicketNumber,
  getGuildConfig,
  isPremiumOrHigher,
} from '../services/configService';

import { generateTranscript } from '../services/transcriptService';
import { logTicketEvent } from '../services/auditLogService';

const PREFIX = 'supportforge:ticket';

type TicketStatus =
  | 'open'
  | 'claimed'
  | 'pending'
  | 'closed'
  | 'reopened'
  | 'archived';

/* -------------------------------------------------------------------------- */
/*                              RUNTIME LOCKS                                 */
/* -------------------------------------------------------------------------- */

const ticketActionLocks = new Set<string>();

interface RuntimeTicketState {
  topic: string;
  status: TicketStatus;
  updatedAt: number;
}

const ticketRuntimeCache = new Map<
  string,
  RuntimeTicketState
>();

const topicWriteQueues = new Map<
  string,
  Promise<void>
>();

/* -------------------------------------------------------------------------- */
/*                         CHANNEL RENAME QUEUE                              */
/* -------------------------------------------------------------------------- */

/*
 * Channel names must ultimately be changed through Discord's channel PATCH
 * endpoint. The earlier direct-fetch approach bypassed discord.js's REST
 * manager and could make Discord's rate-limit bucket worse.
 *
 * SupportForge now has exactly one rename queue per channel. Every rename is
 * sent through discord.js, so its REST manager owns the rate-limit handling.
 * We also avoid polling Discord and never create/delete a replacement
 * channel, which preserves the ticket's messages, channel ID and history.
 */

const channelRenameQueues = new Map<
  string,
  Promise<void>
>();

function queueChannelRename(
  channel: TextChannel,
  newName: string,
  reason: string
): Promise<void> {
  const previous =
    channelRenameQueues.get(
      channel.id
    ) ?? Promise.resolve();

  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (
        channel.name === newName
      ) {
        console.log(
          `ℹ️ Channel #${channel.id} is already named ${newName}.`
        );
        return;
      }

      console.log(
        `🔄 Queued channel rename: #${channel.id} ${channel.name} → ${newName}`
      );

      console.time(
        `CHANNEL_RENAME_${channel.id}`
      );

      try {
        await channel.setName(
          newName,
          reason
        );

        console.log(
          `✅ Channel #${channel.id} renamed to ${channel.name}.`
        );
      } catch (error) {
        console.error(
          `❌ Channel rename failed for #${channel.id}:`,
          error
        );
        throw error;
      } finally {
        console.timeEnd(
          `CHANNEL_RENAME_${channel.id}`
        );
      }
    });

  channelRenameQueues.set(
    channel.id,
    next
  );

  void next.finally(() => {
    if (
      channelRenameQueues.get(
        channel.id
      ) === next
    ) {
      channelRenameQueues.delete(
        channel.id
      );
    }
  });

  return next;
}

/* -------------------------------------------------------------------------- */
/*                               TOPIC HELPERS                                */
/* -------------------------------------------------------------------------- */

function getField(
  topic: string,
  key: string
): string | undefined {
  const escapedKey = key.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );

  const match = topic.match(
    new RegExp(
      `(?:^|\\s)${escapedKey}=([^\\s]*)`
    )
  );

  return match?.[1] || undefined;
}

function setField(
  topic: string,
  key: string,
  value: string
): string {
  const token = `${key}=`;

  const parts = topic
    .trim()
    .split(/\s+/);

  const index = parts.findIndex(
    (part) =>
      part.startsWith(token)
  );

  if (index >= 0) {
    parts[index] =
      `${token}${value}`;
  } else {
    parts.push(
      `${token}${value}`
    );
  }

  return parts.join(' ');
}

function isValidTicketStatus(
  value: string | undefined
): value is TicketStatus {
  return (
    value === 'open' ||
    value === 'claimed' ||
    value === 'pending' ||
    value === 'closed' ||
    value === 'reopened' ||
    value === 'archived'
  );
}

function getStatusFromTopic(
  topic: string
): TicketStatus {
  const value =
    getField(
      topic,
      'status'
    );

  if (
    isValidTicketStatus(
      value
    )
  ) {
    return value;
  }

  /*
   * Backwards compatibility for old tickets
   * which did not contain a status field.
   */
  return 'open';
}

/* -------------------------------------------------------------------------- */
/*                           RUNTIME STATE CACHE                              */
/* -------------------------------------------------------------------------- */

function getRuntimeTicketState(
  channel: TextChannel
): RuntimeTicketState {
  const cached =
    ticketRuntimeCache.get(
      channel.id
    );

  if (cached) {
    return cached;
  }

  const topic =
    channel.topic ?? '';

  const state: RuntimeTicketState = {
    topic,
    status:
      getStatusFromTopic(
        topic
      ),
    updatedAt: Date.now(),
  };

  ticketRuntimeCache.set(
    channel.id,
    state
  );

  return state;
}

function updateRuntimeTicketState(
  channel: TextChannel,
  topic: string,
  status: TicketStatus
): RuntimeTicketState {
  const state: RuntimeTicketState = {
    topic,
    status,
    updatedAt: Date.now(),
  };

  ticketRuntimeCache.set(
    channel.id,
    state
  );

  return state;
}

function clearRuntimeTicketState(
  channelId: string
): void {
  ticketRuntimeCache.delete(
    channelId
  );
}

/* -------------------------------------------------------------------------- */
/*                         BACKGROUND TOPIC QUEUE                             */
/* -------------------------------------------------------------------------- */

function queueTopicUpdate(
  channel: TextChannel,
  topic: string
): void {
  const previous =
    topicWriteQueues.get(
      channel.id
    ) ?? Promise.resolve();

  const next = previous
    .catch(() => undefined)
    .then(async () => {
      console.time(
        `TOPIC_WRITE_${channel.id}`
      );

      try {
        await channel.setTopic(
          topic
        );

        console.timeEnd(
          `TOPIC_WRITE_${channel.id}`
        );

        console.log(
          `✅ Background topic update completed for ticket #${
            getField(
              topic,
              'number'
            ) ?? 'Unknown'
          }`
        );
      } catch (error) {
        console.timeEnd(
          `TOPIC_WRITE_${channel.id}`
        );

        console.error(
          `❌ Background topic update failed for ticket #${
            getField(
              topic,
              'number'
            ) ?? 'Unknown'
          }:`,
          error
        );
      }
    });

  topicWriteQueues.set(
    channel.id,
    next
  );

  void next.then(
    () => {
      if (
        topicWriteQueues.get(
          channel.id
        ) === next
      ) {
        topicWriteQueues.delete(
          channel.id
        );
      }
    },
    () => {
      if (
        topicWriteQueues.get(
          channel.id
        ) === next
      ) {
        topicWriteQueues.delete(
          channel.id
        );
      }
    }
  );
}

/* -------------------------------------------------------------------------- */
/*                                  BUTTONS                                   */
/* -------------------------------------------------------------------------- */

function buildButtons(
  status: TicketStatus
): ActionRowBuilder<ButtonBuilder> {
  const claim =
    new ButtonBuilder()
      .setCustomId(
        'ticket:claim'
      )
      .setLabel('Claim')
      .setEmoji('🙋')
      .setStyle(
        ButtonStyle.Success
      );

  const unclaim =
    new ButtonBuilder()
      .setCustomId(
        'ticket:unclaim'
      )
      .setLabel('Unclaim')
      .setEmoji('↩️')
      .setStyle(
        ButtonStyle.Secondary
      );

  const pending =
    new ButtonBuilder()
      .setCustomId(
        'ticket:pending'
      )
      .setLabel('Pending')
      .setEmoji('⏳')
      .setStyle(
        ButtonStyle.Secondary
      );

  const resume =
    new ButtonBuilder()
      .setCustomId(
        'ticket:resume'
      )
      .setLabel('Resume')
      .setEmoji('▶️')
      .setStyle(
        ButtonStyle.Success
      );

  const close =
    new ButtonBuilder()
      .setCustomId(
        'ticket:close'
      )
      .setLabel('Close')
      .setEmoji('🔒')
      .setStyle(
        ButtonStyle.Danger
      );

  const reopen =
    new ButtonBuilder()
      .setCustomId(
        'ticket:reopen'
      )
      .setLabel('Reopen')
      .setEmoji('🔓')
      .setStyle(
        ButtonStyle.Success
      );

  const archive =
    new ButtonBuilder()
      .setCustomId(
        'ticket:archive'
      )
      .setLabel('Archive')
      .setEmoji('🗄️')
      .setStyle(
        ButtonStyle.Secondary
      );

  const archived =
    new ButtonBuilder()
      .setCustomId(
        'ticket:archived'
      )
      .setLabel('Archived')
      .setEmoji('🗄️')
      .setStyle(
        ButtonStyle.Secondary
      )
      .setDisabled(true);

  switch (status) {
    case 'open':
    case 'reopened':
      return new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          claim,
          pending,
          close
        );

    case 'claimed':
      return new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          unclaim,
          pending,
          close
        );

    case 'pending':
      return new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          resume,
          close
        );

    case 'closed':
      return new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          reopen,
          archive
        );

    case 'archived':
      return new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          archived
        );

    default:
      return new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          claim,
          pending,
          close
        );
  }
}

/* -------------------------------------------------------------------------- */
/*                              GENERAL HELPERS                               */
/* -------------------------------------------------------------------------- */

function isAdmin(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction
): boolean {
  return Boolean(
    interaction.memberPermissions?.has(
      PermissionFlagsBits.Administrator
    )
  );
}

async function replyError(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
  content: string
): Promise<void> {
  if (
    interaction.deferred &&
    !interaction.replied
  ) {
    await interaction.editReply(
      content
    );
    return;
  }

  if (!interaction.replied) {
    await interaction.reply({
      content,
      flags:
        MessageFlags.Ephemeral,
    });
  }
}

function getStaffContext(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
  topic: string
) {
  const ownerId =
    getField(
      topic,
      'owner'
    );

  const staffRoleId =
    getField(
      topic,
      'staff'
    );

  const staffRole =
    staffRoleId &&
    staffRoleId !== 'none'
      ? staffRoleId
      : null;

  let isStaff = false;

  if (
    staffRole &&
    interaction.member
  ) {
    const member =
      interaction.member;

    if ('roles' in member) {
      const roles =
        member.roles;

      if (
        Array.isArray(
          roles
        )
      ) {
        isStaff =
          roles.includes(
            staffRole
          );
      } else {
        isStaff =
          roles.cache.has(
            staffRole
          );
      }
    }
  }

  return {
    ownerId,
    staffRole,
    isStaff,
  };
}

async function updateMainMessage(
  channel: TextChannel,
  messageId:
    | string
    | undefined,
  status: TicketStatus
): Promise<void> {
  if (!messageId) {
    console.warn(
      `⚠️ No ticket message ID found for #${channel.name}.`
    );

    return;
  }

  /*
   * Try cache first.
   *
   * This is intentionally kept here because a message fetch
   * can introduce another REST request and therefore another
   * opportunity to encounter Discord API rate limits.
   */
  let message =
    channel.messages.cache.get(
      messageId
    );

  if (!message) {
    console.log(
      `📨 Ticket message ${messageId} not found in cache for #${channel.name}; fetching...`
    );

    message =
      await channel.messages.fetch(
        messageId
      );
  }

  await message.edit({
    components: [
      buildButtons(
        status
      ),
    ],
  });
}

function emojiForStatus(
  status: TicketStatus
): string {
  return {
    open: '🟢',
    claimed: '🙋',
    pending: '⏳',
    closed: '🔒',
    reopened: '🔓',
    archived: '🗄️',
  }[status];
}

function capitalize(
  value: string
): string {
  return (
    value.charAt(0).toUpperCase() +
    value.slice(1)
  );
}

/* -------------------------------------------------------------------------- */
/*                              TICKET CREATION                               */
/* -------------------------------------------------------------------------- */

async function createTicket(
  interaction: ModalSubmitInteraction,
  departmentId: string
): Promise<void> {
  const guild =
    interaction.guild!;

  const config =
    await getGuildConfig(
      guild.id
    );

  const department =
    config.departments[
      departmentId
    ];

  if (!department) {
    await replyError(
      interaction,
      '❌ This ticket department no longer exists.'
    );
    return;
  }

  const supportCategoryId =
    config.supportCategoryId;

  if (!supportCategoryId) {
    await replyError(
      interaction,
      '❌ SupportForge is not configured. Run `/supportforge setup` first.'
    );
    return;
  }

  const supportCategory =
    guild.channels.cache.get(
      supportCategoryId
    );

  if (
    !supportCategory ||
    supportCategory.type !==
      ChannelType.GuildCategory
  ) {
    await replyError(
      interaction,
      '❌ The Support Forge category is missing. Run `/supportforge setup` to repair it.'
    );
    return;
  }

  /* ---------------------------------------------------------------------- */
  /*                    ACTIVE TICKET DETECTION                             */
  /* ---------------------------------------------------------------------- */

  const existing =
    guild.channels.cache.find(
      (channel) => {
        if (
          channel.type !==
            ChannelType.GuildText ||
          channel.parentId !==
            supportCategoryId
        ) {
          return false;
        }

        const topic =
          channel.topic ?? '';

        if (
          !topic.startsWith(
            PREFIX
          )
        ) {
          return false;
        }

        if (
          getField(
            topic,
            'owner'
          ) !==
          interaction.user.id
        ) {
          return false;
        }

        if (
          getField(
            topic,
            'department'
          ) !==
          departmentId
        ) {
          return false;
        }

        const runtimeState =
          ticketRuntimeCache.get(
            channel.id
          );

        const status =
          runtimeState?.status ??
          getStatusFromTopic(
            topic
          );

        const activeStatuses:
          TicketStatus[] = [
            'open',
            'claimed',
            'pending',
            'reopened',
          ];

        const isActive =
          activeStatuses.includes(
            status
          );

        console.log(
          `🔎 Ticket creation check | #${
            getField(
              topic,
              'number'
            ) ?? 'Unknown'
          } | status=${status} | active=${isActive}`
        );

        return isActive;
      }
    );

  if (existing) {
    await replyError(
      interaction,
      `❌ You already have an active **${department.name}** ticket: ${existing}`
    );

    return;
  }

  /* ---------------------------------------------------------------------- */
  /*                              FORM DATA                                 */
  /* ---------------------------------------------------------------------- */

  const subject =
    interaction.fields
      .getTextInputValue(
        'subject'
      )
      .trim();

  const description =
    interaction.fields
      .getTextInputValue(
        'description'
      )
      .trim();

  if (
    !subject ||
    !description
  ) {
    await replyError(
      interaction,
      '❌ Subject and description are required.'
    );

    return;
  }

  /* ---------------------------------------------------------------------- */
  /*                           TICKET NUMBER                                */
  /* ---------------------------------------------------------------------- */

  const ticketNumber =
    await allocateTicketNumber(
      guild.id
    );

  /* ---------------------------------------------------------------------- */
  /*                                TOPIC                                   */
  /* ---------------------------------------------------------------------- */

  const topic = [
    PREFIX,
    'v=1',
    'status=open',
    `owner=${interaction.user.id}`,
    `department=${departmentId}`,
    `staff=${
      department.staffRoleId ??
      'none'
    }`,
    'priority=normal',
    'tags=',
    'users=',
    'claimedBy=',
    `subject=${encodeURIComponent(
      subject.replace(
        /\s+/g,
        ' '
      )
    )}`,
    `number=${ticketNumber}`,
  ].join(' ');

  /* ---------------------------------------------------------------------- */
  /*                            PERMISSIONS                                 */
  /* ---------------------------------------------------------------------- */

  const permissions = [
    {
      id:
        guild.roles.everyone.id,
      deny: [
        PermissionFlagsBits.ViewChannel,
      ],
    },
    {
      id:
        interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id:
        interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];

  if (
    department.staffRoleId
  ) {
    permissions.push({
      id:
        department.staffRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    });
  }

  /* ---------------------------------------------------------------------- */
  /*                           CREATE CHANNEL                               */
  /* ---------------------------------------------------------------------- */

  const ticketChannel =
    await guild.channels.create({
      name:
        `ticket-${ticketNumber}`,
      type:
        ChannelType.GuildText,
      parent:
        supportCategoryId,
      topic,
      permissionOverwrites:
        permissions,
    });

  /* ---------------------------------------------------------------------- */
  /*                               EMBED                                    */
  /* ---------------------------------------------------------------------- */

  const embed =
    new EmbedBuilder()
      .setTitle(
        `🎫 Support Ticket #${ticketNumber}`
      )
      .setDescription(
        description
      )
      .addFields(
        {
          name:
            '👤 Owner',
          value:
            `${interaction.user}`,
          inline: true,
        },
        {
          name:
            '📂 Department',
          value:
            department.name,
          inline: true,
        },
        {
          name:
            '📌 Subject',
          value:
            subject,
        },
        {
          name:
            '📊 Status',
          value:
            'Open',
          inline: true,
        },
        {
          name:
            '⚡ Priority',
          value:
            'Normal',
          inline: true,
        }
      )
      .setFooter({
        text:
          'SupportForge',
      })
      .setTimestamp();

  try {
    const message =
      await ticketChannel.send({
        content:
          department.staffRoleId
            ? `${interaction.user} <@&${department.staffRoleId}>`
            : `${interaction.user}`,
        embeds: [
          embed,
        ],
        components: [
          buildButtons(
            'open'
          ),
        ],
      });

    const finalTopic =
      `${topic} message=${message.id}`;

    await ticketChannel.setTopic(
      finalTopic
    );

    updateRuntimeTicketState(
      ticketChannel,
      finalTopic,
      'open'
    );

    await interaction.editReply(
      `✅ Ticket created: ${ticketChannel}`
    );

    if (
      isPremiumOrHigher(
        config.tier
      )
    ) {
      void logTicketEvent(
        guild,
        supportCategoryId,
        {
          ticketNumber:
            `${ticketNumber}`,
          event:
            'Ticket created',
          actor:
            interaction.user.tag,
          detail:
            `Department: ${department.name}\nSubject: ${subject}`,
        }
      ).catch(
        (error) => {
          console.error(
            `⚠️ Failed to write creation audit log for #${ticketNumber}:`,
            error
          );
        }
      );
    }
  } catch (error) {
    await ticketChannel
      .delete(
        'SupportForge cleanup after ticket initialization failure'
      )
      .catch(
        () => undefined
      );

    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/*                         PERMISSION RESTORATION                             */
/* -------------------------------------------------------------------------- */

async function restoreTicketPermissions(
  interaction: ButtonInteraction,
  channel: TextChannel,
  topic: string
): Promise<void> {
  const ownerId =
    getField(
      topic,
      'owner'
    );

  const staffRoleId =
    getField(
      topic,
      'staff'
    );

  const users =
    (
      getField(
        topic,
        'users'
      ) ?? ''
    )
      .split(',')
      .filter(Boolean);

  const operations:
    Promise<unknown>[] = [];

  if (
    ownerId &&
    ownerId !==
      interaction.guild!.ownerId
  ) {
    operations.push(
      channel.permissionOverwrites.edit(
        ownerId,
        {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
          EmbedLinks: true,
        }
      )
    );
  }

  if (
    staffRoleId &&
    staffRoleId !== 'none'
  ) {
    operations.push(
      channel.permissionOverwrites.edit(
        staffRoleId,
        {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
          EmbedLinks: true,
        }
      )
    );
  }

  for (
    const userId of users
  ) {
    operations.push(
      channel.permissionOverwrites.edit(
        userId,
        {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
          EmbedLinks: true,
        }
      )
    );
  }

  await Promise.all(
    operations
  );
}

/* -------------------------------------------------------------------------- */
/*                            STATUS TRANSITIONS                              */
/* -------------------------------------------------------------------------- */

async function transition(
  interaction: ButtonInteraction,
  newStatus: TicketStatus,
  allowed: TicketStatus[],
  successMessage: string
): Promise<void> {
  const channel =
    interaction.channel;

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildText
  ) {
    await interaction.reply({
      content:
        '❌ This action can only be used inside a ticket channel.',
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  if (
    ticketActionLocks.has(
      channel.id
    )
  ) {
    await interaction.reply({
      content:
        '⏳ Another ticket action is currently being processed. Please wait a moment.',
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  ticketActionLocks.add(
    channel.id
  );

  try {
    await interaction.deferReply({
      flags:
        MessageFlags.Ephemeral,
    });

    const runtimeState =
      getRuntimeTicketState(
        channel
      );

    const topic =
      runtimeState.topic;

    if (
      !topic.startsWith(
        PREFIX
      )
    ) {
      await interaction.editReply(
        '❌ This channel is not a SupportForge ticket.'
      );

      return;
    }

    const currentStatus =
      runtimeState.status;

    const ticketNumber =
      getField(
        topic,
        'number'
      ) ?? 'Unknown';

    console.log(
      `🔄 Ticket transition: #${
        getField(
          topic,
          'number'
        ) ?? 'Unknown'
      } | ${currentStatus} → ${newStatus}`
    );

    if (
      !allowed.includes(
        currentStatus
      )
    ) {
      await interaction.editReply(
        `❌ This action is not available while the ticket is **${capitalize(
          currentStatus
        )}**.`
      );

      return;
    }

    const context =
      getStaffContext(
        interaction,
        topic
      );

    if (
      !context.isStaff &&
      !isAdmin(interaction)
    ) {
      await interaction.editReply(
        '❌ Only configured staff or administrators can change ticket status.'
      );

      return;
    }

    let newTopic =
      setField(
        topic,
        'status',
        newStatus
      );

    if (
      newStatus ===
      'claimed'
    ) {
      newTopic =
        setField(
          newTopic,
          'claimedBy',
          interaction.user.id
        );
    }

    if (
      newStatus ===
        'open' ||
      newStatus ===
        'reopened'
    ) {
      newTopic =
        setField(
          newTopic,
          'claimedBy',
          ''
        );
    }

    updateRuntimeTicketState(
      channel,
      newTopic,
      newStatus
    );

    queueTopicUpdate(
      channel,
      newTopic
    );

    /* ------------------------------------------------------------------ */
    /*                          REOPEN                                    */
    /* ------------------------------------------------------------------ */

    if (
      newStatus ===
      'reopened'
    ) {
      await restoreTicketPermissions(
        interaction,
        channel,
        topic
      );

      const actualChannelName =
        channel.name;

      if (
        actualChannelName.endsWith(
          '-closed'
        )
      ) {
        const reopenedName =
          actualChannelName.slice(
            0,
            -7
          );

        await queueChannelRename(
          channel,
          reopenedName,
          `SupportForge reopen for ticket #${ticketNumber}`
        );

        console.log(
          `✅ Reopened ticket #${ticketNumber} renamed from ${actualChannelName} to ${reopenedName}.`
        );
      }
    }

    /* ------------------------------------------------------------------ */
    /*                          ARCHIVE                                   */
    /* ------------------------------------------------------------------ */

    if (
      newStatus ===
      'archived'
    ) {
      const operations:
        Promise<unknown>[] = [];

      if (
        context.ownerId
      ) {
        operations.push(
          channel.permissionOverwrites.edit(
            context.ownerId,
            {
              ViewChannel: false,
              SendMessages: false,
            }
          )
        );
      }

      const users =
        (
          getField(
            topic,
            'users'
          ) ?? ''
        )
          .split(',')
          .filter(Boolean);

      for (
        const userId of users
      ) {
        operations.push(
          channel.permissionOverwrites.edit(
            userId,
            {
              ViewChannel: false,
              SendMessages: false,
            }
          )
        );
      }

      if (
        context.staffRole
      ) {
        operations.push(
          channel.permissionOverwrites.edit(
            context.staffRole,
            {
              ViewChannel: true,
              ReadMessageHistory: true,
              SendMessages: false,
            }
          )
        );
      }

      await Promise.all(
        operations
      );
    }

    const messageId =
      getField(
        topic,
        'message'
      );

    await Promise.all([
      updateMainMessage(
        channel,
        messageId,
        newStatus
      ),

      channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(
              `${emojiForStatus(
                newStatus
              )} Ticket ${capitalize(
                newStatus
              )}`
            )
            .setDescription(
              `${interaction.user} changed the ticket status to **${capitalize(
                newStatus
              )}**.`
            )
            .setTimestamp(),
        ],
      }),
    ]);

    void getGuildConfig(
      interaction.guild!.id
    )
      .then(
        (config) => {
          if (
            isPremiumOrHigher(
              config.tier
            ) &&
            config.supportCategoryId
          ) {
            void logTicketEvent(
              interaction.guild!,
              config.supportCategoryId,
              {
                ticketNumber:
                  getField(
                    topic,
                    'number'
                  ) ??
                  'Unknown',
                event:
                  `Status → ${newStatus}`,
                actor:
                  interaction.user.tag,
              }
            ).catch(
              (error) => {
                console.error(
                  `⚠️ Failed to write status audit log for #${
                    getField(
                      topic,
                      'number'
                    ) ?? 'Unknown'
                  }:`,
                  error
                );
              }
            );
          }
        }
      )
      .catch(
        (error) => {
          console.error(
            '⚠️ Failed to load config for status audit:',
            error
          );
        }
      );

    await interaction.editReply(
      `✅ ${successMessage}`
    );

    console.log(
      `✅ Ticket #${
        getField(
          topic,
          'number'
        ) ?? 'Unknown'
      } successfully changed to ${newStatus}.`
    );
  } catch (error) {
    console.error(
      `❌ Ticket transition failed: ${newStatus}`,
      error
    );

    clearRuntimeTicketState(
      channel.id
    );

    await interaction
      .editReply(
        '❌ The ticket status could not be changed. Check the bot console.'
      )
      .catch(
        () => undefined
      );
  } finally {
    ticketActionLocks.delete(
      channel.id
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                              CLOSE TICKET                                  */
/* -------------------------------------------------------------------------- */

async function closeTicket(
  interaction: ButtonInteraction
): Promise<void> {
  const channel =
    interaction.channel;

  /* ---------------------------------------------------------------------- */
  /*                         BASIC VALIDATION                               */
  /* ---------------------------------------------------------------------- */

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildText
  ) {
    await interaction.reply({
      content:
        '❌ This action can only be used inside a ticket channel.',
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  /* ---------------------------------------------------------------------- */
  /*                         ACTION LOCK                                    */
  /* ---------------------------------------------------------------------- */

  if (
    ticketActionLocks.has(
      channel.id
    )
  ) {
    await interaction.reply({
      content:
        '⏳ Another ticket action is currently being processed. Please wait a moment.',
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  ticketActionLocks.add(
    channel.id
  );

  console.time(
    `CLOSE_TOTAL_${channel.id}`
  );

  try {
    /* ------------------------------------------------------------------ */
    /*                     ACKNOWLEDGE IMMEDIATELY                         */
    /* ------------------------------------------------------------------ */

    await interaction.deferReply({
      flags:
        MessageFlags.Ephemeral,
    });

    console.log(
      `🟡 Close interaction deferred for channel #${channel.name}`
    );

    /* ------------------------------------------------------------------ */
    /*                     GET CURRENT TICKET STATE                       */
    /* ------------------------------------------------------------------ */

    const runtimeState =
      getRuntimeTicketState(
        channel
      );

    const topic =
      runtimeState.topic;

    if (
      !topic.startsWith(
        PREFIX
      )
    ) {
      await interaction.editReply(
        '❌ This is not a SupportForge ticket.'
      );

      return;
    }

    const currentStatus =
      runtimeState.status;

    const ticketNumber =
      getField(
        topic,
        'number'
      ) ?? 'Unknown';

    console.log(
      `🔒 Close requested for #${ticketNumber} | current status=${currentStatus}`
    );

    /* ------------------------------------------------------------------ */
    /*                     STATUS VALIDATION                              */
    /* ------------------------------------------------------------------ */

    if (
      currentStatus ===
        'closed' ||
      currentStatus ===
        'archived'
    ) {
      await interaction.editReply(
        'ℹ️ This ticket is already closed or archived.'
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /*                     AUTHORIZATION                                  */
    /* ------------------------------------------------------------------ */

    const context =
      getStaffContext(
        interaction,
        topic
      );

    const isOwner =
      context.ownerId ===
      interaction.user.id;

    const authorized =
      isOwner ||
      context.isStaff ||
      isAdmin(interaction);

    if (!authorized) {
      await interaction.editReply(
        '❌ Only the ticket owner, configured staff, or an administrator can close this ticket.'
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /*                     LOAD CONFIG                                    */
    /* ------------------------------------------------------------------ */

    const config =
      await getGuildConfig(
        interaction.guild!.id
      );

    if (
      !config.supportCategoryId
    ) {
      await interaction.editReply(
        '❌ SupportForge configuration is missing.'
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /*                     TRANSCRIPT CHANNEL                             */
    /* ------------------------------------------------------------------ */

    const transcriptChannelId =
      config.transcriptChannelId;

    const transcriptChannel =
      transcriptChannelId
        ? interaction.guild!.channels.cache.get(
            transcriptChannelId
          )
        : null;

    if (
      !transcriptChannel ||
      transcriptChannel.type !==
        ChannelType.GuildText
    ) {
      await interaction.editReply(
        '❌ The transcript channel is missing. Run `/supportforge setup` to repair SupportForge.'
      );

      return;
    }

    /* ------------------------------------------------------------------ */
    /*                     TICKET METADATA                                */
    /* ------------------------------------------------------------------ */

    const rawSubject =
      getField(
        topic,
        'subject'
      );

    let subject =
      rawSubject ??
      'Unknown Subject';

    try {
      if (rawSubject) {
        subject =
          decodeURIComponent(
            rawSubject
          );
      }
    } catch {
      subject =
        rawSubject ??
        'Unknown Subject';
    }

    const ownerId =
      context.ownerId ??
      'Unknown';

    /*
     * FIX:
     *
     * The original ticket message ID is stored in the
     * ticket topic as:
     *
     * message=<discord-message-id>
     *
     * The final close operation needs this ID to update
     * the ticket buttons.
     */
    const messageId =
      getField(
        topic,
        'message'
      );

    if (!messageId) {
      console.warn(
        `⚠️ Ticket #${ticketNumber} has no stored message ID. Button update will be skipped.`
      );
    }

    const openedAt =
      channel.createdAt;

    const closedAt =
      new Date();

    /* ------------------------------------------------------------------ */
    /*                     OWNER NAME                                    */
    /* ------------------------------------------------------------------ */

    let ownerName =
      ownerId;

    const cachedOwner =
      interaction.guild!.members.cache.get(
        ownerId
      );

    if (cachedOwner) {
      ownerName =
        cachedOwner.displayName;
    } else if (
      ownerId !== 'Unknown'
    ) {
      try {
        const owner =
          await interaction.guild!.members.fetch(
            ownerId
          );

        ownerName =
          owner.displayName;
      } catch {
        ownerName =
          ownerId;
      }
    }

    /* ------------------------------------------------------------------ */
    /*                     GENERATE TRANSCRIPT                            */
    /* ------------------------------------------------------------------ */

    console.log(
      `📄 Generating transcript for ticket #${ticketNumber}...`
    );

    console.time(
      `CLOSE_TRANSCRIPT_${channel.id}`
    );

    let transcript;

    try {
      transcript =
        await generateTranscript({
          channel,
          ticketNumber,
          subject,
          ownerId,
          ownerName,
          closedBy:
            interaction.user.tag,
          openedAt,
          closedAt,
        });
    } catch (error) {
      console.error(
        `❌ Transcript generation failed for #${ticketNumber}:`,
        error
      );

      console.timeEnd(
        `CLOSE_TRANSCRIPT_${channel.id}`
      );

      await interaction
        .editReply(
          '❌ The ticket was not closed because its transcript could not be generated.'
        )
        .catch(
          (replyError) => {
            console.error(
              '❌ Failed to send transcript error response:',
              replyError
            );
          }
        );

      return;
    }

    console.timeEnd(
      `CLOSE_TRANSCRIPT_${channel.id}`
    );

    /* ------------------------------------------------------------------ */
    /*                     UPLOAD TRANSCRIPT                              */
    /* ------------------------------------------------------------------ */

    console.log(
      `📤 Uploading transcript for ticket #${ticketNumber}...`
    );

    console.time(
      `CLOSE_UPLOAD_${channel.id}`
    );

    try {
      await transcriptChannel.send({
        content:
          `📄 **Ticket #${ticketNumber} Transcript**\n` +
          `**Subject:** ${subject}\n` +
          `**Owner:** <@${ownerId}>\n` +
          `**Closed by:** ${interaction.user}`,
        files: [
          transcript,
        ],
      });
    } catch (error) {
      console.error(
        `❌ Transcript upload failed for #${ticketNumber}:`,
        error
      );

      console.timeEnd(
        `CLOSE_UPLOAD_${channel.id}`
      );

      await interaction
        .editReply(
          '❌ The transcript could not be uploaded, so the ticket was not closed.'
        )
        .catch(
          (replyError) => {
            console.error(
              '❌ Failed to send transcript upload error response:',
              replyError
            );
          }
        );

      return;
    }

    console.timeEnd(
      `CLOSE_UPLOAD_${channel.id}`
    );

    /* ------------------------------------------------------------------ */
    /*                     LOCK PERMISSIONS                               */
    /* ------------------------------------------------------------------ */

    console.log(
      `🔒 Locking ticket #${ticketNumber}...`
    );

    console.time(
      `CLOSE_PERMISSIONS_${channel.id}`
    );

    try {
      const bot =
        interaction.guild!.members.me;

      if (!bot) {
        throw new Error(
          'Bot member unavailable.'
        );
      }

      const botPermissions =
        channel.permissionsFor(
          bot
        );

      if (
        !botPermissions?.has(
          PermissionFlagsBits.ManageChannels
        )
      ) {
        throw new Error(
          'SupportForge is missing Manage Channels permission.'
        );
      }

      const operations:
        Promise<unknown>[] = [];

      if (
        ownerId !==
          'Unknown' &&
        ownerId !==
          interaction.guild!.ownerId
      ) {
        operations.push(
          channel.permissionOverwrites.edit(
            ownerId,
            {
              ViewChannel: true,
              SendMessages: false,
              AddReactions: false,
              AttachFiles: false,
              EmbedLinks: false,
              ReadMessageHistory: true,
            }
          )
        );
      }

      if (
        context.staffRole
      ) {
        operations.push(
          channel.permissionOverwrites.edit(
            context.staffRole,
            {
              ViewChannel: true,
              SendMessages: false,
              AddReactions: false,
              AttachFiles: false,
              EmbedLinks: false,
              ReadMessageHistory: true,
            }
          )
        );
      }

      const users =
        (
          getField(
            topic,
            'users'
          ) ?? ''
        )
          .split(',')
          .map(
            (userId) =>
              userId.trim()
          )
          .filter(Boolean);

      for (
        const userId of users
      ) {
        if (
          userId === ownerId
        ) {
          continue;
        }

        operations.push(
          channel.permissionOverwrites.edit(
            userId,
            {
              ViewChannel: true,
              SendMessages: false,
              AddReactions: false,
              AttachFiles: false,
              EmbedLinks: false,
              ReadMessageHistory: true,
            }
          )
        );
      }

      operations.push(
        channel.permissionOverwrites.edit(
          interaction.guild!.roles.everyone.id,
          {
            ViewChannel: false,
            SendMessages: false,
            ReadMessageHistory: false,
          }
        )
      );

      await Promise.all(
        operations
      );
    } catch (error) {
      console.error(
        `❌ Ticket permission lock failed for #${ticketNumber}:`,
        error
      );

      console.timeEnd(
        `CLOSE_PERMISSIONS_${channel.id}`
      );

      await interaction
        .editReply(
          '❌ The transcript was saved, but the ticket could not be locked. Check the bot permissions.'
        )
        .catch(
          (replyError) => {
            console.error(
              '❌ Failed to send permission error response:',
              replyError
            );
          }
        );

      return;
    }

    console.timeEnd(
      `CLOSE_PERMISSIONS_${channel.id}`
    );

    /* ------------------------------------------------------------------ */
    /*                     MARK AS CLOSED                                 */
    /* ------------------------------------------------------------------ */

    const closedTopic =
      setField(
        topic,
        'status',
        'closed'
      );

    updateRuntimeTicketState(
      channel,
      closedTopic,
      'closed'
    );

    console.log(
      `📝 Queueing closed topic update for #${ticketNumber}...`
    );

    queueTopicUpdate(
      channel,
      closedTopic
    );

    /* ------------------------------------------------------------------ */
    /*                  COMPLETE ORIGINAL INTERACTION                    */
    /* ------------------------------------------------------------------ */

    console.log(
      `🟢 ABOUT TO EDIT CLOSE REPLY #${ticketNumber}`
    );

    console.time(
      `CLOSE_INTERACTION_REPLY_${channel.id}`
    );

    try {
      await interaction.editReply(
        `✅ Ticket #${ticketNumber} is closed and locked. Transcript saved to ${transcriptChannel}.`
      );

      console.log(
        `🟢 CLOSE REPLY EDITED #${ticketNumber}`
      );
    } catch (replyError) {
      console.error(
        `❌ FAILED TO EDIT CLOSE REPLY #${ticketNumber}:`,
        replyError
      );
    }

    console.timeEnd(
      `CLOSE_INTERACTION_REPLY_${channel.id}`
    );

    /* ------------------------------------------------------------------ */
    /*                     CLOSE AUDIT + RENAME                           */
    /* ------------------------------------------------------------------ */

    /*
     * The rename no longer depends on the audit promise, transcript promise,
     * or discord.js's REST queue.  The transcript is already complete and
     * the ticket is already marked closed at this point, so we can perform
     * the rename immediately through Discord's HTTP API.
     */
    const auditPromise =
      (async () => {
        if (
          isPremiumOrHigher(
            config.tier
          )
        ) {
          try {
            console.time(
              `CLOSE_AUDIT_${channel.id}`
            );

            await logTicketEvent(
              interaction.guild!,
              config.supportCategoryId!,
              {
                ticketNumber,
                event:
                  'Ticket closed',
                actor:
                  interaction.user.tag,
              }
            );

            console.timeEnd(
              `CLOSE_AUDIT_${channel.id}`
            );

            console.log(
              `📝 ✅ Close audit recorded for #${ticketNumber}`
            );
          } catch (error) {
            console.error(
              `📝 ❌ Failed to write close audit log for #${ticketNumber}:`,
              error
            );
          }
        } else {
          console.log(
            `📝 Audit skipped for #${ticketNumber} because the current tier does not include audit logging.`
          );
        }
      })();

    const renamePromise =
      (async () => {
        console.time(
          `CLOSE_RENAME_${channel.id}`
        );

        try {
          if (
            channel.name.endsWith(
              '-closed'
            )
          ) {
            console.log(
              `ℹ️ Channel #${ticketNumber} is already named ${channel.name}.`
            );
            return;
          }

          const latestRuntimeState =
            ticketRuntimeCache.get(
              channel.id
            );

          const latestStatus =
            latestRuntimeState?.status ??
            getStatusFromTopic(
              channel.topic ?? ''
            );

          if (
            latestStatus !==
            'closed'
          ) {
            console.log(
              `🛑 Skipping channel rename for #${ticketNumber} because the ticket is now ${latestStatus}.`
            );
            return;
          }

          const newName =
            `${channel.name}-closed`;

          await queueChannelRename(
            channel,
            newName,
            `SupportForge close for ticket #${ticketNumber}`
          );

          console.log(
            `✅ Close rename completed for #${ticketNumber}.`
          );
        } catch (error) {
          console.error(
            `❌ Close rename failed for #${ticketNumber}:`,
            error
          );
          throw error;
        } finally {
          console.timeEnd(
            `CLOSE_RENAME_${channel.id}`
          );
        }
      })();

    /* ------------------------------------------------------------------ */
    /*                     BUTTON UPDATE                                  */
    /* ------------------------------------------------------------------ */

    const buttonPromise =
      (async () => {
        console.time(
          `CLOSE_BUTTONS_${channel.id}`
        );

        try {
          await updateMainMessage(
            channel,
            messageId,
            'closed'
          );

          console.log(
            `✅ Ticket buttons updated for #${ticketNumber}`
          );
        } catch (error) {
          console.error(
            `❌ Ticket button update failed for #${ticketNumber}:`,
            error
          );

          throw error;
        } finally {
          console.timeEnd(
            `CLOSE_BUTTONS_${channel.id}`
          );
        }
      })();

    /* ------------------------------------------------------------------ */
    /*                     CLOSE ANNOUNCEMENT                             */
    /* ------------------------------------------------------------------ */

    const closeMessagePromise =
      (async () => {
        console.time(
          `CLOSE_MESSAGE_${channel.id}`
        );

        try {
          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle(
                  '🔒 Ticket Closed'
                )
                .setDescription(
                  `This ticket was closed by ${interaction.user}.\n\n` +
                  `📄 Transcript saved to ${transcriptChannel}.`
                )
                .setTimestamp(),
            ],
          });

          console.log(
            `✅ Close announcement sent for #${ticketNumber}`
          );
        } catch (error) {
          console.error(
            `❌ Close announcement failed for #${ticketNumber}:`,
            error
          );

          throw error;
        } finally {
          console.timeEnd(
            `CLOSE_MESSAGE_${channel.id}`
          );
        }
      })();

    /*
     * None of these background operations is allowed to hold up the close
     * interaction.  The direct rename has its own timeout and retry policy.
     */
    void Promise.allSettled([
      auditPromise,
      renamePromise,
      buttonPromise,
      closeMessagePromise,
    ]).then(
      (results) => {
        console.timeEnd(
          `CLOSE_FINALIZE_${channel.id}`
        );

        const labels = [
          'audit',
          'rename',
          'buttons',
          'announcement',
        ];

        results.forEach(
          (result, index) => {
            if (
              result.status ===
              'rejected'
            ) {
              console.error(
                `❌ Background close ${labels[index]} failed for #${ticketNumber}:`,
                result.reason
              );
            }
          }
        );

        console.log(
          `✅ Background close operations settled for #${ticketNumber}`
        );
      }
    );

    /* ------------------------------------------------------------------ */
    /*                     SUCCESS                                       */
    /* ------------------------------------------------------------------ */

    console.log(
      `✅ Ticket #${ticketNumber} successfully closed.`
    );
  } catch (error) {
    console.error(
      `❌ Ticket close operation failed for #${
        getField(
          channel.topic ?? '',
          'number'
        ) ?? 'Unknown'
      }:`,
      error
    );

    clearRuntimeTicketState(
      channel.id
    );

    if (
      interaction.deferred &&
      !interaction.replied
    ) {
      await interaction
        .editReply(
          '❌ The ticket could not be closed. Check the bot console for details.'
        )
        .catch(
          () => undefined
        );
    }
  } finally {
    ticketActionLocks.delete(
      channel.id
    );

    console.timeEnd(
      `CLOSE_TOTAL_${channel.id}`
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                         MAIN INTERACTION HANDLER                           */
/* -------------------------------------------------------------------------- */

export async function handleTicketInteraction(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction
): Promise<void> {
  console.log(
    `🟡 INTERACTION RECEIVED | type=${
      interaction.type
    } | customId=${
      'customId' in interaction
        ? interaction.customId
        : 'none'
    } | user=${interaction.user.tag}`
  );

  /* ---------------------------------------------------------------------- */
  /*                              GUILD CHECK                               */
  /* ---------------------------------------------------------------------- */

  if (!interaction.guild) {
    await replyError(
      interaction,
      '❌ This feature is only available inside a server.'
    );

    return;
  }

  /* ---------------------------------------------------------------------- */
  /*                              CREATE BUTTON                             */
  /* ---------------------------------------------------------------------- */

  if (
    interaction.isButton() &&
    interaction.customId.startsWith(
      'ticket:create:'
    )
  ) {
    const departmentId =
      interaction.customId.split(
        ':'
      )[2];

    const modal =
      new ModalBuilder()
        .setCustomId(
          `ticket:modal:${departmentId}`
        )
        .setTitle(
          'Create Support Ticket'
        );

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(
          new TextInputBuilder()
            .setCustomId(
              'subject'
            )
            .setLabel(
              'Subject'
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setRequired(
              true
            )
            .setMaxLength(
              100
            )
        ),

      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(
          new TextInputBuilder()
            .setCustomId(
              'description'
            )
            .setLabel(
              'Describe the issue'
            )
            .setStyle(
              TextInputStyle.Paragraph
            )
            .setRequired(
              true
            )
            .setMaxLength(
              1500
            )
        )
    );

    await interaction.showModal(
      modal
    );

    return;
  }

  /* ---------------------------------------------------------------------- */
  /*                              CREATE MODAL                              */
  /* ---------------------------------------------------------------------- */

  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith(
      'ticket:modal:'
    )
  ) {
    await interaction.deferReply({
      flags:
        MessageFlags.Ephemeral,
    });

    try {
      await createTicket(
        interaction,
        interaction.customId.split(
          ':'
        )[2]
      );
    } catch (error) {
      console.error(
        '❌ Ticket creation failed:',
        error
      );

      await interaction.editReply(
        '❌ The ticket could not be created. Check the bot permissions and console.'
      );
    }

    return;
  }

  /* ---------------------------------------------------------------------- */
  /*                            BUTTON CHECK                                */
  /* ---------------------------------------------------------------------- */

  if (
    !interaction.isButton()
  ) {
    return;
  }

  /* ---------------------------------------------------------------------- */
  /*                              TICKET ACTIONS                            */
  /* ---------------------------------------------------------------------- */

  switch (
    interaction.customId
  ) {
    case 'ticket:close':
      await closeTicket(
        interaction
      );
      return;

    case 'ticket:claim':
      await transition(
        interaction,
        'claimed',
        [
          'open',
          'reopened',
        ],
        `Ticket #${
          getField(
            interaction.channel &&
              interaction.channel.type ===
                ChannelType.GuildText
              ? interaction.channel
                  .topic ?? ''
              : '',
            'number'
          ) ?? 'Unknown'
        } has been claimed.`
      );
      return;

    case 'ticket:unclaim':
      await transition(
        interaction,
        'open',
        ['claimed'],
        'The ticket has been returned to the open queue.'
      );
      return;

    case 'ticket:pending':
      await transition(
        interaction,
        'pending',
        [
          'open',
          'claimed',
          'reopened',
        ],
        'The ticket is now pending.'
      );
      return;

    case 'ticket:resume':
      await transition(
        interaction,
        'claimed',
        ['pending'],
        'The ticket is active again and marked as claimed.'
      );
      return;

    case 'ticket:reopen':
      await transition(
        interaction,
        'reopened',
        ['closed'],
        'The ticket has been reopened.'
      );
      return;

    case 'ticket:archive':
      await transition(
        interaction,
        'archived',
        ['closed'],
        'The ticket has been archived.'
      );
      return;

    default:
      return;
  }
}