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

const ticketActionLocks = new Set<string>();
const ticketCreationLocks = new Set<string>();

interface RuntimeTicketState {
  topic: string;
  status: TicketStatus;
  updatedAt: number;
}

const ticketRuntimeCache = new Map<
  string,
  RuntimeTicketState
>();

function isActiveTicketStatus(
  status: TicketStatus,
): boolean {
  return ACTIVE_TICKET_STATUSES.includes(
    status,
  );
}

function isTerminalTicketStatus(
  status: TicketStatus,
): boolean {
  return TERMINAL_TICKET_STATUSES.includes(
    status,
  );
}

/* -------------------------------------------------------------------------- */
/* Timeout helper                                                             */
/* -------------------------------------------------------------------------- */

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>(
    (_, reject) => {
      timeoutHandle = setTimeout(() => {
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
      timeoutPromise,
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Runtime ticket state                                                       */
/* -------------------------------------------------------------------------- */

function getRuntimeTicketState(
  channel: TextChannel,
): RuntimeTicketState {
  const topic =
    channel.topic ?? '';

  const cached =
    ticketRuntimeCache.get(
      channel.id,
    );

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

  return {
    ownerId,
    staffRole,
    isStaff,
    authorized:
      isStaff ||
      isAdmin(interaction),
  };
}

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
/* Ticket panel                                                              */
/* -------------------------------------------------------------------------- */

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

    const message =
      channel.messages.cache.get(
        messageId,
      ) ??
      await withTimeout(
        channel.messages.fetch(
          messageId,
        ),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Ticket panel fetch',
      );

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

/**
 * Disable the panel while a state-changing operation is running.
 *
 * We deliberately rebuild the panel from the ticket state instead of
 * inspecting TopLevelComponent internals. This avoids the discord.js
 * v14 component typing problem from the previous implementation.
 */
async function lockTicketButtons(
  channel: TextChannel,
  messageId: string | undefined,
): Promise<void> {
  if (!messageId) {
    return;
  }

  try {
    const message =
      channel.messages.cache.get(
        messageId,
      ) ??
      await withTimeout(
        channel.messages.fetch(
          messageId,
        ),
        5_000,
        'Ticket panel fetch',
      );

    const disabledRows =
      buildDisabledRows(
        message.components,
      );

    await withTimeout(
      message.edit({
        components:
          disabledRows,
      }),
      5_000,
      'Ticket button lock',
    );
  } catch (error) {
    console.error(
      '⚠️ Failed to lock ticket buttons:',
      error,
    );
  }
}

/**
 * Discord.js exposes components as TopLevelComponent objects.
 * Instead of reading row.components and fighting the type system,
 * rebuild a simple disabled version from the component IDs.
 */
function buildDisabledRows(
  components: readonly unknown[],
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] =
    [];

  for (const row of components) {
    const rawRow =
      row as {
        components?: readonly unknown[];
      };

    if (
      !Array.isArray(
        rawRow.components,
      )
    ) {
      continue;
    }

    const buttons: ButtonBuilder[] =
      [];

    for (const rawComponent of
      rawRow.components) {
      const component =
        rawComponent as {
          type?: number;
          customId?: string;
          label?: string | null;
          style?: number;
          emoji?: {
            name?: string | null;
            id?: string | null;
            animated?: boolean;
          } | null;
          url?: string | null;
          disabled?: boolean;
        };

      /*
       * Discord component type 2 = Button.
       */
      if (
        component.type !== 2 ||
        !component.customId
      ) {
        continue;
      }

      const button =
        new ButtonBuilder()
          .setCustomId(
            component.customId,
          )
          .setDisabled(true);

      if (
        component.label
      ) {
        button.setLabel(
          component.label,
        );
      }

      if (
        typeof component.style ===
        'number'
      ) {
        switch (
          component.style
        ) {
          case ButtonStyle.Primary:
            button.setStyle(
              ButtonStyle.Primary,
            );
            break;

          case ButtonStyle.Secondary:
            button.setStyle(
              ButtonStyle.Secondary,
            );
            break;

          case ButtonStyle.Success:
            button.setStyle(
              ButtonStyle.Success,
            );
            break;

          case ButtonStyle.Danger:
            button.setStyle(
              ButtonStyle.Danger,
            );
            break;

          case ButtonStyle.Link:
            /*
             * Link buttons do not have custom IDs and therefore
             * are not expected in the SupportForge ticket panel.
             */
            continue;

          default:
            button.setStyle(
              ButtonStyle.Secondary,
            );
        }
      } else {
        button.setStyle(
          ButtonStyle.Secondary,
        );
      }

      if (
        component.emoji?.name
      ) {
        button.setEmoji(
          component.emoji.name,
        );
      }

      buttons.push(
        button,
      );
    }

    if (buttons.length) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            buttons,
          ),
      );
    }
  }

  return rows;
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

function buildClosedOverwrites(
  ownerId: string | undefined,
  staffRoleId: string | null,
  users: string[],
  botId: string,
  everyoneId: string,
  archived: boolean,
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

  const readOnly = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  const ids =
    new Set<string>([
      ...(ownerId
        ? [ownerId]
        : []),
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

    if (
      archived &&
      id !== staffRoleId
    ) {
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
      deny: [
        PermissionFlagsBits.SendMessages,
      ],
    });
  }

  return overwrites;
}

async function restoreTicketPermissions(
  channel: TextChannel,
  topic: string,
): Promise<void> {
  const bot =
    channel.guild.members.me;

  if (!bot) {
    throw new Error(
      'Bot member unavailable.',
    );
  }

  const ownerId =
    getField(
      topic,
      'owner',
    );

  if (!ownerId) {
    throw new Error(
      'Ticket owner is missing.',
    );
  }

  const staffRoleId =
    getField(
      topic,
      'staff',
    );

  const users =
    (
      getField(
        topic,
        'users',
      ) ?? ''
    )
      .split(',')
      .map((id) =>
        id.trim(),
      )
      .filter(Boolean);

  await withTimeout(
    channel.permissionOverwrites.set(
      buildOpenOverwrites(
        ownerId,
        staffRoleId &&
        staffRoleId !== 'none'
          ? staffRoleId
          : undefined,
        users,
        bot.id,
        channel.guild.roles
          .everyone.id,
      ),
    ),
    DISCORD_OPERATION_TIMEOUT_MS,
    'Restore ticket permissions',
  );
}

async function lockTicketPermissions(
  channel: TextChannel,
  topic: string,
  archived: boolean,
): Promise<void> {
  const bot =
    channel.guild.members.me;

  if (!bot) {
    throw new Error(
      'Bot member unavailable.',
    );
  }

  const permissions =
    channel.permissionsFor(
      bot,
    );

  if (
    !permissions?.has(
      PermissionFlagsBits.ManageChannels,
    )
  ) {
    throw new Error(
      'SupportForge is missing Manage Channels permission.',
    );
  }

  const ownerId =
    getField(
      topic,
      'owner',
    );

  const staffRoleId =
    getField(
      topic,
      'staff',
    );

  const users =
    (
      getField(
        topic,
        'users',
      ) ?? ''
    )
      .split(',')
      .map((id) =>
        id.trim(),
      )
      .filter(Boolean);

  await withTimeout(
    channel.permissionOverwrites.set(
      buildClosedOverwrites(
        ownerId,
        staffRoleId &&
        staffRoleId !== 'none'
          ? staffRoleId
          : null,
        users,
        bot.id,
        channel.guild.roles
          .everyone.id,
        archived,
      ),
    ),
    DISCORD_OPERATION_TIMEOUT_MS,
    archived
      ? 'Archive ticket permissions'
      : 'Close ticket permissions',
  );
}

/* -------------------------------------------------------------------------- */
/* Ticket creation                                                            */
/* -------------------------------------------------------------------------- */

async function createTicket(
  interaction: ModalSubmitInteraction,
  departmentId: string,
): Promise<void> {
  const guild =
    interaction.guild!;

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

    const categoryId =
      config.supportCategoryId;

    if (!categoryId) {
      await replyError(
        interaction,
        '❌ SupportForge is not configured. Run `/supportforge setup` first.',
      );
      return;
    }

    const category =
      guild.channels.cache.get(
        categoryId,
      );

    if (
      !category ||
      category.type !==
        ChannelType.GuildCategory
    ) {
      await replyError(
        interaction,
        '❌ The SupportForge category is missing. Run `/supportforge setup` to repair it.',
      );
      return;
    }

    /*
     * Only ACTIVE tickets block a new ticket.
     *
     * CLOSED and ARCHIVED tickets do not block creation.
     */
    const existing =
      guild.channels.cache.find(
        (channel) => {
          if (
            channel.type !==
              ChannelType.GuildText ||
            channel.parentId !==
              categoryId
          ) {
            return false;
          }

          const topic =
            channel.topic ?? '';

          if (
            !isTicketTopic(
              topic,
            )
          ) {
            return false;
          }

          if (
            getField(
              topic,
              'owner',
            ) !==
            interaction.user.id
          ) {
            return false;
          }

          if (
            getField(
              topic,
              'department',
            ) !==
            departmentId
          ) {
            return false;
          }

          const status =
            getTicketStatus(
              topic,
            );

          return isActiveTicketStatus(
            status,
          );
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
      `description=${encodeURIComponent(
        cleanDescription,
      )}`,
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
              `ticket-${String(
                number,
              ).padStart(
                4,
                '0',
              )}`,
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

      /*
       * "message" is the field used by ticketPanelService.
       */
      const finalTopic =
        setField(
          topic,
          'message',
          panel.id,
        );

      await withTimeout(
        ticketChannel.setTopic(
          finalTopic,
        ),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Ticket topic initialization',
      );

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
       * Audit is deliberately non-blocking.
       */
      if (
        isPremiumOrHigher(
          config.tier,
        )
      ) {
        void Promise.resolve()
          .then(async () => {
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
          });
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

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  try {
    const state =
      getRuntimeTicketState(
        channel,
      );

    const oldTopic =
      state.topic;

    const oldStatus =
      state.status;

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
     * A closed ticket can only be reopened.
     * An archived ticket cannot be transitioned by this path.
     */
    if (
      oldStatus === 'archived'
    ) {
      await interaction.editReply(
        '❌ This ticket is archived and cannot be changed.',
      );
      return;
    }

    if (
      oldStatus === 'closed' &&
      newStatus !== 'reopened'
    ) {
      await interaction.editReply(
        '❌ This ticket is closed. Reopen it before changing its status.',
      );
      return;
    }

    const staff =
      getStaffContext(
        interaction,
        oldTopic,
      );

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

    if (
      newStatus === 'open' &&
      !staff.authorized &&
      staff.ownerId !==
        interaction.user.id
    ) {
      await interaction.editReply(
        '❌ You are not authorized to resume this ticket.',
      );
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
     * Visual lock. This is best-effort and does not block the state
     * transition if Discord happens to be slow.
     */
    void lockTicketButtons(
      channel,
      messageId,
    );

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
       * Restore access before committing the reopened state.
       */
      await restoreTicketPermissions(
        channel,
        newTopic,
      );
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

      await lockTicketPermissions(
        channel,
        newTopic,
        true,
      );
    }

    newTopic =
      setField(
        newTopic,
        'status',
        newStatus,
      );

    await withTimeout(
      channel.setTopic(
        newTopic,
      ),
      DISCORD_OPERATION_TIMEOUT_MS,
      'Ticket status update',
    );

    updateRuntimeTicketState(
      channel,
      newTopic,
      newStatus,
    );

    /*
     * Reopen a channel previously renamed with "-closed".
     */
    if (
      newStatus ===
        'reopened' &&
      channel.name.endsWith(
        '-closed',
      )
    ) {
      void queueTicketChannelRename(
        channel,
        channel.name.replace(
          /-closed$/,
          '',
        ),
        `Ticket #${
          getField(
            newTopic,
            'number',
          ) ?? 'unknown'
        } reopened`,
      ).catch((error) => {
        console.error(
          '⚠️ Failed to rename reopened ticket:',
          error,
        );
      });
    }

    /*
     * Panel refresh is non-critical.
     */
    void updateMainMessage(
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

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  try {
    const state =
      getRuntimeTicketState(
        channel,
      );

    const topic =
      state.topic;

    const status =
      state.status;

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
     * This is intentionally topic-based.
     * Permission overwrites are NOT used to decide whether a ticket
     * is already closed.
     */
    if (
      status === 'closed'
    ) {
      await interaction.editReply(
        '❌ This ticket is already closed.',
      );
      return;
    }

    if (
      status === 'archived'
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

    void lockTicketButtons(
      channel,
      messageId,
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

    const openedAt =
      openedAtRaw
        ? new Date(
            openedAtRaw,
          )
        : new Date();

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
     * Transcript is generated BEFORE changing status to closed.
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

    /*
     * AttachmentBuilder must be passed directly.
     * It must NOT be wrapped inside { attachment: transcript }.
     */
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
     * Only after the transcript has successfully uploaded do we lock
     * the ticket and commit status=closed.
     */
    await lockTicketPermissions(
      channel,
      topic,
      false,
    );

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

    await withTimeout(
      channel.setTopic(
        closedTopic,
      ),
      DISCORD_OPERATION_TIMEOUT_MS,
      'Closed ticket topic update',
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
     * Background panel refresh.
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
     * Background rename.
     */
    void queueTicketChannelRename(
      channel,
      channel.name.endsWith(
        '-closed',
      )
        ? channel.name
        : `${channel.name}-closed`,
      `Ticket #${ticketNumber} closed`,
    ).catch((error) => {
      console.error(
        '⚠️ Failed to rename closed ticket:',
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
/* Panel button handlers                                                      */
/* -------------------------------------------------------------------------- */

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

  /*
   * These are the actual IDs produced by ticketPanelService.
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

    await interaction.showModal(
      modal,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Panel modal handlers                                                       */
/* -------------------------------------------------------------------------- */

async function handlePanelModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
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

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  try {
    let newTopic =
      state.topic;

    const id =
      interaction.customId;

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

      await withTimeout(
        channel.permissionOverwrites.edit(
          userId,
          {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
            EmbedLinks: true,
          },
        ),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Add ticket user permissions',
      );

      await withTimeout(
        channel.setTopic(
          newTopic,
        ),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Add ticket user topic update',
      );

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
        ]);

      if (
        !valid.has(
          priority,
        )
      ) {
        await interaction.editReply(
          '❌ Priority must be `low`, `normal`, `high`, or `urgent`.',
        );
        return;
      }

      newTopic =
        setField(
          newTopic,
          'priority',
          priority,
        );

      await withTimeout(
        channel.setTopic(
          newTopic,
        ),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Priority update',
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

      await withTimeout(
        channel.setTopic(
          newTopic,
        ),
        DISCORD_OPERATION_TIMEOUT_MS,
        'Tag update',
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

      return;
    }

    if (
      interaction.isModalSubmit()
    ) {
      /*
       * Ticket creation modal.
       *
       * Expected custom ID:
       * ticket:modal:<departmentId>
       *
       * We also support:
       * ticket:modal
       * if the department field exists.
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
           * The existing modal may encode the department
           * in its custom ID instead.
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