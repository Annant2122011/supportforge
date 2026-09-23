import {
  ActionRowBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  type Message,
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
  setChannelPermissionOverwrite,
  setChannelTopic,
} from '../services/discordChannelService';

import {
  ensureArchiveCategory,
  ensureBillingCategory,
  ensureClosedCategory,
  moveTicketToCategory,
} from '../services/ticketStorageService';

import { resetPanelActivity } from '../services/panelActivityService';

import {
  getPersistedTicketStatus,
  setPersistedTicketStatus,
} from '../services/ticketPersistenceService';

import {
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
  getTicketChannelName,
  isPanelButton,
  moveTicketPanelToBottom,
  queueTicketChannelRename,
} from '../services/ticketPanelService';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DISCORD_OPERATION_TIMEOUT_MS = 15_000;
const TRANSCRIPT_TIMEOUT_MS = 60_000;

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

/* -------------------------------------------------------------------------- */
/* Runtime state                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Prevents two state-changing operations from modifying the same ticket
 * simultaneously.
 */
const ticketActionLocks = new Set<string>();

const ticketMutationQueues = new Map<string, Promise<void>>();
async function runChannelMutation<T>(
  channel: TextChannel,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous =
    ticketMutationQueues.get(channel.id) ??
    Promise.resolve();

  let release!: () => void;

  const gate =
    new Promise<void>((resolve) => {
      release = resolve;
    });

  const current =
    previous.then(() => gate);

  ticketMutationQueues.set(
    channel.id,
    current,
  );

  /*
   * Wait for the previous mutation, but never let a broken Discord REST
   * request hold the entire ticket queue hostage forever.
   */
  await previous;

  try {
    console.log(
      `🔧 Ticket mutation: ${operation} [${channel.id}]`,
    );

    return await withTimeout(
      action(),
      DISCORD_OPERATION_TIMEOUT_MS,
      operation,
    );
  } finally {
    release();

    if (
      ticketMutationQueues.get(
        channel.id,
      ) === current
    ) {
      ticketMutationQueues.delete(
        channel.id,
      );
    }
  }
}

/**
 * Prevents duplicate ticket creation requests from the same user for the
 * same department.
 */
const ticketCreationLocks = new Set<string>();

interface RuntimeTicketState {
  topic: string;
  status: TicketStatus;
  updatedAt: number;
}

const ticketRuntimeCache = new Map<string, RuntimeTicketState>();

/* -------------------------------------------------------------------------- */
/* Status helpers                                                             */
/* -------------------------------------------------------------------------- */

function isActiveTicketStatus(
  status: TicketStatus,
): boolean {
  return ACTIVE_TICKET_STATUSES.includes(status);
}

function isTerminalTicketStatus(
  status: TicketStatus,
): boolean {
  return TERMINAL_TICKET_STATUSES.includes(status);
}

/* -------------------------------------------------------------------------- */
/* Timeout helper                                                             */
/* -------------------------------------------------------------------------- */

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>(
    (_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `${operation} timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
    },
  );

  try {
    return await Promise.race([
      promise,
      timeout,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Runtime ticket state                                                       */
/* -------------------------------------------------------------------------- */

function getRuntimeTicketState(
  channel: TextChannel,
): RuntimeTicketState {
  const topic = channel.topic ?? '';

  const cached = ticketRuntimeCache.get(
    channel.id,
  );

  /*
   * If the topic has not changed, the cached state is authoritative.
   */
  if (
    cached &&
    cached.topic === topic
  ) {
    return cached;
  }

  const state: RuntimeTicketState = {
    topic,
    status: getTicketStatus(topic),
    updatedAt: Date.now(),
  };

  ticketRuntimeCache.set(
    channel.id,
    state,
  );

  return state;
}

function updateRuntimeTicketState(
  channel: TextChannel,
  topic: string,
  status: TicketStatus,
): void {
  ticketRuntimeCache.set(
    channel.id,
    {
      topic,
      status,
      updatedAt: Date.now(),
    },
  );
}

function clearRuntimeTicketState(
  channelId: string,
): void {
  ticketRuntimeCache.delete(
    channelId,
  );
}

/* -------------------------------------------------------------------------- */
/* Interaction helpers                                                        */
/* -------------------------------------------------------------------------- */

function isAdmin(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
): boolean {
  return Boolean(
    interaction.memberPermissions?.has(
      PermissionFlagsBits.Administrator,
    ),
  );
}

function getStaffContext(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
  topic: string,
) {
  const ownerId =
    getField(
      topic,
      'owner',
    );

  const rawStaffRole =
    getField(
      topic,
      'staff',
    );

  const staffRole =
    rawStaffRole &&
    rawStaffRole !== 'none'
      ? rawStaffRole
      : null;

  let isStaff = false;

  if (
    staffRole &&
    interaction.member &&
    'roles' in interaction.member
  ) {
    const roles =
      interaction.member.roles;

    if (Array.isArray(roles)) {
      isStaff =
        roles.includes(
          staffRole,
        );
    } else {
      isStaff =
        roles.cache.has(
          staffRole,
        );
    }
  }

  const admin =
    isAdmin(
      interaction,
    );

  return {
    ownerId,
    staffRole,
    isStaff,
    isAdmin: admin,
    authorized:
      isStaff ||
      admin,
  };
}

/**
 * Safely acknowledge a reply/error.
 *
 * This function deliberately does not attempt a second acknowledgement.
 * Discord interactions can only be acknowledged once.
 */
async function replyError(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  try {
    if (
      interaction.deferred &&
      !interaction.replied
    ) {
      await interaction.editReply(
        content,
      );
      return;
    }

    if (
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content,
        flags:
          MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    console.error(
      '❌ Failed to send interaction error:',
      error,
    );
  }
}

async function safeDeferReply(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
): Promise<boolean> {
  if (
    interaction.deferred ||
    interaction.replied
  ) {
    return true;
  }

  try {
    await interaction.deferReply({
      flags:
        MessageFlags.Ephemeral,
    });

    return true;
  } catch (error) {
    console.error(
      '❌ Failed to acknowledge interaction:',
      error,
    );

    return false;
  }
}

function decodeSubject(
  value: string | undefined,
): string {
  if (!value) {
    return 'Unknown subject';
  }

  try {
    return decodeURIComponent(
      value,
    );
  } catch {
    return value;
  }
}

function parseUserId(
  value: string,
): string | null {
  const mention =
    value.match(
      /^<@!?([0-9]+)>$/,
    );

  if (mention) {
    return mention[1];
  }

  const id =
    value.match(
      /^([0-9]{15,25})$/,
    );

  return id?.[1] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Ticket panel                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Refreshes the original ticket panel.
 *
 * IMPORTANT:
 * We do NOT temporarily disable the panel here.
 *
 * The previous implementation could do:
 *
 *   state update
 *   -> disabled panel edit
 *   -> active panel edit
 *
 * in different asynchronous operations. If Discord completed the disabled
 * edit last, the buttons stayed disabled permanently.
 *
 * The panel is now rendered only from the committed ticket state.
 */
async function updateMainMessage(
  channel: TextChannel,
  messageId: string | undefined,
  status: TicketStatus,
  topic: string,
): Promise<void> {
  if (!messageId) {
    return;
  }

  try {
    const config =
      await withTimeout(
        getGuildConfig(
          channel.guild.id,
        ),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Guild configuration load',
      );

    let message;
    try {
      message =
        channel.messages.cache.get(messageId) ??
        await withTimeout(
          channel.messages.fetch(messageId),
          DISCORD_OPERATION_TIMEOUT_MS,
          'Ticket panel fetch',
        );
    } catch {
      /*
       * Closed-ticket controls are moved to the bottom as a new message.
       * The historical message= topic field intentionally remains stable,
       * so recover the current panel by scanning recent messages.
       */
      const recent = await withTimeout(
        channel.messages.fetch({ limit: 100 }),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Recent ticket panel search',
      );

      const ticketNumber =
        getField(topic, 'number') ?? 'unknown';

      message = recent.find(
        (candidate) =>
          candidate.author.id === channel.client.user?.id &&
          candidate.embeds.some(
            (embed) =>
              embed.title ===
              `🎫 SupportForge Ticket #${ticketNumber}`,
          ),
      );
    }

    if (!message) {
      return;
    }

    /*
     * Before editing, verify that the topic still represents the state
     * that this update was created for.
     *
     * This prevents an older asynchronous panel refresh from overwriting
     * a newer ticket state.
     */
    const currentTopic =
      channel.topic ?? '';

    const currentTopicStatus =
      getTicketStatus(
        currentTopic,
      );

    const persistedStatus =
      await getPersistedTicketStatus(
        channel.id,
      );

    /*
     * Lifecycle status may now be newer than the Discord channel topic.
     * When persisted state exists, use it for stale-update protection.
     * For legacy tickets without persisted state, retain the original
     * topic comparison.
     */
    if (persistedStatus) {
      if (persistedStatus !== status) {
        return;
      }
    } else if (
      currentTopic !== topic ||
      currentTopicStatus !== status
    ) {
      return;
    }

    await withTimeout(
      message.edit({
        embeds: [
          buildTicketPanelEmbed(
            channel.guild,
            channel.name,
            topic,
            config,
          ),
        ],
        components:
          buildTicketPanelComponents(
            status,
          ),
      }),
      DISCORD_OPERATION_TIMEOUT_MS,
      'Ticket panel update',
    );
  } catch (error) {
    console.error(
      '⚠️ Failed to update ticket panel:',
      error,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Permission builders                                                        */
/* -------------------------------------------------------------------------- */

function buildOpenOverwrites(
  ownerId: string,
  staffRoleId: string | undefined,
  users: string[],
  botId: string,
  everyoneId: string,
) {
  const overwrites: Array<{
    id: string;
    allow?: bigint[];
    deny?: bigint[];
  }> = [
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

  const ids =
    new Set<string>([
      ownerId,
      ...(staffRoleId
        ? [staffRoleId]
        : []),
      ...users,
    ]);

  for (const id of ids) {
    if (
      !id ||
      id === everyoneId ||
      id === botId
    ) {
      continue;
    }

    overwrites.push({
      id,
      allow,
    });
  }

  return overwrites;
}

/* -------------------------------------------------------------------------- */
/* Ticket creation                                                            */
/* -------------------------------------------------------------------------- */

async function createTicket(
  interaction: ModalSubmitInteraction,
  departmentId: string,
): Promise<void> {
  if (
    !(await safeDeferReply(
      interaction,
    ))
  ) {
    return;
  }

  if (!interaction.guild) {
    await replyError(
      interaction,
      '❌ This action must be used inside a server.',
    );
    return;
  }

  const guild =
    interaction.guild;

  const lockKey =
    `${guild.id}:${interaction.user.id}:${departmentId}`;

  if (
    ticketCreationLocks.has(
      lockKey,
    )
  ) {
    await replyError(
      interaction,
      '⏳ Your ticket request is already being processed.',
    );
    return;
  }

  ticketCreationLocks.add(
    lockKey,
  );

  let ticketChannel:
    | TextChannel
    | undefined;

  try {
    const config =
      await withTimeout(
        getGuildConfig(
          guild.id,
        ),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Guild configuration load',
      );

    const department =
      config.departments[
        departmentId
      ];

    if (!department) {
      await replyError(
        interaction,
        '❌ This ticket department no longer exists.',
      );
      return;
    }

    const isBillingDepartment =
      department.name.trim().toLowerCase() === 'billing';

    let categoryId = config.supportCategoryId;

    if (isBillingDepartment) {
      categoryId = (await ensureBillingCategory(guild)).id;
    }

    if (!categoryId) {
      await replyError(
        interaction,
        '❌ SupportForge is not configured. Run `/supportforge setup` first.',
      );
      return;
    }

    const category =
      guild.channels.cache.get(categoryId);

    if (
      !category ||
      category.type !== ChannelType.GuildCategory
    ) {
      await replyError(
        interaction,
        '❌ The SupportForge category is missing. Run `/supportforge setup` to repair it.',
      );
      return;
    }

    /*
     * Only active tickets block creation.
     * Closed and archived tickets do not.
     */
    let existing: TextChannel | undefined;

    for (const channel of guild.channels.cache.values()) {
      if (
        channel.type !== ChannelType.GuildText ||
        channel.parentId !== categoryId
      ) {
        continue;
      }

      const topic = channel.topic ?? '';

      if (
        !isTicketTopic(topic) ||
        getField(topic, 'owner') !== interaction.user.id ||
        getField(topic, 'department') !== departmentId
      ) {
        continue;
      }

      const persistedStatus =
        await getPersistedTicketStatus(channel.id);

      const status =
        persistedStatus ??
        getTicketStatus(topic);

      if (isActiveTicketStatus(status)) {
        existing = channel;
        break;
      }
    }

    if (existing) {
      await replyError(
        interaction,
        `❌ You already have an active **${department.name}** ticket: ${existing}`,
      );
      return;
    }

    const subject =
      interaction.fields
        .getTextInputValue(
          'subject',
        )
        .trim();

    const description =
      interaction.fields
        .getTextInputValue(
          'description',
        )
        .trim();

    if (
      !subject ||
      !description
    ) {
      await replyError(
        interaction,
        '❌ Subject and description are required.',
      );
      return;
    }

    const number =
      await withTimeout(
        allocateTicketNumber(
          guild.id,
        ),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Ticket number allocation',
      );

    const now =
      new Date().toISOString();

    const cleanSubject =
      subject.replace(
        /\s+/g,
        ' ',
      );

    const cleanDescription =
      description.replace(
        /\s+/g,
        ' ',
      );

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
        cleanSubject,
      )}`,
      `number=${number}`,
      `opened_at=${now}`,
    ].join(' ');

    const bot =
      guild.members.me;

    if (!bot) {
      throw new Error(
        'SupportForge bot member could not be resolved.',
      );
    }

    const overwrites =
      buildOpenOverwrites(
        interaction.user.id,
        department.staffRoleId ??
          undefined,
        [],
        bot.id,
        guild.roles.everyone.id,
      );

    try {
      ticketChannel =
        (await withTimeout(
          guild.channels.create({
            name:
              getTicketChannelName(
                String(number).padStart(4, '0'),
                'open',
              ),
            type:
              ChannelType.GuildText,
            parent:
              categoryId,
            topic,
            permissionOverwrites:
              overwrites,
            reason:
              `SupportForge ticket #${number}`,
          }),
          DISCORD_OPERATION_TIMEOUT_MS,
          'Ticket channel creation',
        )) as TextChannel;

      const panel =
        await withTimeout(
          ticketChannel.send({
            embeds: [
              buildTicketPanelEmbed(
                guild,
                ticketChannel.name,
                topic,
                config,
              ),
            ],
            components:
              buildTicketPanelComponents(
                'open',
              ),
          }),
          DISCORD_OPERATION_TIMEOUT_MS,
          'Ticket panel creation',
        );

      const finalTopic =
        setField(
          topic,
          'message',
          panel.id,
        );

      await setChannelTopic(
        ticketChannel.id,
        finalTopic,
        'Ticket topic initialization',
      );

      ticketChannel.topic = finalTopic;

      updateRuntimeTicketState(
        ticketChannel,
        finalTopic,
        'open',
      );

      await withTimeout(
        ticketChannel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                '📨 Support Request',
              )
              .setDescription(
                cleanDescription,
              )
              .addFields(
                {
                  name:
                    'Subject',
                  value:
                    cleanSubject,
                  inline: false,
                },
                {
                  name:
                    'Ticket',
                  value:
                    `#${number}`,
                  inline: true,
                },
                {
                  name:
                    'Department',
                  value:
                    department.name,
                  inline: true,
                },
              ),
          ],
        }),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Ticket description message',
      );

      await interaction.editReply({
        content:
          `✅ Your ticket has been created: ${ticketChannel}`,
      });

      /*
       * Audit logging never blocks ticket creation.
       */
      if (
        isPremiumOrHigher(
          config.tier,
        )
      ) {
        void (async () => {
          try {
            await logTicketEvent(
              guild,
              categoryId,
              {
                ticketNumber:
                  String(
                    number,
                  ),
                event:
                  'ticket_created',
                actor:
                  interaction.user.tag,
                detail:
                  `Ticket created in department ${department.name}.`,
              },
            );
          } catch (error) {
            console.error(
              '⚠️ Ticket creation audit failed:',
              error,
            );
          }
        })();
      }
    } catch (error) {
      if (ticketChannel) {
        try {
          await withTimeout(
            ticketChannel.delete(
              'SupportForge ticket initialization failed',
            ),
            DISCORD_OPERATION_TIMEOUT_MS,
            'Ticket cleanup',
          );
        } catch (deleteError) {
          console.error(
            '⚠️ Failed to clean up ticket channel:',
            deleteError,
          );
        }
      }

      throw error;
    }
  } catch (error) {
    console.error(
      '❌ Ticket creation failed:',
      error,
    );

    await replyError(
      interaction,
      '❌ SupportForge could not create the ticket. Please try again.',
    );
  } finally {
    ticketCreationLocks.delete(
      lockKey,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Ticket status transitions                                                  */
/* -------------------------------------------------------------------------- */

async function transition(
  interaction: ButtonInteraction,
  newStatus: TicketStatus,
): Promise<void> {
  if (!(await safeDeferReply(interaction))) {
    return;
  }

  if (
    !interaction.guild ||
    interaction.channel?.type !==
      ChannelType.GuildText
  ) {
    await replyError(
      interaction,
      '❌ This action can only be used inside a ticket.',
    );
    return;
  }

  const channel =
    interaction.channel as TextChannel;

  const lockKey =
    channel.id;

  if (
    ticketActionLocks.has(
      lockKey,
    )
  ) {
    await replyError(
      interaction,
      '⏳ This ticket is already being updated.',
    );
    return;
  }

  ticketActionLocks.add(
    lockKey,
  );

  try {
    /*
     * Always read the latest channel topic before changing state.
     * This prevents stale runtime data from becoming authoritative.
     */
    const latestTopic =
      channel.topic ?? '';

    const state =
      getRuntimeTicketState(
        channel,
      );

    const oldTopic =
      latestTopic ||
      state.topic;

    const oldTopicStatus =
      getTicketStatus(
        oldTopic,
      );

    const persistedStatus =
      await getPersistedTicketStatus(
        channel.id,
      );

    const oldStatus =
      persistedStatus ?? oldTopicStatus;

    if (
      !isTicketTopic(
        oldTopic,
      )
    ) {
      throw new Error(
        'Invalid SupportForge ticket topic.',
      );
    }

    /*
     * No-op protection.
     */
    if (
      oldStatus ===
      newStatus
    ) {
      await interaction.editReply(
        `ℹ️ This ticket is already **${capitalize(
          newStatus,
        )}**.`,
      );
      return;
    }

    /*
     * Archived tickets are terminal.
     */
    if (
      oldStatus ===
      'archived'
    ) {
      await interaction.editReply(
        '❌ This ticket is archived and cannot be changed.',
      );
      return;
    }

    /*
     * A closed ticket can be reopened or deliberately archived.
     * Archive is the permanent historical state.
     */
    if (
      oldStatus ===
        'closed' &&
      newStatus !== 'reopened' &&
      newStatus !== 'archived'
    ) {
      await interaction.editReply(
        '❌ This ticket is closed. Reopen it or archive it before changing its state.',
      );
      return;
    }

    const staff =
      getStaffContext(
        interaction,
        oldTopic,
      );

    /*
     * Staff/admin-only transitions.
     */
    if (
      (
        newStatus ===
          'claimed' ||
        newStatus ===
          'pending' ||
        newStatus ===
          'reopened' ||
        newStatus ===
          'archived'
      ) &&
      !staff.authorized
    ) {
      await interaction.editReply(
        '❌ Only configured staff or administrators can perform this action.',
      );
      return;
    }

    /*
     * Owner may resume their pending ticket.
     * Staff/admin may also do it.
     */
    if (
      newStatus ===
        'open' &&
      !staff.authorized &&
      staff.ownerId !==
        interaction.user.id
    ) {
      await interaction.editReply(
        '❌ You are not authorized to resume this ticket.',
      );
      return;
    }

    /*
     * Prevent staff from silently stealing an existing claim.
     */
    if (
      newStatus ===
        'claimed' &&
      oldStatus ===
        'claimed'
    ) {
      const claimedBy =
        getField(
          oldTopic,
          'claimed_by',
        );

      if (
        claimedBy ===
        interaction.user.id
      ) {
        await interaction.editReply(
          'ℹ️ You already have this ticket claimed.',
        );
      } else {
        await interaction.editReply(
          `❌ This ticket is already claimed by <@${claimedBy ?? 'unknown'}>.`,
        );
      }

      return;
    }

    const messageId =
      getField(
        oldTopic,
        'message',
      ) ??
      getField(
        oldTopic,
        'panel_message',
      );

    /*
     * Build the complete new topic in memory first.
     *
     * Nothing is written to Discord until the transition is valid.
     */
    let newTopic =
      oldTopic;

    if (
      newStatus ===
      'claimed'
    ) {
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

    if (
      newStatus ===
      'pending'
    ) {
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

    if (
      newStatus ===
      'open'
    ) {
      newTopic =
        removeField(
          newTopic,
          'pending_since',
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

    if (
      newStatus ===
      'reopened'
    ) {
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
          'archived_at',
        );

      newTopic =
        removeField(
          newTopic,
          'pending_since',
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

      /*
       * Reopening clears the closed/archived metadata. The lifecycle status
       * is persisted below; the Discord topic remains descriptive metadata.
       * Permissions are intentionally left unchanged.
       */
    }

    if (
      newStatus ===
      'archived'
    ) {
      newTopic =
        setField(
          newTopic,
          'archived_at',
          new Date().toISOString(),
        );
    }

    newTopic =
      setField(
        newTopic,
        'status',
        newStatus,
      );

    /*
     * Lifecycle status is persisted outside the Discord channel topic.
     * Discord's /channels PATCH bucket can remain rate-limited for many
     * minutes, so status changes must not depend on a topic PATCH succeeding.
     * The topic remains descriptive metadata and is still used by older
     * tickets and other ticket metadata operations.
     */
    await setPersistedTicketStatus(
      channel.id,
      newStatus,
    );

    /*
     * Keep the local runtime state immediately consistent with the persisted
     * lifecycle state. The panel is refreshed from newTopic below.
     */
    updateRuntimeTicketState(
      channel,
      newTopic,
      newStatus,
    );

    /*
     * Storage sections are separate from the active support category.
     * Billing tickets use the dedicated Billing section when configured.
     * Closed and archived tickets are physically moved so moderators can
     * distinguish active work from historical records.
     */
    try {
      if (newStatus === 'closed') {
        await moveTicketToCategory(
          channel,
          await ensureClosedCategory(interaction.guild!),
        );
      } else if (newStatus === 'archived') {
        await moveTicketToCategory(
          channel,
          await ensureArchiveCategory(interaction.guild!),
        );
      } else if (newStatus === 'reopened' || newStatus === 'open') {
        const departmentId = getField(newTopic, 'department');
        const department = departmentId
          ? (await getGuildConfig(interaction.guild!.id)).departments[departmentId]
          : undefined;

        const currentConfig = await getGuildConfig(interaction.guild!.id);

        if (department?.name.toLowerCase() === 'billing') {
          await moveTicketToCategory(
            channel,
            await ensureBillingCategory(interaction.guild!),
          );
        } else if (currentConfig.supportCategoryId) {
          const supportCategory = interaction.guild!.channels.cache.get(
            currentConfig.supportCategoryId,
          );

          if (supportCategory?.type === ChannelType.GuildCategory) {
            await moveTicketToCategory(
              channel,
              supportCategory,
            );
          }
        }
      }
    } catch (storageError) {
      console.warn(
        '⚠️ Ticket storage category transition failed:',
        storageError,
      );
    }

    /*
     * Keep the channel name synchronized with the lifecycle state.
     * "reopened" intentionally uses the normal "open" name.
     */
    const ticketNumberForName =
      getField(newTopic, 'number') ?? 'unknown';

    void queueTicketChannelRename(
      channel,
      getTicketChannelName(
        ticketNumberForName,
        newStatus,
      ),
      `Ticket #${ticketNumberForName} status changed to ${newStatus}`,
    ).catch((error) => {
      console.error(
        `⚠️ Failed to rename ticket for status ${newStatus}:`,
        error,
      );
    });
    /*
     * Refresh the panel immediately, then schedule a relocation to the
     * bottom of the conversation. This is especially important when a
     * closed ticket is reopened after a long conversation: the old panel
     * may be hundreds of messages above the current activity.
     */
    await updateMainMessage(
      channel,
      messageId,
      newStatus,
      newTopic,
    );


    await interaction.editReply(
      `✅ Ticket status changed to **${capitalize(
        newStatus,
      )}**.`,
    );

    /*
     * Background announcement.
     */
    void channel
      .send(
        `📌 Ticket status changed to **${capitalize(
          newStatus,
        )}** by ${interaction.user}.`,
      )
      .catch((error) => {
        console.error(
          '⚠️ Status announcement failed:',
          error,
        );
      });

    /*
     * Background audit.
     */
    void (async () => {
      try {
        const config =
          await getGuildConfig(
            interaction.guild!.id,
          );

        if (
          !isPremiumOrHigher(
            config.tier,
          )
        ) {
          return;
        }

        if (
          !config.supportCategoryId
        ) {
          return;
        }

        await logTicketEvent(
          interaction.guild!,
          config.supportCategoryId,
          {
            ticketNumber:
              getField(
                newTopic,
                'number',
              ) ?? 'unknown',
            event:
              `ticket_${newStatus}`,
            actor:
              interaction.user.tag,
            detail:
              `Status changed from ${oldStatus} to ${newStatus}.`,
          },
        );
      } catch (error) {
        console.error(
          '⚠️ Status audit failed:',
          error,
        );
      }
    })();
  } catch (error) {
    console.error(
      `❌ Failed to transition ticket to ${newStatus}:`,
      error,
    );

    clearRuntimeTicketState(
      channel.id,
    );

    await replyError(
      interaction,
      `❌ Could not change the ticket status to **${capitalize(
        newStatus,
      )}**.`,
    );
  } finally {
    ticketActionLocks.delete(
      lockKey,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Close ticket                                                               */
/* -------------------------------------------------------------------------- */

async function closeTicket(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!(await safeDeferReply(interaction))) {
    return;
  }

  if (
    !interaction.guild ||
    interaction.channel?.type !==
      ChannelType.GuildText
  ) {
    await replyError(
      interaction,
      '❌ This action can only be used inside a ticket.',
    );
    return;
  }

  const channel =
    interaction.channel as TextChannel;

  const lockKey =
    channel.id;

  if (
    ticketActionLocks.has(
      lockKey,
    )
  ) {
    await replyError(
      interaction,
      '⏳ This ticket is already being processed.',
    );
    return;
  }

  ticketActionLocks.add(
    lockKey,
  );

  try {
    /*
     * Always use the latest topic.
     */
    const latestTopic =
      channel.topic ?? '';

    const state =
      getRuntimeTicketState(
        channel,
      );

    const topic =
      latestTopic ||
      state.topic;

    const topicStatus =
      getTicketStatus(
        topic,
      );

    const persistedStatus =
      await getPersistedTicketStatus(
        channel.id,
      );

    const status =
      persistedStatus ?? topicStatus;

    if (
      !isTicketTopic(
        topic,
      )
    ) {
      throw new Error(
        'Invalid SupportForge ticket topic.',
      );
    }

    /*
     * The persisted lifecycle state is authoritative when available.
     * The channel topic remains the fallback for tickets created before
     * lifecycle persistence was introduced.
     */
    if (
      status ===
      'closed'
    ) {
      await interaction.editReply(
        '❌ This ticket is already closed.',
      );
      return;
    }

    if (
      status ===
      'archived'
    ) {
      await interaction.editReply(
        '❌ This ticket is archived.',
      );
      return;
    }

    const staff =
      getStaffContext(
        interaction,
        topic,
      );

    const owner =
      staff.ownerId ===
      interaction.user.id;

    if (
      !owner &&
      !staff.authorized
    ) {
      await interaction.editReply(
        '❌ Only the ticket owner, configured staff, or an administrator can close this ticket.',
      );
      return;
    }

    const messageId =
      getField(
        topic,
        'message',
      ) ??
      getField(
        topic,
        'panel_message',
      );

    const config =
      await withTimeout(
        getGuildConfig(
          interaction.guild.id,
        ),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Guild configuration load',
      );

    const transcriptChannelId =
      config.transcriptChannelId;

    if (
      !transcriptChannelId
    ) {
      await interaction.editReply(
        '❌ Transcript channel is not configured. The ticket was not closed.',
      );
      return;
    }

    const transcriptChannel =
      interaction.guild.channels.cache.get(
        transcriptChannelId,
      );

    if (
      !transcriptChannel ||
      transcriptChannel.type !==
        ChannelType.GuildText
    ) {
      await interaction.editReply(
        '❌ The transcript channel is missing. The ticket was not closed.',
      );
      return;
    }

    const ticketNumber =
      getField(
        topic,
        'number',
      ) ?? 'unknown';

    const subject =
      decodeSubject(
        getField(
          topic,
          'subject',
        ),
      );

    const ownerId =
      getField(
        topic,
        'owner',
      ) ?? interaction.user.id;

    const openedAtRaw =
      getField(
        topic,
        'opened_at',
      );

    const parsedOpenedAt =
      openedAtRaw
        ? new Date(
            openedAtRaw,
          )
        : new Date();

    const openedAt =
      Number.isNaN(
        parsedOpenedAt.getTime(),
      )
        ? new Date()
        : parsedOpenedAt;

    const closedAt =
      new Date();

    const ownerMember =
      await interaction.guild.members
        .fetch(ownerId)
        .catch(() => null);

    const ownerName =
      ownerMember?.user.tag ??
      `<@${ownerId}>`;

    /*
     * IMPORTANT:
     *
     * 1. Generate transcript.
     * 2. Upload transcript.
     * 3. Lock permissions.
     * 4. Set status=closed.
     *
     * The ticket is NOT considered closed until the transcript exists.
     */

    const transcript =
      await withTimeout(
        generateTranscript({
          channel,
          ticketNumber,
          subject,
          ownerId,
          ownerName,
          closedBy:
            interaction.user.tag,
          openedAt,
          closedAt,
        }),
        TRANSCRIPT_TIMEOUT_MS,
        'Transcript generation',
      );

    await withTimeout(
      transcriptChannel.send({
        content:
          `📄 Transcript for ticket **#${ticketNumber}**`,
        files: [
          transcript,
        ],
      }),
      DISCORD_OPERATION_TIMEOUT_MS,
      'Transcript upload',
    );

    /*
     * Transcript successfully uploaded.
     *
     * Closing a ticket no longer changes channel permissions or requires a
     * Discord channel PATCH. The lifecycle state is persisted locally so the
     * closed-ticket message guard continues to work after a restart.
     */
    const closedTopic =
      setField(
        setField(
          topic,
          'status',
          'closed',
        ),
        'closed_at',
        closedAt.toISOString(),
      );

    await setPersistedTicketStatus(
      channel.id,
      'closed',
    );

    updateRuntimeTicketState(
      channel,
      closedTopic,
      'closed',
    );

    await interaction.editReply(
      `✅ Ticket **#${ticketNumber}** has been closed and its transcript has been saved.`,
    );

    /*
     * Background rename is intentionally started FIRST. Channel rename and
     * message edits can share Discord's per-channel resource buckets, so
     * giving the rename queue the first chance reduces visible delay without
     * making the close interaction wait for Discord channel PATCH latency.
     */
    void queueTicketChannelRename(
      channel,
      getTicketChannelName(ticketNumber, 'closed'),
      `Ticket #${ticketNumber} closed`,
    ).catch((error) => {
      console.error(
        '⚠️ Failed to rename closed ticket:',
        error,
      );
    });

    /*
     * Panel update happens after the state is committed and remains
     * background work so it cannot delay the successful close response.
     */
    void updateMainMessage(
      channel,
      messageId,
      'closed',
      closedTopic,
    );

    /*
     * Background announcement.
     */
    void channel
      .send(
        `🔒 Ticket **#${ticketNumber}** has been closed by ${interaction.user}.`,
      )
      .catch((error) => {
        console.error(
          '⚠️ Close announcement failed:',
          error,
        );
      });

    /*
     * Background audit.
     */
    void (async () => {
      try {
        if (
          !isPremiumOrHigher(
            config.tier,
          )
        ) {
          return;
        }

        if (
          !config.supportCategoryId
        ) {
          return;
        }

        await logTicketEvent(
          interaction.guild!,
          config.supportCategoryId,
          {
            ticketNumber,
            event:
              'ticket_closed',
            actor:
              interaction.user.tag,
            detail:
              'Transcript uploaded successfully and ticket status changed to closed.',
          },
        );
      } catch (error) {
        console.error(
          '⚠️ Close audit failed:',
          error,
        );
      }
    })();
  } catch (error) {
    console.error(
      '❌ Failed to close ticket:',
      error,
    );

    clearRuntimeTicketState(
      channel.id,
    );

    await replyError(
      interaction,
      '❌ The ticket could not be closed safely. The ticket remains active where possible.',
    );
  } finally {
    ticketActionLocks.delete(
      lockKey,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Ticket creation modal                                                      */
/* -------------------------------------------------------------------------- */

async function showTicketCreationModal(
  interaction: ButtonInteraction,
  departmentId: string,
): Promise<void> {
  if (!interaction.guild) {
    await replyError(
      interaction,
      '❌ This action can only be used inside a server.',
    );
    return;
  }

  try {
    const config =
      await withTimeout(
        getGuildConfig(
          interaction.guild.id,
        ),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Guild configuration load',
      );

    const department =
      config.departments[
        departmentId
      ];

    if (!department) {
      await replyError(
        interaction,
        '❌ This ticket department no longer exists. Please refresh the support panel.',
      );
      return;
    }

    const modal =
      new ModalBuilder()
        .setCustomId(
          `ticket:modal:${departmentId}`,
        )
        .setTitle(
          `${department.name} Support`,
        );

    const subjectInput =
      new TextInputBuilder()
        .setCustomId(
          'subject',
        )
        .setLabel(
          'What do you need help with?',
        )
        .setPlaceholder(
          'Briefly describe your issue',
        )
        .setStyle(
          TextInputStyle.Short,
        )
        .setRequired(
          true,
        )
        .setMaxLength(
          100,
        );

    const descriptionInput =
      new TextInputBuilder()
        .setCustomId(
          'description',
        )
        .setLabel(
          'Describe your issue (up to 4000 characters)',
        )
        .setPlaceholder(
          'Give us the details we need to help you...',
        )
        .setStyle(
          TextInputStyle.Paragraph,
        )
        .setRequired(
          true,
        )
        .setMaxLength(
          4000,
        );

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(
          subjectInput,
        ),

      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(
          descriptionInput,
        ),
    );

    /*
     * IMPORTANT:
     *
     * showModal() itself acknowledges the button interaction.
     * We must NOT deferReply(), reply(), or editReply() afterwards.
     */
    await interaction.showModal(
      modal,
    );
  } catch (error) {
    console.error(
      '❌ Failed to show ticket creation modal:',
      error,
    );

    /*
     * If showModal() failed before acknowledging the interaction,
     * replyError() can still safely acknowledge it. If Discord already
     * acknowledged it, replyError() will simply do nothing.
     */
    await replyError(
      interaction,
      '❌ SupportForge could not open the ticket creation form. Please try again.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Panel button handlers                                                      */
/* -------------------------------------------------------------------------- */

async function showTicketHistory(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!(await safeDeferReply(interaction))) {
    return;
  }

  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(
      interaction,
      '❌ Ticket history is only available inside a ticket channel.',
    );
    return;
  }

  try {
    const channel = interaction.channel as TextChannel;
    const topic = channel.topic ?? '';
    const ticketNumber = getField(topic, 'number') ?? 'unknown';
    const config = await withTimeout(
      getGuildConfig(interaction.guild.id),
      DISCORD_OPERATION_TIMEOUT_MS,
      'Guild configuration load',
    );

    const auditId = config.auditChannelId;
    const auditChannel = auditId
      ? interaction.guild.channels.cache.get(auditId)
      : null;

    if (!auditChannel || auditChannel.type !== ChannelType.GuildText) {
      await interaction.editReply(
        'ℹ️ No audit history exists for this ticket yet.',
      );
      return;
    }

    const messages = await withTimeout(
      auditChannel.messages.fetch({ limit: 100 }),
      DISCORD_OPERATION_TIMEOUT_MS,
      'Ticket history fetch',
    );

    const matching = messages
      .filter((message) =>
        message.embeds.some(
          (embed) =>
            embed.description?.includes(
              `Ticket #${ticketNumber}`,
            ) ?? false,
        ),
      )
      .sort(
        (a, b) =>
          b.createdTimestamp - a.createdTimestamp,
      )
      .first(15);

    const lines = matching.length
      ? matching
          .map((message) => {
            const embed = message.embeds[0];
            const description =
              embed?.description ?? 'Recorded event';
            const compact = description
              .replace(/\\n+/g, ' ')
              .replace(/\\s{2,}/g, ' ')
              .trim();

            return `• <t:${Math.floor(message.createdTimestamp / 1000)}:f> • ${compact}`;
          })
          .join('\\n')
      : 'No recent audit events found for this ticket.';

    await interaction.editReply(
      `📜 **Ticket #${ticketNumber} History**\\n\\n${lines}`,
    );
  } catch (error) {
    console.error('❌ Failed to load ticket history:', error);

    await replyError(
      interaction,
      '❌ SupportForge could not load this ticket history.',
    );
  }
}

async function handlePanelButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const id =
    interaction.customId;

  if (
    id ===
    'ticket:close'
  ) {
    await closeTicket(
      interaction,
    );
    return;
  }

  if (
    id ===
    'ticket:closed'
  ) {
    await replyError(
      interaction,
      'ℹ️ This ticket is already closed.',
    );
    return;
  }

  if (
    id ===
    'ticket:claim'
  ) {
    await transition(
      interaction,
      'claimed',
    );
    return;
  }

  if (
    id ===
    'ticket:unclaim'
  ) {
    await transition(
      interaction,
      'open',
    );
    return;
  }

  if (
    id ===
    'ticket:pending'
  ) {
    await transition(
      interaction,
      'pending',
    );
    return;
  }

  if (
    id ===
    'ticket:resume'
  ) {
    await transition(
      interaction,
      'open',
    );
    return;
  }

  if (
    id ===
    'ticket:reopen'
  ) {
    await transition(
      interaction,
      'reopened',
    );
    return;
  }

  if (
    id ===
    'ticket:archive'
  ) {
    await transition(
      interaction,
      'archived',
    );
    return;
  }

  if (id === 'ticket:panel:move-bottom') {
    if (!(await safeDeferReply(interaction))) {
      return;
    }

    if (
      !interaction.guild ||
      interaction.channel?.type !== ChannelType.GuildText
    ) {
      await replyError(
        interaction,
        '❌ Panel controls can only be used inside a ticket channel.',
      );
      return;
    }

    const channel = interaction.channel as TextChannel;
    const topic = channel.topic ?? '';
    const status =
      (await getPersistedTicketStatus(channel.id)) ??
      getTicketStatus(topic);

    if (!ACTIVE_TICKET_STATUSES.includes(status)) {
      await replyError(
        interaction,
        '❌ Only active tickets can have their panel repositioned.',
      );
      return;
    }

    const staff = getStaffContext(interaction, topic);
    if (!staff.authorized) {
      await replyError(
        interaction,
        '❌ Only configured staff or administrators can move the ticket panel.',
      );
      return;
    }

    try {
      await moveTicketPanelToBottom(channel);
      resetPanelActivity(
        channel.id,
        channel.lastMessageId ?? getField(topic, 'message') ?? 'unknown',
      );
      await interaction.editReply(
        '✅ Ticket controls were moved to the bottom. The panel will now remain fixed until a moderator deliberately moves it again.',
      );
    } catch (error) {
      console.error('❌ Failed to move ticket panel manually:', error);
      await replyError(
        interaction,
        '❌ SupportForge could not move the ticket panel.',
      );
    }

    return;
  }
  if (id === 'ticket:panel:history') {
    await showTicketHistory(interaction);
    return;
  }

  /*
   * Closed and archived tickets expose only their lifecycle controls.
   * Reject stale/forged tool-button interactions even if an old panel
   * message still contains one.
   */
  if (
    id.startsWith('ticket:panel:') &&
    interaction.channel?.type === ChannelType.GuildText
  ) {
    const panelChannel = interaction.channel as TextChannel;
    const panelTopicStatus = getTicketStatus(panelChannel.topic ?? '');
    const panelPersistedStatus = await getPersistedTicketStatus(panelChannel.id);
    const panelStatus = panelPersistedStatus ?? panelTopicStatus;

    if (!['open', 'claimed', 'pending', 'reopened'].includes(panelStatus)) {
      await replyError(
        interaction,
        '❌ This ticket is closed or archived. Reopen it before using ticket tools.',
      );
      return;
    }
  }

  /*
   * Ticket panel tool buttons.
   */
  if (
    id ===
      'ticket:panel:add-user' ||
    id ===
      'ticket:panel:priority' ||
    id ===
      'ticket:panel:tag' ||
    id ===
      'ticket:panel:note'
  ) {
    const modal =
      new ModalBuilder();

    if (
      id ===
      'ticket:panel:add-user'
    ) {
      modal
        .setCustomId(
          'ticket:panel-modal:add-user',
        )
        .setTitle(
          'Add User to Ticket',
        );

      const input =
        new TextInputBuilder()
          .setCustomId(
            'user',
          )
          .setLabel(
            'User ID or mention',
          )
          .setPlaceholder(
            '123456789012345678 or @user',
          )
          .setStyle(
            TextInputStyle.Short,
          )
          .setRequired(
            true,
          )
          .setMaxLength(
            100,
          );

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>()
          .addComponents(
            input,
          ),
      );
    } else if (
      id ===
      'ticket:panel:priority'
    ) {
      modal
        .setCustomId(
          'ticket:panel-modal:priority',
        )
        .setTitle(
          'Change Priority',
        );

      const input =
        new TextInputBuilder()
          .setCustomId(
            'priority',
          )
          .setLabel(
            'Priority',
          )
          .setPlaceholder(
            'low, normal, high, urgent',
          )
          .setStyle(
            TextInputStyle.Short,
          )
          .setRequired(
            true,
          )
          .setMaxLength(
            20,
          );

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>()
          .addComponents(
            input,
          ),
      );
    } else if (
      id ===
      'ticket:panel:tag'
    ) {
      modal
        .setCustomId(
          'ticket:panel-modal:tag',
        )
        .setTitle(
          'Add Ticket Tag',
        );

      const input =
        new TextInputBuilder()
          .setCustomId(
            'tag',
          )
          .setLabel(
            'Tag',
          )
          .setPlaceholder(
            'billing, bug, refund...',
          )
          .setStyle(
            TextInputStyle.Short,
          )
          .setRequired(
            true,
          )
          .setMaxLength(
            40,
          );

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>()
          .addComponents(
            input,
          ),
      );
    } else {
      modal
        .setCustomId(
          'ticket:panel-modal:note',
        )
        .setTitle(
          'Add Internal Note',
        );

      const input =
        new TextInputBuilder()
          .setCustomId(
            'note',
          )
          .setLabel(
            'Internal note',
          )
          .setStyle(
            TextInputStyle.Paragraph,
          )
          .setRequired(
            true,
          )
          .setMaxLength(
            1000,
          );

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>()
          .addComponents(
            input,
          ),
      );
    }

    try {
      await interaction.showModal(
        modal,
      );
    } catch (error) {
      console.error(
        '❌ Failed to show ticket panel modal:',
        error,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Panel modal handlers                                                       */
/* -------------------------------------------------------------------------- */

async function handlePanelModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!(await safeDeferReply(interaction))) {
    return;
  }

  if (
    !interaction.guild ||
    interaction.channel?.type !==
      ChannelType.GuildText
  ) {
    await replyError(
      interaction,
      '❌ This action can only be used inside a ticket.',
    );
    return;
  }

  const channel =
    interaction.channel as TextChannel;

  const state =
    getRuntimeTicketState(
      channel,
    );

  const persistedStatus =
    await getPersistedTicketStatus(
      channel.id,
    );

  if (persistedStatus && persistedStatus !== state.status) {
    state.status = persistedStatus;
  }

  if (
    !isTicketTopic(
      state.topic,
    )
  ) {
    await replyError(
      interaction,
      '❌ This is not a valid SupportForge ticket.',
    );
    return;
  }

  if (
    isTerminalTicketStatus(
      state.status,
    )
  ) {
    await replyError(
      interaction,
      `❌ This ticket is already **${state.status}**.`,
    );
    return;
  }

  const staff =
    getStaffContext(
      interaction,
      state.topic,
    );

  if (
    !staff.authorized
  ) {
    await replyError(
      interaction,
      '❌ Only configured staff or administrators can modify ticket details.',
    );
    return;
  }

  try {
    let newTopic =
      state.topic;

    const id =
      interaction.customId;

    /* ---------------------------------------------------------------------- */
    /* Add user                                                               */
    /* ---------------------------------------------------------------------- */

    if (
      id ===
      'ticket:panel-modal:add-user'
    ) {
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
          '❌ Please provide a valid Discord user ID or mention.',
        );
        return;
      }

      const users =
        (
          getField(
            state.topic,
            'users',
          ) ?? ''
        )
          .split(',')
          .map((value) =>
            value.trim(),
          )
          .filter(Boolean);

      if (
        users.includes(
          userId,
        )
      ) {
        await interaction.editReply(
          'ℹ️ That user is already on this ticket.',
        );
        return;
      }

      users.push(
        userId,
      );

      newTopic =
        setField(
          newTopic,
          'users',
          users.join(','),
        );

      await setChannelPermissionOverwrite(
        channel.id,
        userId,
        [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
        [],
        1,
        'Add ticket user permissions',
      );

      await setChannelTopic(
        channel.id,
        newTopic,
        'Add ticket user topic update',
      );

      channel.topic = newTopic;

      updateRuntimeTicketState(
        channel,
        newTopic,
        state.status,
      );

      await interaction.editReply(
        `✅ <@${userId}> has been added to the ticket.`,
      );

      return;
    }

    /* ---------------------------------------------------------------------- */
    /* Priority                                                               */
    /* ---------------------------------------------------------------------- */

    if (
      id ===
      'ticket:panel-modal:priority'
    ) {
      const priority =
        interaction.fields
          .getTextInputValue(
            'priority',
          )
          .trim()
          .toLowerCase();

      const valid =
        new Set([
          'low',
          'normal',
          'high',
          'urgent',
          'critical',
        ]);

      if (
        !valid.has(
          priority,
        )
      ) {
        await interaction.editReply(
          '❌ Priority must be `low`, `normal`, `high`, `urgent`, or `critical`.',
        );
        return;
      }

      newTopic =
        setField(
          newTopic,
          'priority',
          priority,
        );

      await runChannelMutation(
        channel,
        'Priority update',
        async () => {
          await setChannelTopic(
            channel.id,
            newTopic,
            `SupportForge: priority update`,
          );
          channel.topic = newTopic;
        },
      );

      updateRuntimeTicketState(
        channel,
        newTopic,
        state.status,
      );

      await interaction.editReply(
        `✅ Ticket priority changed to **${priority}**.`,
      );

      void updateMainMessage(
        channel,
        getField(
          newTopic,
          'message',
        ),
        state.status,
        newTopic,
      );

      return;
    }

    /* ---------------------------------------------------------------------- */
    /* Tag                                                                    */
    /* ---------------------------------------------------------------------- */

    if (
      id ===
      'ticket:panel-modal:tag'
    ) {
      const tag =
        interaction.fields
          .getTextInputValue(
            'tag',
          )
          .trim()
          .toLowerCase();

      if (!tag) {
        await interaction.editReply(
          '❌ Tag cannot be empty.',
        );
        return;
      }

      const tags =
        (
          getField(
            state.topic,
            'tags',
          ) ?? ''
        )
          .split(',')
          .map((value) =>
            value.trim(),
          )
          .filter(Boolean);

      if (
        !tags.includes(
          tag,
        )
      ) {
        tags.push(tag);
      }

      newTopic =
        setField(
          newTopic,
          'tags',
          tags.join(','),
        );

      await runChannelMutation(
        channel,
        'Tag update',
        async () => {
          await setChannelTopic(
            channel.id,
            newTopic,
            `SupportForge: tag update`,
          );
          channel.topic = newTopic;
        },
      );

      updateRuntimeTicketState(
        channel,
        newTopic,
        state.status,
      );

      await interaction.editReply(
        `✅ Added ticket tag **${tag}**.`,
      );

      void updateMainMessage(
        channel,
        getField(
          newTopic,
          'message',
        ),
        state.status,
        newTopic,
      );

      return;
    }

    /* ---------------------------------------------------------------------- */
    /* Internal note                                                          */
    /* ---------------------------------------------------------------------- */

    if (
      id ===
      'ticket:panel-modal:note'
    ) {
      const note =
        interaction.fields
          .getTextInputValue(
            'note',
          )
          .trim();

      if (!note) {
        await interaction.editReply(
          '❌ Note cannot be empty.',
        );
        return;
      }

      await withTimeout(
        channel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle(
                '📝 Internal Note',
              )
              .setDescription(
                note,
              )
              .setFooter({
                text:
                  `Added by ${interaction.user.tag}`,
              })
              .setTimestamp(),
          ],
        }),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Internal note creation',
      );

      /*
       * Also record the note in the staff-only audit history so the History
       * control can show it alongside lifecycle events.
       */
      try {
        const config = await getGuildConfig(
          channel.guild.id,
        );

        if (config.supportCategoryId) {
          await logTicketEvent(
            channel.guild,
            config.supportCategoryId,
            {
              ticketNumber:
                getField(channel.topic ?? '', 'number') ?? 'unknown',
              event:
                'internal_note',
              actor:
                interaction.user.tag,
              detail:
                note,
            },
          );
        }
      } catch (error) {
        console.error(
          '⚠️ Internal note audit failed:',
          error,
        );
      }

      await interaction.editReply(
        '✅ Internal note added.',
      );

      return;
    }

    await interaction.editReply(
      '❌ Unknown ticket action.',
    );
  } catch (error) {
    console.error(
      '❌ Ticket modal action failed:',
      error,
    );

    clearRuntimeTicketState(
      channel.id,
    );

    await replyError(
      interaction,
      '❌ The ticket update could not be completed.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Utility                                                                    */
/* -------------------------------------------------------------------------- */

function capitalize(
  value: string,
): string {
  return (
    value.charAt(0).toUpperCase() +
    value.slice(1)
  );
}

/* -------------------------------------------------------------------------- */
/* Main interaction router                                                    */
/* -------------------------------------------------------------------------- */

export async function handleTicketInteraction(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
): Promise<void> {
  try {
    if (
      interaction.isButton()
    ) {
      /*
       * Department ticket creation buttons.
       *
       * supportforge.ts creates these as:
       *
       *   ticket:create:<departmentId>
       *
       * A button interaction MUST be acknowledged.
       * The acknowledgement here is showModal().
       */
      if (
        interaction.customId.startsWith(
          'ticket:create:',
        )
      ) {
        const departmentId =
          interaction.customId.slice(
            'ticket:create:'.length,
          );

        if (
          !departmentId
        ) {
          await replyError(
            interaction,
            '❌ Ticket department could not be determined.',
          );
          return;
        }

        await showTicketCreationModal(
          interaction,
          departmentId,
        );

        return;
      }

      /*
       * Lifecycle buttons.
       */
      if (
        interaction.customId ===
          'ticket:close' ||
        interaction.customId ===
          'ticket:closed' ||
        interaction.customId ===
          'ticket:claim' ||
        interaction.customId ===
          'ticket:unclaim' ||
        interaction.customId ===
          'ticket:pending' ||
        interaction.customId ===
          'ticket:resume' ||
        interaction.customId ===
          'ticket:reopen' ||
        interaction.customId ===
          'ticket:archive'
      ) {
        await handlePanelButton(
          interaction,
        );
        return;
      }

      /*
       * Panel tool buttons.
       */
      if (
        isPanelButton(
          interaction,
        )
      ) {
        await handlePanelButton(
          interaction,
        );
        return;
      }

      /*
       * Unknown button.
       *
       * Do not silently leave the interaction unacknowledged.
       */
      console.warn(
        `⚠️ Unhandled SupportForge button: ${interaction.customId}`,
      );

      await replyError(
        interaction,
        '❌ This SupportForge button is no longer available. Please refresh the panel.',
      );

      return;
    }

    if (
      interaction.isModalSubmit()
    ) {
      /*
       * Ticket creation modal:
       *
       * ticket:modal:<departmentId>
       */
      if (
        interaction.customId ===
        'ticket:modal'
      ) {
        let departmentId =
          '';

        try {
          departmentId =
            interaction.fields
              .getTextInputValue(
                'department',
              );
        } catch {
          /*
           * Some existing modal configurations encode the department
           * in the custom ID instead.
           */
        }

        if (!departmentId) {
          await replyError(
            interaction,
            '❌ Ticket department could not be determined.',
          );
          return;
        }

        await createTicket(
          interaction,
          departmentId,
        );

        return;
      }

      if (
        interaction.customId.startsWith(
          'ticket:modal:',
        )
      ) {
        const departmentId =
          interaction.customId.slice(
            'ticket:modal:'.length,
          );

        if (
          departmentId
        ) {
          await createTicket(
            interaction,
            departmentId,
          );
          return;
        }
      }

      /*
       * Ticket management modals.
       */
      if (
        interaction.customId.startsWith(
          'ticket:panel-modal:',
        )
      ) {
        await handlePanelModal(
          interaction,
        );
        return;
      }

      /*
       * Unknown modal.
       */
      console.warn(
        `⚠️ Unhandled SupportForge modal: ${interaction.customId}`,
      );

      await replyError(
        interaction,
        '❌ This SupportForge form is no longer available. Please try again.',
      );

      return;
    }
  } catch (error) {
    console.error(
      '❌ Unhandled SupportForge interaction error:',
      error,
    );

    await replyError(
      interaction,
      '❌ SupportForge encountered an unexpected error while processing this action.',
    );
  }
}