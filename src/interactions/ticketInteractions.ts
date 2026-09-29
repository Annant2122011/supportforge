import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  type Message,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';

import {
  allocateTicketNumber,
  getGuildConfig,
  isPremiumOrHigher,
  updateGuildConfig,
} from '../services/configService';

import { generateTranscript } from '../services/transcriptService';

import {
  setChannelParent,
  setChannelPermissionOverwrite,
  setChannelTopic,
} from '../services/discordChannelService';

import {
  ensureArchiveCategory,
  ensureClosedCategory,
  ensureOpenCategory,
  getOptionalStatusCategory,
  moveTicketToCategory,
} from '../services/ticketStorageService';

import { resetPanelActivity } from '../services/panelActivityService';
import { getAdvancedSettings, type TicketPriority } from '../services/advancedSettingsService';
import { ensureDepartmentCategory } from '../services/departmentCategoryService';

import {
  getPersistedTicketStatus,
  registerTicket,
  setPersistedTicketStatus,
  updatePersistedTicketMetadata,
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

function parseTicketPriority(value: string): TicketPriority | null {
  return value === 'low' ||
    value === 'normal' ||
    value === 'high' ||
    value === 'urgent' ||
    value === 'critical'
    ? value
    : null;
}

function getTopicPriority(topic: string): TicketPriority {
  return parseTicketPriority(getField(topic, 'priority') ?? '') ?? 'normal';
}

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
    | StringSelectMenuInteraction
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
    | StringSelectMenuInteraction
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
    | StringSelectMenuInteraction
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
    | StringSelectMenuInteraction
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
  tagId: string,
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
    const tag = department?.tags?.[tagId];

    if (!department || !tag) {
      await replyError(
        interaction,
        '❌ This ticket department no longer exists.',
      );
      return;
    }

    const auditParentCategoryId = config.supportCategoryId;
    if (!auditParentCategoryId) {
      await replyError(
        interaction,
        '❌ SupportForge is not configured. Run `/supportforge setup` first.',
      );
      return;
    }

    let departmentCategory:
      | import('discord.js').CategoryChannel
      | undefined;

    if (department.categoryId) {
      departmentCategory = await ensureDepartmentCategory(guild, department);

      if (department.categoryId !== departmentCategory.id) {
        await updateGuildConfig(guild.id, (current) => {
          const currentDepartment = current.departments[departmentId];
          if (currentDepartment) {
            currentDepartment.categoryId = departmentCategory!.id;
          }
        });
      }
    }

    const openCategory = await ensureOpenCategory(guild);

    const categoryId =
      departmentCategory?.type === ChannelType.GuildCategory
        ? departmentCategory.id
        : openCategory.id;

    const ticketCategory =
      guild.channels.cache.get(categoryId);

    if (
      ticketCategory?.type !== ChannelType.GuildCategory
    ) {
      await replyError(
        interaction,
        '❌ The ticket destination category is missing. Run `/supportforge setup` to repair it.',
      );
      return;
    }

    /*
     * Only active tickets block creation.
     * Closed and archived tickets do not.
     */
    let existing: TextChannel | undefined;

    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildText) {
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

    const advancedSettings = await getAdvancedSettings(guild.id);

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
      `priority=${advancedSettings.ticketDefaults.priority}`,
      `tag=${tagId}`,
      `tags=${tagId}`,
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
                advancedSettings.ticketDefaults.priority,
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

      await registerTicket(
        ticketChannel.id,
        {
          guildId: guild.id,
          ticketNumber: String(number),
          departmentId,
          tagId,
          ownerId: interaction.user.id,
          priority: advancedSettings.ticketDefaults.priority,
          createdAt: now,
        },
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
      if (isPremiumOrHigher(config.tier)) {
        void (async () => {
          try {
            await logTicketEvent(
              guild,
              auditParentCategoryId,
              {
                ticketNumber: String(number),
                event: 'ticket_created',
                actor: interaction.user.tag,
                actorId: interaction.user.id,
                actorName: interaction.user.tag,
                detail: `Ticket created in department ${department.name}${departmentCategory ? ` under ${departmentCategory.name}` : ''}.`,
              },
            );
          } catch (error) {
            console.error('⚠️ Ticket creation audit failed:', error);
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
      } else if (newStatus === 'claimed' || newStatus === 'pending') {
        const optionalCategory = await getOptionalStatusCategory(
          interaction.guild!,
          newStatus,
        );

        if (optionalCategory) {
          await moveTicketToCategory(channel, optionalCategory);
        }
      } else if (newStatus === 'reopened' || newStatus === 'open') {
        const currentConfig = await getGuildConfig(interaction.guild!.id);
        const departmentId = getField(oldTopic, 'department');
        const departmentConfig = departmentId
          ? currentConfig.departments[departmentId]
          : undefined;

        const departmentCategory = departmentConfig?.categoryId
          ? interaction.guild!.channels.cache.get(departmentConfig.categoryId)
          : undefined;

        const openCategory = await ensureOpenCategory(interaction.guild!);

        const destination =
          departmentCategory?.type === ChannelType.GuildCategory
            ? departmentCategory
            : openCategory;

        if (destination.type === ChannelType.GuildCategory) {
          await moveTicketToCategory(channel, destination);
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
        getTopicPriority(newTopic),
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
      getTicketChannelName(
        ticketNumber,
        'closed',
        getTopicPriority(topic),
      ),
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

async function renderDepartmentSelector(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  page: number,
): Promise<void> {
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ Department controls can only be used inside a ticket.');
    return;
  }

  const config = await getGuildConfig(interaction.guild.id);
  const departments = Object.values(config.departments).sort((a, b) => a.name.localeCompare(b.name));
  if (!departments.length) {
    await replyError(interaction, '❌ No departments are configured.');
    return;
  }

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(departments.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const currentDepartmentId = getField(interaction.channel.topic ?? '', 'department');
  const pageDepartments = departments.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const selector = new StringSelectMenuBuilder()
    .setCustomId('ticket:department:select:' + safePage)
    .setPlaceholder('Choose a department')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(pageDepartments.map((department) => ({
      label: department.name.slice(0, 100),
      value: department.id,
      description: (Object.keys(department.tags ?? {}).length || 0) + ' tag(s) • ' + (department.staffRoleId ? 'Staff routed' : 'Administrators'),
      default: department.id === currentDepartmentId,
    })));

  const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('ticket:department:page:' + (safePage - 1)).setLabel('Previous').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
    new ButtonBuilder().setCustomId('ticket:department:page:' + (safePage + 1)).setLabel('Next').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pageCount - 1),
    new ButtonBuilder().setCustomId('ticket:department:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  const payload = {
    content: '📂 **Change Department**\\nChoose the department that owns this ticket. The ticket will move to that department category and use that department\'s staff routing. Its first configured tag will be applied automatically.',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector), navigation],
  };

  if (interaction.replied || interaction.deferred) await interaction.editReply(payload);
  else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function changeTicketDepartment(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ This action can only be used inside a ticket.');
    return;
  }
  const channel = interaction.channel as TextChannel;
  const topic = channel.topic ?? '';
  const status = (await getPersistedTicketStatus(channel.id)) ?? getTicketStatus(topic);
  if (!isTicketTopic(topic) || !isActiveTicketStatus(status)) {
    await replyError(interaction, '❌ Only active tickets can be moved between departments.');
    return;
  }
  const staff = getStaffContext(interaction, topic);
  if (!staff.authorized) {
    await replyError(interaction, '❌ Only configured staff or administrators can change the department.');
    return;
  }

  const config = await getGuildConfig(interaction.guild.id);
  const department = config.departments[interaction.values[0]];
  if (!department) {
    await replyError(interaction, '❌ That department no longer exists. Refresh the selector.');
    return;
  }
  const tag = Object.values(department.tags ?? {}).sort((a, b) => a.name.localeCompare(b.name))[0];
  if (!tag) {
    await replyError(interaction, '❌ That department has no tags. Add at least one tag before routing tickets to it.');
    return;
  }

  const oldDepartmentId = getField(topic, 'department');
  if (oldDepartmentId === department.id) {
    await interaction.update({ content: 'ℹ️ This ticket is already in **' + department.name + '**.', components: [] });
    return;
  }

  await interaction.deferUpdate();
  try {
    const oldDepartment = oldDepartmentId ? config.departments[oldDepartmentId] : undefined;
    const category = await ensureDepartmentCategory(interaction.guild, department);
    const newTopic = setField(
      setField(
        setField(
          setField(topic, 'department', department.id),
          'staff',
          department.staffRoleId ?? 'none',
        ),
        'tag',
        tag.id,
      ),
      'tags',
      tag.id,
    );

    await runChannelMutation(channel, 'Department routing change', async () => {
      await setChannelParent(channel.id, category.id, 'Move ticket to department category');
      if (oldDepartment?.staffRoleId && oldDepartment.staffRoleId !== department.staffRoleId) {
        await setChannelPermissionOverwrite(channel.id, oldDepartment.staffRoleId, [], [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory], 0, 'Remove previous department staff access');
      }
      if (department.staffRoleId) {
        await setChannelPermissionOverwrite(channel.id, department.staffRoleId, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks], [], 0, 'Grant new department staff access');
      }
      await setChannelTopic(channel.id, newTopic, 'Update department and tag metadata');
    });

    channel.topic = newTopic;
    updateRuntimeTicketState(channel, newTopic, status);
    await updatePersistedTicketMetadata(channel.id, { departmentId: department.id, tagId: tag.id });
    await updateGuildConfig(interaction.guild.id, (current) => {
      const currentDepartment = current.departments[department.id];
      if (currentDepartment && !currentDepartment.categoryId) currentDepartment.categoryId = category.id;
    });
    await updateMainMessage(channel, getField(newTopic, 'message'), status, newTopic);
    await interaction.editReply({ content: '✅ Department changed to **' + department.name + '** and tag set to **' + tag.name + '**. The ticket was moved to ' + category.toString() + '.', components: [] });

    if (config.supportCategoryId) {
      await logTicketEvent(interaction.guild, config.supportCategoryId, {
        ticketNumber: getField(newTopic, 'number') ?? 'unknown',
        event: 'ticket_department_changed',
        actor: interaction.user.tag,
        actorId: interaction.user.id,
        actorName: interaction.user.tag,
        detail: 'Department changed from ' + (oldDepartment?.name ?? oldDepartmentId ?? 'unknown') + ' to ' + department.name + '; tag=' + tag.name + '.',
      });
    }
  } catch (error) {
    console.error('❌ Department change failed:', error);
    await interaction.editReply({ content: '❌ The department could not be changed safely.', components: [] }).catch(() => undefined);
  }
}

async function renderTicketTagSelector(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  page: number,
): Promise<void> {
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ Tag controls can only be used inside a ticket.');
    return;
  }
  const channel = interaction.channel as TextChannel;
  const departmentId = getField(channel.topic ?? '', 'department');
  const config = await getGuildConfig(interaction.guild.id);
  const department = departmentId ? config.departments[departmentId] : undefined;
  if (!department) {
    await replyError(interaction, '❌ This ticket has no valid department.');
    return;
  }

  const tags = Object.values(department.tags ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  if (!tags.length) {
    await replyError(interaction, '❌ This department has no tags configured.');
    return;
  }

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(tags.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const currentTagId = getField(channel.topic ?? '', 'tag');
  const pageTags = tags.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const selector = new StringSelectMenuBuilder()
    .setCustomId('ticket:tag:select:' + safePage)
    .setPlaceholder('Choose a tag')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(pageTags.map((tag) => ({
      label: tag.name.slice(0, 100),
      value: tag.id,
      default: tag.id === currentTagId,
    })));

  const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('ticket:tag:page:' + (safePage - 1)).setLabel('Previous').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
    new ButtonBuilder().setCustomId('ticket:tag:page:' + (safePage + 1)).setLabel('Next').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pageCount - 1),
    new ButtonBuilder().setCustomId('ticket:tag:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  const payload = {
    content: '🏷️ **Change Tag**\\nTags are subcategories of **' + department.name + '**. Changing a tag does not move the ticket to another Discord category.',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector), navigation],
  };
  if (interaction.replied || interaction.deferred) await interaction.editReply(payload);
  else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function changeTicketTag(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ This action can only be used inside a ticket.');
    return;
  }
  const channel = interaction.channel as TextChannel;
  const topic = channel.topic ?? '';
  const status = (await getPersistedTicketStatus(channel.id)) ?? getTicketStatus(topic);
  if (!isTicketTopic(topic) || !isActiveTicketStatus(status)) {
    await replyError(interaction, '❌ Only active tickets can have their tag changed.');
    return;
  }
  const staff = getStaffContext(interaction, topic);
  if (!staff.authorized) {
    await replyError(interaction, '❌ Only configured staff or administrators can change the tag.');
    return;
  }
  const departmentId = getField(topic, 'department');
  const config = await getGuildConfig(interaction.guild.id);
  const department = departmentId ? config.departments[departmentId] : undefined;
  const tag = department?.tags?.[interaction.values[0]];
  if (!department || !tag) {
    await replyError(interaction, '❌ That tag is not valid for this department.');
    return;
  }
  const oldTagId = getField(topic, 'tag');
  if (oldTagId === tag.id) {
    await interaction.update({ content: 'ℹ️ This ticket is already tagged **' + tag.name + '**.', components: [] });
    return;
  }

  await interaction.deferUpdate();
  const newTopic = setField(setField(topic, 'tag', tag.id), 'tags', tag.id);
  try {
    await runChannelMutation(channel, 'Ticket tag change', async () => {
      await setChannelTopic(channel.id, newTopic, 'Update ticket tag metadata');
    });
    channel.topic = newTopic;
    updateRuntimeTicketState(channel, newTopic, status);
    await updatePersistedTicketMetadata(channel.id, { tagId: tag.id });
    await updateMainMessage(channel, getField(newTopic, 'message'), status, newTopic);
    await interaction.editReply({ content: '✅ Ticket tag changed to **' + tag.name + '**.', components: [] });
    if (config.supportCategoryId) {
      await logTicketEvent(interaction.guild, config.supportCategoryId, {
        ticketNumber: getField(newTopic, 'number') ?? 'unknown',
        event: 'ticket_tag_changed',
        actor: interaction.user.tag,
        actorId: interaction.user.id,
        actorName: interaction.user.tag,
        detail: 'Tag changed from ' + (department.tags?.[oldTagId ?? '']?.name ?? oldTagId ?? 'unknown') + ' to ' + tag.name + ' within department ' + department.name + '.',
      });
    }
  } catch (error) {
    console.error('❌ Ticket tag change failed:', error);
    await interaction.editReply({ content: '❌ The ticket tag could not be changed.', components: [] }).catch(() => undefined);
  }
}

async function showCreationTagSelector(interaction: ButtonInteraction, departmentId: string, page = 0): Promise<void> {
  if (!interaction.guild) {
    await replyError(interaction, '❌ This action must be used inside a server.');
    return;
  }
  const config = await getGuildConfig(interaction.guild.id);
  const department = config.departments[departmentId];
  if (!department) {
    await replyError(interaction, '❌ That department no longer exists.');
    return;
  }
  const tags = Object.values(department.tags ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  if (!tags.length) {
    await replyError(interaction, '❌ This department has no tags configured. An administrator must add one first.');
    return;
  }
  if (tags.length === 1) {
    await showTicketCreationModal(interaction, departmentId, tags[0].id);
    return;
  }

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(tags.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const pageTags = tags.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const selector = new StringSelectMenuBuilder()
    .setCustomId('ticket:create-tag:select:' + departmentId + ':' + safePage)
    .setPlaceholder('Choose a ticket tag')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(pageTags.map((tag) => ({
      label: tag.name.slice(0, 100),
      value: tag.id,
      description: 'Subcategory of ' + department.name,
    })));

  const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('ticket:create-tag:page:' + departmentId + ':' + (safePage - 1)).setLabel('Previous').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
    new ButtonBuilder().setCustomId('ticket:create-tag:page:' + departmentId + ':' + (safePage + 1)).setLabel('Next').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pageCount - 1),
    new ButtonBuilder().setCustomId('ticket:create-tag:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({
    content: '🏷️ **Choose a tag for your ' + department.name + ' ticket**\\nThe tag is a subcategory used for accurate routing and later AI categorization.',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector), navigation],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTicketTagSelectionForCreation(interaction: StringSelectMenuInteraction): Promise<void> {
  const parts = interaction.customId.split(':');
  const departmentId = parts[2];
  const tagId = interaction.values[0];
  const config = interaction.guild ? await getGuildConfig(interaction.guild.id) : null;
  if (!config?.departments[departmentId]?.tags?.[tagId]) {
    await replyError(interaction, '❌ That ticket tag no longer exists.');
    return;
  }
  await showTicketCreationModal(interaction, departmentId, tagId);
}

async function showTicketCreationModal(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  departmentId: string,
  tagId: string,
): Promise<void> {
  if (!interaction.guild) {
    await replyError(interaction, '❌ This action can only be used inside a server.');
    return;
  }
  try {
    const config = await withTimeout(getGuildConfig(interaction.guild.id), DISCORD_OPERATION_TIMEOUT_MS, 'Guild configuration load');
    const department = config.departments[departmentId];
    const tag = department?.tags?.[tagId];
    if (!department || !tag) {
      await replyError(interaction, '❌ This department/tag combination no longer exists. Please refresh the support panel.');
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId('ticket:modal:' + departmentId + ':' + tagId)
      .setTitle((department.name + ' • ' + tag.name).slice(0, 45));

    const subjectInput = new TextInputBuilder()
      .setCustomId('subject')
      .setLabel('What do you need help with?')
      .setPlaceholder('Briefly describe your issue')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const descriptionInput = new TextInputBuilder()
      .setCustomId('description')
      .setLabel('Describe your issue (up to 4000 characters)')
      .setPlaceholder('Give us the details we need to help you...')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(subjectInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput),
    );
    await interaction.showModal(modal);
  } catch (error) {
    console.error('❌ Failed to show ticket creation form:', error);
    await replyError(interaction, '❌ SupportForge could not open the ticket creation form.');
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

  if (
    id === 'ticket:panel:move-bottom' ||
    id === 'ticket:panel:restore-move'
  ) {
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

      const panelMoveConfig = await getGuildConfig(channel.guild.id);
      if (panelMoveConfig.supportCategoryId) {
        await logTicketEvent(
          channel.guild,
          panelMoveConfig.supportCategoryId,
          {
            ticketNumber: getField(topic, 'number') ?? 'unknown',
            event: 'ticket_panel_moved',
            actor: interaction.user.tag,
            actorId: interaction.user.id,
            actorName: interaction.user.tag,
            detail: 'Ticket controls manually moved/restored to the bottom.',
          },
        );
      }

      await interaction.editReply(
        '✅ Ticket controls were moved to the bottom. Automatic panel activity tracking is armed again.',
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
      'ticket:panel:department' ||
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
    } else if (id === 'ticket:panel:department') {
      await renderDepartmentSelector(interaction, 0);
      return;
    } else if (id === 'ticket:panel:tag') {
      await renderTicketTagSelector(interaction, 0);
      return;
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

      const userConfig = await getGuildConfig(channel.guild.id);
      if (userConfig.supportCategoryId) {
        await logTicketEvent(
          channel.guild,
          userConfig.supportCategoryId,
          {
            ticketNumber: getField(channel.topic ?? '', 'number') ?? 'unknown',
            event: 'ticket_user_added',
            actor: interaction.user.tag,
            actorId: interaction.user.id,
            actorName: interaction.user.tag,
            detail: 'Added user <@' + userId + '> to the ticket.',
          },
        );
      }

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

      const parsedPriority = parseTicketPriority(priority);

      if (!parsedPriority) {
        await interaction.editReply(
          '❌ Priority must be `low`, `normal`, `high`, `urgent`, or `critical`.',
        );
        return;
      }

      newTopic =
        setField(
          newTopic,
          'priority',
          parsedPriority,
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

      void queueTicketChannelRename(
        channel,
        getTicketChannelName(
          getField(newTopic, 'number') ?? 'unknown',
          state.status,
          parsedPriority,
        ),
        `Ticket priority changed to ${parsedPriority}`,
      ).catch((error) => {
        console.error('⚠️ Failed to rename ticket for priority change:', error);
      });

      await interaction.editReply(
        `✅ Ticket priority changed to **${parsedPriority}**.`,
      );

      const priorityConfig = await getGuildConfig(channel.guild.id);
      if (priorityConfig.supportCategoryId) {
        await logTicketEvent(
          channel.guild,
          priorityConfig.supportCategoryId,
          {
            ticketNumber: getField(newTopic, 'number') ?? 'unknown',
            event: 'ticket_priority_changed',
            actor: interaction.user.tag,
            actorId: interaction.user.id,
            actorName: interaction.user.tag,
            detail: 'Priority changed to ' + parsedPriority + '.',
          },
        );
      }

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
    | StringSelectMenuInteraction
    | ModalSubmitInteraction,
): Promise<void> {
  try {
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('ticket:department:select:')) {
        await changeTicketDepartment(interaction);
        return;
      }
      if (interaction.customId.startsWith('ticket:tag:select:')) {
        await changeTicketTag(interaction);
        return;
      }
      if (interaction.customId.startsWith('ticket:create-tag:select:')) {
        await handleTicketTagSelectionForCreation(interaction);
        return;
      }
    }

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

        await showCreationTagSelector(interaction, departmentId);

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
      if (interaction.customId.startsWith('ticket:modal:')) {
        const parts = interaction.customId.split(':');
        const departmentId = parts[2] ?? '';
        const tagId = parts[3] ?? '';

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
          tagId,
        );

        return;
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