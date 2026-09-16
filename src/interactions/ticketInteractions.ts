import {
  ActionRowBuilder,
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

import {
  getOrCreateAuditChannel,
  logTicketEvent,
} from '../services/auditLogService';

import {
  TICKET_PREFIX,
  getField,
  getTicketStatus,
  isTicketTopic,
  removeField,
  setField,
  type TicketStatus,
} from '../services/ticketStateService';

import {
  buildTicketPanelComponents,
  buildTicketPanelEmbed,
  isPanelButton,
  queueTicketChannelRename,
} from '../services/ticketPanelService';

/**
 * Prevents multiple state-changing operations from running against
 * the same ticket simultaneously.
 */
const ticketActionLocks = new Set<string>();

/**
 * Prevents two ticket creation requests from the same user/department
 * from racing each other.
 */
const ticketCreationLocks = new Set<string>();

interface RuntimeTicketState {
  topic: string;
  status: TicketStatus;
  updatedAt: number;
}

const ticketRuntimeCache = new Map<string, RuntimeTicketState>();

const ACTIVE_TICKET_STATUSES: readonly TicketStatus[] = [
  'open',
  'claimed',
  'pending',
  'reopened',
];

const TERMINAL_TICKET_STATUSES: readonly TicketStatus[] = [
  'closed',
  'archived',
];

function isActiveTicketStatus(status: TicketStatus): boolean {
  return ACTIVE_TICKET_STATUSES.includes(status);
}

function isTerminalTicketStatus(status: TicketStatus): boolean {
  return TERMINAL_TICKET_STATUSES.includes(status);
}

/**
 * Reads the actual Discord channel topic first.
 *
 * The cache is only used when it still matches Discord's current topic.
 * This prevents stale state from surviving manual/topic changes.
 */
function getRuntimeTicketState(channel: TextChannel): RuntimeTicketState {
  const actualTopic = channel.topic ?? '';
  const cached = ticketRuntimeCache.get(channel.id);

  if (cached && cached.topic === actualTopic) {
    return cached;
  }

  const state: RuntimeTicketState = {
    topic: actualTopic,
    status: getTicketStatus(actualTopic),
    updatedAt: Date.now(),
  };

  ticketRuntimeCache.set(channel.id, state);

  return state;
}

function updateRuntimeTicketState(
  channel: TextChannel,
  topic: string,
  status: TicketStatus,
): void {
  ticketRuntimeCache.set(channel.id, {
    topic,
    status,
    updatedAt: Date.now(),
  });
}

function clearRuntimeTicketState(channelId: string): void {
  ticketRuntimeCache.delete(channelId);
}

/**
 * Discord interaction permission helper.
 */
function isAdmin(
  interaction: ButtonInteraction | ModalSubmitInteraction,
): boolean {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator),
  );
}

/**
 * Gets ticket owner/staff information and determines whether the
 * current user is configured staff or an administrator.
 */
function getStaffContext(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  topic: string,
) {
  const ownerId = getField(topic, 'owner');

  const rawStaffRole = getField(topic, 'staff');

  const staffRole =
    rawStaffRole && rawStaffRole !== 'none'
      ? rawStaffRole
      : null;

  let isStaff = false;

  if (
    staffRole &&
    interaction.member &&
    'roles' in interaction.member
  ) {
    const roles = interaction.member.roles;

    if (Array.isArray(roles)) {
      isStaff = roles.includes(staffRole);
    } else {
      isStaff = roles.cache.has(staffRole);
    }
  }

  return {
    ownerId,
    staffRole,
    isStaff,
    authorized: isStaff || isAdmin(interaction),
  };
}

/**
 * Safe interaction error response.
 */
async function replyError(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply(content);
    return;
  }

  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
    });
  }
}

function decodeSubject(raw: string | undefined): string {
  if (!raw) {
    return 'Unknown subject';
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseUserId(value: string): string | null {
  const mentionMatch = value.match(/^<@!?([0-9]+)>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }

  const idMatch = value.match(/^([0-9]{15,25})$/);
  return idMatch?.[1] ?? null;
}

/**
 * Fetches and updates the ticket's primary control-panel message.
 *
 * A missing panel message should not crash the whole ticket operation.
 * The caller can still continue with the state transition.
 */
async function updateMainMessage(
  channel: TextChannel,
  messageId: string | undefined,
  status: TicketStatus,
  topicOverride?: string,
): Promise<void> {
  if (!messageId) {
    return;
  }

  const config = await getGuildConfig(channel.guild.id);
  const topic = topicOverride ?? channel.topic ?? '';

  try {
    const message =
      channel.messages.cache.get(messageId) ??
      (await channel.messages.fetch(messageId));

    await message.edit({
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
  } catch (error) {
    console.error(
      `❌ Failed to update ticket panel for #${getField(topic, 'number') ?? 'Unknown'}:`,
      error,
    );
  }
}

/**
 * Builds permissions for an active ticket.
 *
 * Discord.js accepts these objects directly as OverwriteResolvable
 * values, so no PermissionOverwriteData type is required.
 */
function buildOpenOverwrites(
  channelOwnerId: string,
  staffRoleId: string | undefined,
  users: string[],
  botId: string,
  everyoneId: string,
) {
  const overwrites = [
    {
      id: everyoneId,
      deny: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: botId,
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

  const allow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];

  const ids = new Set<string>([
    channelOwnerId,
    ...(staffRoleId ? [staffRoleId] : []),
    ...users,
  ]);

  for (const id of ids) {
    if (!id || id === everyoneId || id === botId) {
      continue;
    }

    overwrites.push({
      id,
      allow,
    });
  }

  return overwrites;
}

/**
 * Builds permissions for closed/archived tickets.
 *
 * Closed:
 * - owner/users can view
 * - owner/users cannot send
 * - staff can view
 * - everyone cannot view
 *
 * Archived:
 * - owner/users lose access
 * - staff retain read-only access
 */
function buildClosedOverwrites(
  channelOwnerId: string | undefined,
  staffRoleId: string | null,
  users: string[],
  botId: string,
  everyoneId: string,
  archived: boolean,
) {
  const overwrites = [
    {
      id: everyoneId,
      deny: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: botId,
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

  const readOnly = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  const ids = new Set<string>([
    ...(channelOwnerId ? [channelOwnerId] : []),
    ...(staffRoleId ? [staffRoleId] : []),
    ...users,
  ]);

  for (const id of ids) {
    if (!id || id === everyoneId || id === botId) {
      continue;
    }

    if (archived && id !== staffRoleId) {
      overwrites.push({
        id,
        allow: [],
        deny: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });

      continue;
    }

    overwrites.push({
      id,
      allow: readOnly,
      deny: [PermissionFlagsBits.SendMessages],
    });
  }

  return overwrites;
}

/**
 * Restores normal ticket permissions after reopening.
 */
async function restoreTicketPermissions(
  channel: TextChannel,
  topic: string,
): Promise<void> {
  const bot = channel.guild.members.me;

  if (!bot) {
    throw new Error('Bot member unavailable.');
  }

  const ownerId = getField(topic, 'owner');

  if (!ownerId) {
    throw new Error('Ticket owner is missing.');
  }

  const staffRoleId = getField(topic, 'staff');

  const users = (getField(topic, 'users') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  await channel.permissionOverwrites.set(
    buildOpenOverwrites(
      ownerId,
      staffRoleId && staffRoleId !== 'none'
        ? staffRoleId
        : undefined,
      users,
      bot.id,
      channel.guild.roles.everyone.id,
    ),
  );
}

/**
 * Locks a ticket in one permission-overwrite operation.
 *
 * This intentionally uses .set() instead of multiple .edit() calls.
 */
async function lockTicketPermissions(
  channel: TextChannel,
  topic: string,
  archived = false,
): Promise<void> {
  const bot = channel.guild.members.me;

  if (!bot) {
    throw new Error('Bot member unavailable.');
  }

  const botPermissions = channel.permissionsFor(bot);

  if (
    !botPermissions?.has(
      PermissionFlagsBits.ManageChannels,
    )
  ) {
    throw new Error(
      'SupportForge is missing Manage Channels permission.',
    );
  }

  const ownerId = getField(topic, 'owner');

  const staffRoleId = getField(topic, 'staff');

  const users = (getField(topic, 'users') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  await channel.permissionOverwrites.set(
    buildClosedOverwrites(
      ownerId,
      staffRoleId && staffRoleId !== 'none'
        ? staffRoleId
        : null,
      users,
      bot.id,
      channel.guild.roles.everyone.id,
      archived,
    ),
  );
}

/**
 * Creates a new ticket.
 */
async function createTicket(
  interaction: ModalSubmitInteraction,
  departmentId: string,
): Promise<void> {
  const guild = interaction.guild!;

  const creationLockKey =
    `${guild.id}:${interaction.user.id}:${departmentId}`;

  if (ticketCreationLocks.has(creationLockKey)) {
    await replyError(
      interaction,
      '⏳ Your ticket request is already being processed.',
    );
    return;
  }

  ticketCreationLocks.add(creationLockKey);

  try {
    const config = await getGuildConfig(guild.id);

    const department =
      config.departments[departmentId];

    if (!department) {
      await replyError(
        interaction,
        '❌ This ticket department no longer exists.',
      );
      return;
    }

    const supportCategoryId =
      config.supportCategoryId;

    if (!supportCategoryId) {
      await replyError(
        interaction,
        '❌ SupportForge is not configured. Run `/supportforge setup` first.',
      );
      return;
    }

    const supportCategory =
      guild.channels.cache.get(supportCategoryId);

    if (
      !supportCategory ||
      supportCategory.type !== ChannelType.GuildCategory
    ) {
      await replyError(
        interaction,
        '❌ The SupportForge category is missing. Run `/supportforge setup` to repair it.',
      );
      return;
    }

    /**
     * Only active tickets block creation.
     *
     * Closed and archived tickets deliberately do NOT block a new ticket.
     */
    const existing = guild.channels.cache.find(
      (channel) => {
        if (
          channel.type !== ChannelType.GuildText ||
          channel.parentId !== supportCategoryId
        ) {
          return false;
        }

        const topic = channel.topic ?? '';

        if (!isTicketTopic(topic)) {
          return false;
        }

        if (
          getField(topic, 'owner') !==
          interaction.user.id
        ) {
          return false;
        }

        if (
          getField(topic, 'department') !==
          departmentId
        ) {
          return false;
        }

        const status =
          getRuntimeTicketState(channel).status;

        return isActiveTicketStatus(status);
      },
    );

    if (existing) {
      await replyError(
        interaction,
        `❌ You already have an active **${department.name}** ticket: ${existing}`,
      );
      return;
    }

    const subject =
      interaction.fields
        .getTextInputValue('subject')
        .trim();

    const description =
      interaction.fields
        .getTextInputValue('description')
        .trim();

    if (!subject || !description) {
      await replyError(
        interaction,
        '❌ Subject and description are required.',
      );
      return;
    }

    const ticketNumber =
      await allocateTicketNumber(guild.id);

    const openedAt =
      new Date().toISOString();

    const topic = [
      TICKET_PREFIX,
      'v=2',
      'status=open',
      `owner=${interaction.user.id}`,
      `department=${departmentId}`,
      `staff=${department.staffRoleId ?? 'none'}`,
      'priority=normal',
      'tags=',
      'users=',
      'claimed_by=',
      `subject=${encodeURIComponent(
        subject.replace(/\s+/g, ' '),
      )}`,
      `number=${ticketNumber}`,
      `opened_at=${openedAt}`,
      `description=${encodeURIComponent(
        description.replace(/\s+/g, ' '),
      )}`,
    ].join(' ');

    const botId =
      interaction.client.user!.id;

    const permissions =
      buildOpenOverwrites(
        interaction.user.id,
        department.staffRoleId ?? undefined,
        [],
        botId,
        guild.roles.everyone.id,
      );

    const ticketChannel =
      await guild.channels.create({
        name: `ticket-${ticketNumber}`,
        type: ChannelType.GuildText,
        parent: supportCategoryId,
        topic,
        permissionOverwrites: permissions,
      });

    try {
      const message =
        await ticketChannel.send({
          content: department.staffRoleId
            ? `${interaction.user} <@&${department.staffRoleId}>`
            : `${interaction.user}`,
          embeds: [
            buildTicketPanelEmbed(
              guild,
              ticketChannel.name,
              topic,
              config,
            ),
          ],
          components:
            buildTicketPanelComponents('open'),
        });

      const finalTopic =
        setField(
          topic,
          'message',
          message.id,
        );

      await ticketChannel.setTopic(
        finalTopic,
      );

      updateRuntimeTicketState(
        ticketChannel,
        finalTopic,
        'open',
      );

      await message.edit({
        embeds: [
          buildTicketPanelEmbed(
            guild,
            ticketChannel.name,
            finalTopic,
            config,
          ),
        ],
        components:
          buildTicketPanelComponents('open'),
      });

      /**
       * The description is already stored in the topic.
       * Send it visibly as the first ticket message as well.
       */
      await ticketChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('📝 Issue Description')
            .setDescription(description)
            .setFooter({
              text: `Ticket #${ticketNumber}`,
            })
            .setTimestamp(),
        ],
      });

      await interaction.editReply(
        `✅ Ticket created: ${ticketChannel}`,
      );

      if (
        isPremiumOrHigher(config.tier)
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
          },
        );
      }
    } catch (error) {
      await ticketChannel
        .delete(
          'SupportForge cleanup after ticket initialization failure',
        )
        .catch(() => undefined);

      throw error;
    }
  } finally {
    ticketCreationLocks.delete(
      creationLockKey,
    );
  }
}

/**
 * Performs a normal lifecycle transition.
 */
async function transition(
  interaction: ButtonInteraction,
  newStatus: TicketStatus,
  allowed: readonly TicketStatus[],
  successMessage: string,
): Promise<void> {
  const channel = interaction.channel;

  if (
    !channel ||
    channel.type !== ChannelType.GuildText
  ) {
    await replyError(
      interaction,
      '❌ This action can only be used inside a ticket channel.',
    );
    return;
  }

  if (
    ticketActionLocks.has(channel.id)
  ) {
    await replyError(
      interaction,
      '⏳ Another ticket action is currently being processed. Please wait a moment.',
    );
    return;
  }

  ticketActionLocks.add(channel.id);

  try {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    /**
     * Re-read current Discord topic state.
     * This is important because another process/manual change may
     * have modified the topic since the previous interaction.
     */
    const state =
      getRuntimeTicketState(channel);

    const topic = state.topic;

    if (!isTicketTopic(topic)) {
      await interaction.editReply(
        '❌ This channel is not a SupportForge ticket.',
      );
      return;
    }

    const currentStatus =
      getTicketStatus(topic);

    if (currentStatus !== state.status) {
      updateRuntimeTicketState(
        channel,
        topic,
        currentStatus,
      );
    }

    if (!allowed.includes(currentStatus)) {
      await interaction.editReply(
        `❌ This action is not available while the ticket is **${capitalize(currentStatus)}**.`,
      );
      return;
    }

    const context =
      getStaffContext(
        interaction,
        topic,
      );

    if (!context.authorized) {
      await interaction.editReply(
        '❌ Only configured staff or administrators can change ticket status.',
      );
      return;
    }

    let newTopic =
      setField(
        topic,
        'status',
        newStatus,
      );

    if (newStatus === 'claimed') {
      newTopic =
        setField(
          newTopic,
          'claimed_by',
          interaction.user.id,
        );

      newTopic =
        setField(
          newTopic,
          'claimed_at',
          new Date().toISOString(),
        );

      newTopic =
        removeField(
          newTopic,
          'pending_since',
        );
    }

    if (newStatus === 'open') {
      newTopic =
        removeField(
          newTopic,
          'claimed_by',
        );

      newTopic =
        removeField(
          newTopic,
          'claimed_at',
        );

      newTopic =
        removeField(
          newTopic,
          'pending_since',
        );
    }

    if (newStatus === 'pending') {
      newTopic =
        setField(
          newTopic,
          'pending_since',
          new Date().toISOString(),
        );

      newTopic =
        removeField(
          newTopic,
          'claimed_by',
        );

      newTopic =
        removeField(
          newTopic,
          'claimed_at',
        );
    }

    if (newStatus === 'reopened') {
      newTopic =
        setField(
          newTopic,
          'reopened_at',
          new Date().toISOString(),
        );

      newTopic =
        removeField(
          newTopic,
          'closed_at',
        );

      newTopic =
        removeField(
          newTopic,
          'claimed_by',
        );

      newTopic =
        removeField(
          newTopic,
          'claimed_at',
        );

      newTopic =
        removeField(
          newTopic,
          'pending_since',
        );

      await restoreTicketPermissions(
        channel,
        topic,
      );

      if (
        channel.name.endsWith(
          '-closed',
        )
      ) {
        const reopenedName =
          channel.name.slice(
            0,
            -7,
          );

        await queueTicketChannelRename(
          channel,
          reopenedName,
          `SupportForge reopen for ticket #${
            getField(topic, 'number') ??
            'Unknown'
          }`,
        );
      }
    }

    if (newStatus === 'archived') {
      newTopic =
        setField(
          newTopic,
          'archived_at',
          new Date().toISOString(),
        );

      await lockTicketPermissions(
        channel,
        topic,
        true,
      );
    }

    await channel.setTopic(
      newTopic,
    );

    updateRuntimeTicketState(
      channel,
      newTopic,
      newStatus,
    );

    const messageId =
      getField(
        newTopic,
        'message',
      );

    await updateMainMessage(
      channel,
      messageId,
      newStatus,
      newTopic,
    );

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(
            `${emojiForStatus(
              newStatus,
            )} Ticket ${capitalize(
              newStatus,
            )}`,
          )
          .setDescription(
            `${interaction.user} changed the ticket status to **${capitalize(
              newStatus,
            )}**.`,
          )
          .setTimestamp(),
      ],
    });

    const config =
      await getGuildConfig(
        interaction.guild!.id,
      );

    if (
      isPremiumOrHigher(
        config.tier,
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
              'number',
            ) ?? 'Unknown',
          event:
            `Status → ${newStatus}`,
          actor:
            interaction.user.tag,
        },
      );
    }

    await interaction.editReply(
      `✅ ${successMessage}`,
    );
  } catch (error) {
    console.error(
      `❌ Ticket transition failed: ${newStatus}`,
      error,
    );

    clearRuntimeTicketState(
      channel.id,
    );

    await interaction
      .editReply(
        '❌ The ticket status could not be changed. Check the bot console.',
      )
      .catch(() => undefined);
  } finally {
    ticketActionLocks.delete(
      channel.id,
    );
  }
}

/**
 * Closes a ticket:
 *
 * 1. Generate transcript
 * 2. Upload transcript
 * 3. Lock permissions in one operation
 * 4. Mark topic as closed
 * 5. Update panel
 * 6. Announce closure
 * 7. Audit
 * 8. Rename channel
 */
async function closeTicket(
  interaction: ButtonInteraction,
): Promise<void> {
  const channel = interaction.channel;

  if (
    !channel ||
    channel.type !== ChannelType.GuildText
  ) {
    await replyError(
      interaction,
      '❌ This action can only be used inside a ticket channel.',
    );
    return;
  }

  if (
    ticketActionLocks.has(channel.id)
  ) {
    await replyError(
      interaction,
      '⏳ Another ticket action is currently being processed. Please wait a moment.',
    );
    return;
  }

  ticketActionLocks.add(channel.id);

  try {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    const state =
      getRuntimeTicketState(channel);

    const topic = state.topic;

    if (!isTicketTopic(topic)) {
      await interaction.editReply(
        '❌ This is not a SupportForge ticket.',
      );
      return;
    }

    /**
     * Closed and archived tickets cannot be closed again.
     */
    if (
      isTerminalTicketStatus(
        state.status,
      )
    ) {
      await interaction.editReply(
        'ℹ️ This ticket is already closed or archived.',
      );
      return;
    }

    const context =
      getStaffContext(
        interaction,
        topic,
      );

    const isOwner =
      context.ownerId ===
      interaction.user.id;

    if (
      !isOwner &&
      !context.authorized
    ) {
      await interaction.editReply(
        '❌ Only the ticket owner, configured staff, or an administrator can close this ticket.',
      );
      return;
    }

    const config =
      await getGuildConfig(
        interaction.guild!.id,
      );

    if (!config.supportCategoryId) {
      await interaction.editReply(
        '❌ SupportForge configuration is missing.',
      );
      return;
    }

    const transcriptChannel =
      config.transcriptChannelId
        ? interaction.guild!.channels.cache.get(
            config.transcriptChannelId,
          )
        : null;

    if (
      !transcriptChannel ||
      transcriptChannel.type !==
        ChannelType.GuildText
    ) {
      await interaction.editReply(
        '❌ The transcript channel is missing. Run `/supportforge setup` to repair SupportForge.',
      );
      return;
    }

    const ticketNumber =
      getField(
        topic,
        'number',
      ) ?? 'Unknown';

    const ownerId =
      context.ownerId ??
      'Unknown';

    const subject =
      decodeSubject(
        getField(
          topic,
          'subject',
        ),
      );

    const messageId =
      getField(
        topic,
        'message',
      );

    const openedAt =
      channel.createdAt;

    const closedAt =
      new Date();

    let ownerName =
      ownerId;

    if (ownerId !== 'Unknown') {
      try {
        const owner =
          interaction.guild!.members.cache.get(
            ownerId,
          ) ??
          await interaction.guild!.members.fetch(
            ownerId,
          );

        ownerName =
          owner.displayName;
      } catch {
        ownerName =
          ownerId;
      }
    }

    console.time(
      `CLOSE_TRANSCRIPT_${channel.id}`,
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
    } finally {
      console.timeEnd(
        `CLOSE_TRANSCRIPT_${channel.id}`,
      );
    }

    /**
     * Upload transcript before modifying the ticket.
     *
     * If transcript upload fails, the ticket remains active instead
     * of being silently converted into a closed ticket without a transcript.
     */
    await transcriptChannel.send({
      content:
        `📄 **Ticket #${ticketNumber} Transcript**\n` +
        `**Subject:** ${subject}\n` +
        `**Owner:** <@${ownerId}>\n` +
        `**Closed by:** ${interaction.user}`,
      files: [transcript],
    });

    /**
     * One permission-overwrite PATCH.
     */
    await lockTicketPermissions(
      channel,
      topic,
      false,
    );

    let closedTopic =
      setField(
        topic,
        'status',
        'closed',
      );

    closedTopic =
      setField(
        closedTopic,
        'closed_at',
        closedAt.toISOString(),
      );

    await channel.setTopic(
      closedTopic,
    );

    updateRuntimeTicketState(
      channel,
      closedTopic,
      'closed',
    );

    await interaction.editReply(
      `✅ Ticket #${ticketNumber} is closed and locked. Transcript saved to ${transcriptChannel}.`,
    );

    /**
     * Non-critical post-close operations run independently.
     *
     * A failed rename or panel update should not make the user wait
     * for the ticket closure itself.
     */
    const auditPromise =
      isPremiumOrHigher(
        config.tier,
      ) &&
      config.supportCategoryId
        ? logTicketEvent(
            interaction.guild!,
            config.supportCategoryId,
            {
              ticketNumber,
              event:
                'Ticket closed',
              actor:
                interaction.user.tag,
            },
          )
        : Promise.resolve();

    const buttonPromise =
      updateMainMessage(
        channel,
        messageId,
        'closed',
        closedTopic,
      );

    const closeMessagePromise =
      channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(
              '🔒 Ticket Closed',
            )
            .setDescription(
              `This ticket was closed by ${interaction.user}.\n\n📄 Transcript saved to ${transcriptChannel}.`,
            )
            .setTimestamp(),
        ],
      });

    const renamePromise =
      queueTicketChannelRename(
        channel,
        channel.name.endsWith(
          '-closed',
        )
          ? channel.name
          : `${channel.name}-closed`,
        `SupportForge close for ticket #${ticketNumber}`,
      );

    void Promise.allSettled([
      auditPromise,
      buttonPromise,
      closeMessagePromise,
      renamePromise,
    ]).then((results) => {
      results.forEach(
        (result, index) => {
          if (
            result.status ===
            'rejected'
          ) {
            const labels = [
              'audit',
              'buttons',
              'announcement',
              'rename',
            ];

            console.error(
              `❌ Background close ${labels[index]} failed for #${ticketNumber}:`,
              result.reason,
            );
          }
        },
      );
    });
  } catch (error) {
    console.error(
      '❌ Ticket close operation failed:',
      error,
    );

    clearRuntimeTicketState(
      channel.id,
    );

    await interaction
      .editReply(
        '❌ The ticket could not be closed. Check the bot console for details.',
      )
      .catch(() => undefined);
  } finally {
    ticketActionLocks.delete(
      channel.id,
    );
  }
}

/**
 * Handles buttons belonging to the newer ticket control panel.
 */
async function handlePanelButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const channel =
    interaction.channel;

  if (
    !channel ||
    channel.type !== ChannelType.GuildText
  ) {
    await replyError(
      interaction,
      '❌ This action can only be used inside a ticket channel.',
    );
    return;
  }

  const state =
    getRuntimeTicketState(channel);

  if (
    !isTicketTopic(
      state.topic,
    )
  ) {
    await replyError(
      interaction,
      '❌ This channel is not a SupportForge ticket.',
    );
    return;
  }

  const context =
    getStaffContext(
      interaction,
      state.topic,
    );

  if (!context.authorized) {
    await replyError(
      interaction,
      '❌ Only configured staff or administrators can use ticket management controls.',
    );
    return;
  }

  const action =
    interaction.customId.split(':')[2];

  const config =
    await getGuildConfig(
      interaction.guild!.id,
    );

  if (
    ['priority', 'tag', 'note'].includes(
      action,
    ) &&
    !isPremiumOrHigher(
      config.tier,
    )
  ) {
    await interaction.reply({
      content:
        '🔒 This feature is available in Premium/Pro demo mode. Run `/supportforge premium toggle-demo` as an administrator to preview it.',
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  if (action === 'add-user') {
    const modal =
      new ModalBuilder()
        .setCustomId(
          'ticket:panel-modal:add-user',
        )
        .setTitle(
          'Add User to Ticket',
        );

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(
          new TextInputBuilder()
            .setCustomId('user')
            .setLabel(
              'User ID or @mention',
            )
            .setStyle(
              TextInputStyle.Short,
            )
            .setRequired(true)
            .setMaxLength(30),
        ),
    );

    await interaction.showModal(
      modal,
    );

    return;
  }

  if (action === 'priority') {
    const modal =
      new ModalBuilder()
        .setCustomId(
          'ticket:panel-modal:priority',
        )
        .setTitle(
          'Set Ticket Priority',
        );

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(
          new TextInputBuilder()
            .setCustomId('level')
            .setLabel(
              'low / normal / high / urgent / critical',
            )
            .setStyle(
              TextInputStyle.Short,
            )
            .setRequired(true)
            .setMaxLength(10),
        ),
    );

    await interaction.showModal(
      modal,
    );

    return;
  }

  if (action === 'tag') {
    const modal =
      new ModalBuilder()
        .setCustomId(
          'ticket:panel-modal:tag',
        )
        .setTitle(
          'Add Ticket Tag',
        );

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(
          new TextInputBuilder()
            .setCustomId('name')
            .setLabel('Tag name')
            .setStyle(
              TextInputStyle.Short,
            )
            .setRequired(true)
            .setMaxLength(30),
        ),
    );

    await interaction.showModal(
      modal,
    );

    return;
  }

  if (action === 'note') {
    const modal =
      new ModalBuilder()
        .setCustomId(
          'ticket:panel-modal:note',
        )
        .setTitle(
          'Add Internal Note',
        );

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(
          new TextInputBuilder()
            .setCustomId('text')
            .setLabel(
              'Internal staff note',
            )
            .setStyle(
              TextInputStyle.Paragraph,
            )
            .setRequired(true)
            .setMaxLength(500),
        ),
    );

    await interaction.showModal(
      modal,
    );

    return;
  }

  if (action === 'history') {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    const auditId =
      config.auditChannelId;

    const audit =
      auditId
        ? interaction.guild!.channels.cache.get(
            auditId,
          )
        : null;

    if (
      !audit ||
      audit.type !==
        ChannelType.GuildText
    ) {
      await interaction.editReply(
        'ℹ️ No audit history exists for this ticket yet.',
      );

      return;
    }

    const ticketNumber =
      getField(
        state.topic,
        'number',
      ) ?? 'Unknown';

    const messages =
      await audit.messages.fetch({
        limit: 50,
      });

    const matching =
      messages
        .filter((message) =>
          message.embeds.some(
            (embed) =>
              embed.description?.includes(
                `Ticket #${ticketNumber}`,
              ),
          ),
        )
        .first(10);

    const lines =
      matching.length
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
      `📜 **Recent history for ticket #${ticketNumber}**\n\n${lines}`,
    );
  }
}

/**
 * Handles modal submissions originating from the control panel.
 */
async function handlePanelModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const channel =
    interaction.channel;

  if (
    !channel ||
    channel.type !== ChannelType.GuildText
  ) {
    await replyError(
      interaction,
      '❌ This action can only be used inside a ticket channel.',
    );
    return;
  }

  const state =
    getRuntimeTicketState(channel);

  if (
    !isTicketTopic(
      state.topic,
    )
  ) {
    await replyError(
      interaction,
      '❌ This channel is not a SupportForge ticket.',
    );
    return;
  }

  const context =
    getStaffContext(
      interaction,
      state.topic,
    );

  if (!context.authorized) {
    await replyError(
      interaction,
      '❌ Only configured staff or administrators can use ticket management controls.',
    );
    return;
  }

  const config =
    await getGuildConfig(
      interaction.guild!.id,
    );

  const action =
    interaction.customId.split(':')[2];

  if (
    ['priority', 'tag', 'note'].includes(
      action,
    ) &&
    !isPremiumOrHigher(
      config.tier,
    )
  ) {
    await replyError(
      interaction,
      '🔒 This feature is available in Premium/Pro demo mode.',
    );

    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  /**
   * Do not allow management changes to an archived ticket.
   */
  if (
    state.status === 'archived'
  ) {
    await interaction.editReply(
      '❌ Archived tickets cannot be modified.',
    );

    return;
  }

  if (action === 'add-user') {
    const raw =
      interaction.fields
        .getTextInputValue(
          'user',
        )
        .trim();

    const userId =
      parseUserId(raw);

    if (!userId) {
      await interaction.editReply(
        '❌ Enter a valid Discord user ID or @mention.',
      );

      return;
    }

    const currentUsers =
      new Set(
        (
          getField(
            state.topic,
            'users',
          ) ?? ''
        )
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      );

    currentUsers.add(
      userId,
    );

    await channel.permissionOverwrites.edit(
      userId,
      {
        ViewChannel: true,
        SendMessages:
          state.status !== 'closed',
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
      },
    );

    let topic =
      setField(
        state.topic,
        'users',
        [...currentUsers].join(','),
      );

    await channel.setTopic(
      topic,
    );

    updateRuntimeTicketState(
      channel,
      topic,
      getTicketStatus(topic),
    );

    await updateMainMessage(
      channel,
      getField(
        topic,
        'message',
      ),
      getTicketStatus(topic),
      topic,
    );

    await channel.send(
      `➕ <@${userId}> was added by ${interaction.user}.`,
    );

    await interaction.editReply(
      `✅ <@${userId}> now has access to ticket #${
        getField(
          topic,
          'number',
        ) ?? 'Unknown'
      }.`,
    );

    return;
  }

  if (action === 'priority') {
    const level =
      interaction.fields
        .getTextInputValue(
          'level',
        )
        .trim()
        .toLowerCase();

    const priorities =
      new Set([
        'low',
        'normal',
        'high',
        'urgent',
        'critical',
      ]);

    if (!priorities.has(level)) {
      await interaction.editReply(
        '❌ Invalid priority. Use low, normal, high, urgent, or critical.',
      );

      return;
    }

    const topic =
      setField(
        state.topic,
        'priority',
        level,
      );

    await channel.setTopic(
      topic,
    );

    updateRuntimeTicketState(
      channel,
      topic,
      getTicketStatus(topic),
    );

    await updateMainMessage(
      channel,
      getField(
        topic,
        'message',
      ),
      getTicketStatus(topic),
      topic,
    );

    const baseName =
      channel.name.replace(
        /^[🟢⚪🟠🔴🟣]\s*/u,
        '',
      );

    const emoji =
      ({
        low: '🟢',
        normal: '',
        high: '🟠',
        urgent: '🔴',
        critical: '🟣',
      } as Record<
        string,
        string
      >)[level];

    await queueTicketChannelRename(
      channel,
      level === 'normal'
        ? baseName
        : `${emoji}${baseName}`,
      `SupportForge priority changed to ${level}`,
    );

    await interaction.editReply(
      `✅ Ticket #${
        getField(
          topic,
          'number',
        ) ?? 'Unknown'
      } priority is now **${level}**.`,
    );

    return;
  }

  if (action === 'tag') {
    const value =
      interaction.fields
        .getTextInputValue(
          'name',
        )
        .trim()
        .toLowerCase()
        .replace(
          /\s+/g,
          '-',
        );

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
            state.topic,
            'tags',
          ) ?? ''
        )
          .split(',')
          .map((tag) => tag.trim())
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
        state.topic,
        'tags',
        [...tags].join(','),
      );

    await channel.setTopic(
      topic,
    );

    updateRuntimeTicketState(
      channel,
      topic,
      getTicketStatus(topic),
    );

    await updateMainMessage(
      channel,
      getField(
        topic,
        'message',
      ),
      getTicketStatus(topic),
      topic,
    );

    await channel.send(
      `🏷️ Tag \`${value}\` added by ${interaction.user}.`,
    );

    await interaction.editReply(
      `✅ Added tag \`${value}\`.`,
    );

    return;
  }

  if (action === 'note') {
    if (!config.supportCategoryId) {
      await interaction.editReply(
        '❌ SupportForge category configuration is missing.',
      );

      return;
    }

    const text =
      interaction.fields
        .getTextInputValue(
          'text',
        )
        .trim();

    const audit =
      await getOrCreateAuditChannel(
        interaction.guild!,
        config.supportCategoryId,
      );

    await audit.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(
            `🔒 Internal note • Ticket #${
              getField(
                state.topic,
                'number',
              ) ?? 'Unknown'
            }`,
          )
          .setDescription(
            text,
          )
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

  await interaction.editReply(
    '❌ Unsupported ticket panel action.',
  );
}

/**
 * Main ticket interaction router.
 */
export async function handleTicketInteraction(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await replyError(
      interaction,
      '❌ This feature is only available inside a server.',
    );

    return;
  }

  /**
   * Ticket creation button.
   */
  if (
    interaction.isButton() &&
    interaction.customId.startsWith(
      'ticket:create:',
    )
  ) {
    const departmentId =
      interaction.customId.split(':')[2];

    const modal =
      new ModalBuilder()
        .setCustomId(
          `ticket:modal:${departmentId}`,
        )
        .setTitle(
          'Create Support Ticket',
        );

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(
          new TextInputBuilder()
            .setCustomId(
              'subject',
            )
            .setLabel(
              'Subject',
            )
            .setStyle(
              TextInputStyle.Short,
            )
            .setRequired(true)
            .setMaxLength(100),
        ),

      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(
          new TextInputBuilder()
            .setCustomId(
              'description',
            )
            .setLabel(
              'Describe the issue',
            )
            .setStyle(
              TextInputStyle.Paragraph,
            )
            .setRequired(true)
            .setMaxLength(1500),
        ),
    );

    await interaction.showModal(
      modal,
    );

    return;
  }

  /**
   * Ticket creation modal.
   */
  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith(
      'ticket:modal:',
    )
  ) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    try {
      await createTicket(
        interaction,
        interaction.customId.split(':')[2],
      );
    } catch (error) {
      console.error(
        '❌ Ticket creation failed:',
        error,
      );

      await interaction
        .editReply(
          '❌ The ticket could not be created. Check the bot permissions and console.',
        )
        .catch(() => undefined);
    }

    return;
  }

  /**
   * New control-panel buttons.
   */
  if (
    interaction.isButton() &&
    isPanelButton(interaction)
  ) {
    await handlePanelButton(
      interaction,
    );

    return;
  }

  /**
   * New control-panel modals.
   */
  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith(
      'ticket:panel-modal:',
    )
  ) {
    await handlePanelModal(
      interaction,
    );

    return;
  }

  if (!interaction.isButton()) {
    return;
  }

  /**
   * Legacy/core lifecycle buttons.
   */
  switch (interaction.customId) {
    case 'ticket:close':
      await closeTicket(
        interaction,
      );
      return;

    case 'ticket:claim':
      await transition(
        interaction,
        'claimed',
        ['open', 'reopened'],
        `Ticket #${
          getField(
            interaction.channel &&
              interaction.channel.type ===
                ChannelType.GuildText
              ? interaction.channel.topic ??
                ''
              : '',
            'number',
          ) ?? 'Unknown'
        } has been claimed.`,
      );
      return;

    case 'ticket:unclaim':
      await transition(
        interaction,
        'open',
        ['claimed'],
        'The ticket has been returned to the open queue.',
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
        'The ticket is now pending.',
      );
      return;

    case 'ticket:resume':
      await transition(
        interaction,
        'open',
        ['pending'],
        'The ticket has been resumed and is now open.',
      );
      return;

    case 'ticket:reopen':
      await transition(
        interaction,
        'reopened',
        ['closed'],
        'The ticket has been reopened.',
      );
      return;

    case 'ticket:archive':
      await transition(
        interaction,
        'archived',
        ['closed'],
        'The ticket has been archived.',
      );
      return;

    default:
      return;
  }
}

/**
 * Status → display emoji.
 */
function emojiForStatus(
  status: TicketStatus,
): string {
  const emojis: Record<
    TicketStatus,
    string
  > = {
    open: '🟢',
    claimed: '🙋',
    pending: '⏳',
    closed: '🔒',
    reopened: '🔓',
    archived: '🗄️',
  };

  return emojis[status];
}

/**
 * Capitalizes a status for human-readable messages.
 */
function capitalize(
  value: string,
): string {
  return (
    value.charAt(0).toUpperCase() +
    value.slice(1)
  );
}