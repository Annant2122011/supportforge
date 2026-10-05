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
  type DepartmentConfig,
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
import { endTicketVoiceMode, startTicketVoiceMode, syncTicketVoiceParticipants } from '../services/voiceModeService';
import { getUserFlagCount, isTicketCreationRestricted, recordReport } from '../services/reportService';

import {
  getPersistedTicketPriority,
  getPersistedTicketStatus,
  registerTicket,
  setPersistedTicketStatus,
  updatePersistedTicketMetadata,
} from '../services/ticketPersistenceService';

import {
  getTicketAuditHistory,
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

async function getEffectiveTicketPriority(
  channelId: string,
  topic: string,
): Promise<TicketPriority> {
  return (
    (await getPersistedTicketPriority(channelId).catch(() => undefined)) ??
    getTopicPriority(topic)
  );
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
    previous.catch(() => undefined).then(() => gate);

  ticketMutationQueues.set(
    channel.id,
    current,
  );

  /*
   * Wait for the previous mutation, but never let a broken Discord REST
   * request hold the entire ticket queue hostage forever.
   */
  await previous.catch(() => undefined);

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
interface PendingReportDecision {
  guildId: string;
  channelId: string;
  targetUserId: string;
  categoryId: string;
  subcategoryId: string;
  description: string;
  reporterUserId: string;
  ticketNumber?: string;
}

const pendingReportDecisions = new Map<string, PendingReportDecision>();

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
    ) ||
      interaction.memberPermissions?.has(
        PermissionFlagsBits.ManageGuild,
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

function getRateLimitRetryDelayMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const secondsMatch = message.match(/another\s+(\d+)s\b/i);
  if (secondsMatch) {
    const seconds = Number(secondsMatch[1]);
    return Number.isFinite(seconds) && seconds > 0
      ? (seconds + 1) * 1000
      : null;
  }

  const millisecondsMatch = message.match(/another\s+(\d+)ms\b/i);
  if (millisecondsMatch) {
    const milliseconds = Number(millisecondsMatch[1]);
    return Number.isFinite(milliseconds) && milliseconds > 0
      ? milliseconds + 1000
      : null;
  }

  return null;
}



async function removePreviousTicketTranscript(
  guild: import('discord.js').Guild,
  topic: string,
): Promise<void> {
  const transcriptChannelId = (await getGuildConfig(guild.id)).transcriptChannelId;
  const transcriptMessageId = getField(topic, 'transcript_id');

  if (!transcriptChannelId) {
    return;
  }

  const transcriptChannel = guild.channels.cache.get(transcriptChannelId);
  if (!transcriptChannel || transcriptChannel.type !== ChannelType.GuildText) {
    return;
  }

  if (transcriptMessageId) {
    const previousTranscript =
      transcriptChannel.messages.cache.get(transcriptMessageId) ??
      await transcriptChannel.messages.fetch(transcriptMessageId).catch(() => null);

    if (previousTranscript) {
      await previousTranscript.delete().catch((error) => {
        console.warn(
          `⚠️ Could not delete previous transcript ${transcriptMessageId} for ticket ${getField(topic, 'number') ?? 'unknown'}:`,
          error,
        );
      });
    }
    return;
  }

  /*
   * Legacy fallback: older tickets did not store the transcript message ID.
   * Remove matching SupportForge transcript posts from the recent transcript
   * history, without touching unrelated files/messages.
   */
  const ticketNumber = getField(topic, 'number') ?? 'unknown';
  const recent = await transcriptChannel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return;

  for (const message of recent.values()) {
    if (
      message.author.id === guild.client.user?.id &&
      message.content === `📄 Transcript for ticket **#${ticketNumber}**`
    ) {
      await message.delete().catch(() => undefined);
    }
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

    const persistedPriority = await getPersistedTicketPriority(channel.id).catch(() => undefined);
    const panelTopic = setField(
      topic,
      'status',
      status,
    );
    const effectivePanelTopic = persistedPriority
      ? setField(panelTopic, 'priority', persistedPriority)
      : panelTopic;

    await withTimeout(
      message.edit({
        embeds: [
          buildTicketPanelEmbed(
            channel.guild,
            channel.name,
            effectivePanelTopic,
            config,
          ),
        ],
        components:
          buildTicketPanelComponents(
            status,
            effectivePanelTopic,
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


async function applyTicketVisibilityMode(
  channel: TextChannel,
  topic: string,
  mode: 'unclaimed' | 'claimed',
  formerClaimedBy?: string,
): Promise<void> {
  const staffRoleId = getField(topic, 'staff');
  const ownerId = getField(topic, 'owner');
  const claimedBy = getField(topic, 'claimed_by');
  const claimedModerators = (claimedBy ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const users = (getField(topic, 'users') ?? '').split(',').map((value) => value.trim()).filter(Boolean);

  if (!channel.guild.members.me || !ownerId) {
    throw new Error('Ticket privacy could not resolve the bot or ticket owner.');
  }

  const textPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  const memberAllow = [
    ...textPermissions,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];

  if (staffRoleId && staffRoleId !== 'none') {
    await setChannelPermissionOverwrite(
      channel.id,
      staffRoleId,
      mode === 'claimed' ? [] : textPermissions,
      mode === 'claimed' ? textPermissions : [],
      0,
      mode === 'claimed'
        ? 'Hide claimed ticket from unassigned department staff'
        : 'Restore department staff access to ticket',
    );
  }

  const formerClaimantIds = (formerClaimedBy ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  for (const formerClaimantId of formerClaimantIds) {
    if (
      formerClaimantId === ownerId ||
      claimedModerators.includes(formerClaimantId)
    ) {
      continue;
    }

    await setChannelPermissionOverwrite(
      channel.id,
      formerClaimantId,
      [],
      [],
      1,
      'Clear former claimant ticket override',
    );
  }

  const participants = new Set<string>([
    ownerId,
    ...users,
    ...(mode === 'claimed' ? claimedModerators : []),
  ]);

  for (const userId of participants) {
    if (!userId || userId === channel.guild.members.me.id) continue;
    await setChannelPermissionOverwrite(channel.id, userId, memberAllow, [], 1, 'Grant ticket participant access');
  }
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
    `${guild.id}:${interaction.user.id}:${departmentId}:${tagId}`;

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

  if (await isTicketCreationRestricted(guild.id, interaction.user.id)) {
    const flags = await getUserFlagCount(guild.id, interaction.user.id);
    await replyError(
      interaction,
      `🚫 You are currently restricted from opening new SupportForge tickets because your account has reached **${flags}** moderation flag(s).`,
    );
    ticketCreationLocks.delete(lockKey);
    return;
  }

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
        '❌ This department/tag combination no longer exists. Please refresh the support panel.',
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

    /*
     * This is the first point at which we know a real ticket is actually
     * being created. Do not create an otherwise-empty department category
     * before validating the submitted ticket.
     */
    const departmentCategory =
      await ensureDepartmentCategory(guild, department);

    if (department.categoryId !== departmentCategory.id) {
      await updateGuildConfig(guild.id, (current) => {
        const currentDepartment = current.departments[departmentId];
        if (currentDepartment) {
          currentDepartment.categoryId = departmentCategory.id;
        }
      });
    }

    const ticketCategory =
      guild.channels.cache.get(departmentCategory.id);

    if (
      ticketCategory?.type !== ChannelType.GuildCategory
    ) {
      await replyError(
        interaction,
        '❌ The ticket destination category is missing. Run `/supportforge setup` to repair it.',
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
      subject
        .replace(/\s+/g, ' ')
        .trim();

    /*
     * Preserve the customer's formatting exactly. In particular, do not
     * collapse whitespace here: pasted support requests commonly contain
     * paragraphs, blank lines, numbered steps, and bullet points.
     *
     * Discord modal text inputs currently cap this field at 4,000 characters,
     * so the value arriving here is already within the supported range.
     */
    const cleanDescription =
      description
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');

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
              departmentCategory.id,
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
                topic,
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

      /*
       * Persist the panel message ID when Discord is reachable. A temporary
       * native REST timeout must not make a successfully created ticket fail.
       * The full topic is still kept in runtime state for this process.
       */
      try {
        await setChannelTopic(
          ticketChannel.id,
          finalTopic,
          'Ticket topic initialization',
        );
      } catch (error) {
        console.warn(
          '⚠️ Ticket topic initialization timed out or failed; keeping the ticket and scheduling a retry:',
          error,
        );

        void new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000);
        })
          .then(() =>
            setChannelTopic(
              ticketChannel!.id,
              finalTopic,
              'Ticket topic initialization retry',
            ),
          )
          .catch((retryError) => {
            console.warn(
              '⚠️ Ticket topic initialization retry failed:',
              retryError,
            );
          });
      }

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
          allowedMentions: {
            parse: [],
          },
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
       * Audit logging is a core feature, not a paid-tier gate. It runs in the
       * background so the ticket response never waits on audit publishing.
       */
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
              detail: `Ticket created in department ${department.name} under ${departmentCategory.name}.`,
            },
          );
        } catch (error) {
          console.error('⚠️ Ticket creation audit failed:', error);
        }
      })();
    } catch (error) {
      /*
       * A ticket channel is a real user-facing record as soon as Discord
       * creates it. Never delete it merely because a later initialization
       * step failed. The old cleanup behavior made a valid ticket appear for
       * a moment and then silently destroyed it, especially when a topic,
       * persistence, or message operation was temporarily unavailable.
       *
       * Keep the channel so the next repair/refresh can recover it and so the
       * user never loses the support request they just submitted.
       */
      if (ticketChannel) {
        console.error(
          `⚠️ Ticket #${getField(ticketChannel.topic ?? '', 'number') ?? 'unknown'} was created but initialization did not complete. The channel has been preserved for recovery.`,
          error,
        );

        await ticketChannel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('⚠️ SupportForge Ticket Recovery')
              .setDescription(
                'The ticket channel was created successfully, but one initialization step did not complete. The ticket has **not** been deleted. An administrator can use **Repair System** or refresh the ticket panel to complete recovery.',
              )
              .setTimestamp(),
          ],
        }).catch((recoveryError) => {
          console.error(
            '⚠️ Could not post the ticket recovery notice:',
            recoveryError,
          );
        });

        await interaction.editReply({
          content:
            `✅ Your ticket channel was created: ${ticketChannel}
⚠️ One setup step did not complete, so SupportForge preserved the ticket for recovery instead of reporting a false creation failure.`,
        }).catch(() => undefined);

        return;
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

async function unclaimModerator(interaction: ButtonInteraction): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ This action can only be used inside a ticket.');
    return;
  }

  const channel = interaction.channel as TextChannel;
  const topic = channel.topic ?? '';
  const status = (await getPersistedTicketStatus(channel.id)) ?? getTicketStatus(topic);
  if (status !== 'claimed') {
    await replyError(interaction, '❌ This ticket is not currently claimed.');
    return;
  }

  const claimants = (getField(topic, 'claimed_by') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!claimants.includes(interaction.user.id)) {
    await replyError(interaction, '❌ You are not currently assisting on this ticket.');
    return;
  }

  const remaining = claimants.filter((id) => id !== interaction.user.id);
  let newTopic = topic;

  if (remaining.length) {
    newTopic = setField(newTopic, 'claimed_by', remaining.join(','));
    await setChannelTopic(channel.id, newTopic, 'SupportForge moderator unclaimed from multi-moderator ticket').catch(() => undefined);
    channel.topic = newTopic;
    updateRuntimeTicketState(channel, newTopic, 'claimed');
    await syncTicketVoiceParticipants(interaction.guild, newTopic);
    await updateMainMessage(channel, getField(newTopic, 'message'), 'claimed', newTopic);
    await interaction.editReply('✅ You left the ticket. Other assigned moderators remain on it.');
    return;
  }

  newTopic = removeField(newTopic, 'claimed_by');
  newTopic = removeField(newTopic, 'claimed_at');
  newTopic = setField(newTopic, 'status', 'open');

  if (getField(newTopic, 'voice_channel_id')) {
    newTopic = await endTicketVoiceMode(
      interaction.guild,
      channel,
      newTopic,
      'open',
      'SupportForge voice mode ended because the final moderator unclaimed the ticket',
    );
  }

  await setChannelTopic(channel.id, newTopic, 'SupportForge last moderator unclaimed ticket').catch(() => undefined);
  channel.topic = newTopic;
  await setPersistedTicketStatus(channel.id, 'open');
  await applyTicketVisibilityMode(channel, newTopic, 'unclaimed', interaction.user.id);
  updateRuntimeTicketState(channel, newTopic, 'open');

  const number = getField(newTopic, 'number') ?? 'unknown';
  void queueTicketChannelRename(
    channel,
    getTicketChannelName(number, 'open', await getEffectiveTicketPriority(channel.id, newTopic)),
    'Ticket returned to open after final moderator unclaimed',
  ).catch(() => undefined);

  await updateMainMessage(channel, getField(newTopic, 'message'), 'open', newTopic);
  await interaction.editReply('✅ You left the ticket. It is now open for another moderator to claim.');
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
     * A claimed ticket can be joined by another moderator until the configured
     * simultaneous-moderator limit is reached.
     */
    if (
      oldStatus === newStatus &&
      !(newStatus === 'claimed' && interaction.customId === 'ticket:claim')
    ) {
      await interaction.editReply(
        `ℹ️ This ticket is already **${capitalize(newStatus)}**.`,
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

    if (newStatus === 'claimed') {
      const claimedIds = (getField(oldTopic, 'claimed_by') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      const settings = await getAdvancedSettings(interaction.guild!.id);

      if (claimedIds.includes(interaction.user.id)) {
        await interaction.editReply('ℹ️ You are already assisting on this ticket.');
        return;
      }

      if (claimedIds.length >= settings.ticketDefaults.maxClaimedModerators) {
        await interaction.editReply(
          `❌ This ticket already has the maximum of **${settings.ticketDefaults.maxClaimedModerators}** moderators assisting.`,
        );
        return;
      }
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
      const existingClaimants = (getField(oldTopic, 'claimed_by') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      if (!existingClaimants.includes(interaction.user.id)) {
        existingClaimants.push(interaction.user.id);
      }

      newTopic = setField(
        newTopic,
        'claimed_by',
        existingClaimants.join(','),
      );

      newTopic = setField(
        newTopic,
        'claimed_at',
        new Date().toISOString(),
      );

      newTopic = removeField(
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
      try {
        await removePreviousTicketTranscript(
          interaction.guild!,
          oldTopic,
        );
      } catch (error) {
        console.warn(
          '⚠️ Previous ticket transcript could not be removed during reopen:',
          error,
        );
      }

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

      newTopic =
        removeField(
          newTopic,
          'transcript_id',
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
    if (newStatus === 'claimed') {
      await setChannelTopic(
        channel.id,
        newTopic,
        'Persist SupportForge multi-moderator claim metadata',
      ).catch((error) => {
        console.warn('⚠️ Claimed ticket metadata topic update was deferred:', error);
      });
      channel.topic = newTopic;
      await applyTicketVisibilityMode(channel, newTopic, 'claimed');
      await syncTicketVoiceParticipants(interaction.guild!, newTopic);
    } else if (newStatus === 'open' || newStatus === 'pending' || newStatus === 'reopened') {
      await setChannelTopic(
        channel.id,
        newTopic,
        'Persist SupportForge ticket lifecycle metadata',
      ).catch((error) => {
        console.warn('⚠️ Ticket lifecycle metadata topic update was deferred:', error);
      });
      channel.topic = newTopic;
      await applyTicketVisibilityMode(
        channel,
        newTopic,
        'unclaimed',
        getField(oldTopic, 'claimed_by'),
      );
    }

    if (newStatus !== 'claimed' && getField(oldTopic, 'voice_channel_id')) {
      newTopic = await endTicketVoiceMode(
        interaction.guild!,
        channel,
        newTopic,
        newStatus,
        'SupportForge voice mode ended because ticket status changed',
      );
      updateRuntimeTicketState(channel, newTopic, newStatus);
    }

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
        await getEffectiveTicketPriority(channel.id, newTopic),
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

    const transcriptMessage = await withTimeout(
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
    const voiceClearedTopic = getField(topic, 'voice_channel_id')
      ? await endTicketVoiceMode(
          interaction.guild!,
          channel,
          topic,
          'closed',
          'SupportForge voice mode ended because ticket was closed',
        )
      : topic;

    const closedTopic =
      setField(
        setField(
          setField(
            voiceClearedTopic,
            'status',
            'closed',
          ),
          'closed_at',
          closedAt.toISOString(),
        ),
        'transcript_id',
        transcriptMessage.id,
      );

    await setPersistedTicketStatus(
      channel.id,
      'closed',
    );

    /*
     * Persist transcript/closure metadata in the channel topic as well as the
     * local lifecycle store. Reopen and retention use this metadata to find the
     * previous transcript and calculate eligibility after a restart.
     */
    await setChannelTopic(
      channel.id,
      closedTopic,
      'SupportForge persist closed ticket metadata',
    ).catch((error) => {
      console.warn(
        `⚠️ Could not persist closed ticket metadata in channel topic; local status remains authoritative for ticket #${ticketNumber}:`,
        error,
      );
    });

    /*
     * The dedicated close flow does not use transition('closed'), so it must
     * explicitly move the ticket into the configured Closed storage bucket.
     * Without this, closed tickets remain in an active department category and
     * retention/storage rules cannot manage the lifecycle consistently.
     */
    await moveTicketToCategory(
      channel,
      await ensureClosedCategory(interaction.guild!),
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
        await getEffectiveTicketPriority(channel.id, topic),
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

async function showTicketTagSelector(
  interaction: ButtonInteraction,
  departmentId: string,
  page = 0,
): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  if (!interaction.guild) {
    await replyError(interaction, '❌ This action must be used inside a server.');
    return;
  }

  const config = await getGuildConfig(interaction.guild.id);
  const department = config.departments[departmentId];
  if (!department) {
    await replyError(interaction, '❌ This department no longer exists.');
    return;
  }

  const tags = Object.values(department.tags ?? {}).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (!tags.length) {
    await replyError(
      interaction,
      '❌ This department has no tags configured. Ask an administrator to add one.',
    );
    return;
  }

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(tags.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visibleTags = tags.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket:create-tag:select:' + departmentId)
    .setPlaceholder('Choose a tag')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      visibleTags.map((tag) => ({
        label: tag.name.slice(0, 100),
        value: tag.id,
        description: 'Subcategory of ' + department.name,
      })),
    );

  const components: Array<
    ActionRowBuilder<StringSelectMenuBuilder> |
    ActionRowBuilder<ButtonBuilder>
  > = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
  ];

  if (pageCount > 1) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            'ticket:create-tag:page:' + departmentId + ':' + (safePage - 1),
          )
          .setLabel('Previous')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage === 0),
        new ButtonBuilder()
          .setCustomId('ticket:create-tag:page:' + departmentId + ':' + safePage)
          .setLabel('Page ' + (safePage + 1) + ' / ' + pageCount)
          .setEmoji('📄')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(
            'ticket:create-tag:page:' + departmentId + ':' + (safePage + 1),
          )
          .setLabel('Next')
          .setEmoji('➡️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage >= pageCount - 1),
      ),
    );
  }

  await interaction.editReply({
    content:
      '🏷️ **Choose a tag for your ' +
      department.name +
      ' ticket**\nTags are subcategories inside the department and do not create Discord categories.',
    components,
  });
}

async function handleTicketTagSelection(interaction: StringSelectMenuInteraction): Promise<void> {
  const parts = interaction.customId.split(':');
  const departmentId = parts[3] ?? '';
  const tagId = interaction.values[0] ?? '';

  /*
   * The tag menu was generated from the current department configuration.
   * Do not perform another configuration load before showModal(): the
   * interaction has a very short acknowledgement window. The modal submit
   * validates the department/tag again before creating the ticket.
   */
  await showTicketCreationModal(interaction, departmentId, tagId);
}

async function showTicketCreationModal(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  departmentId: string,
  tagId: string,
): Promise<void> {
  if (!interaction.guild) {
    await replyError(
      interaction,
      '❌ This action can only be used inside a server.',
    );
    return;
  }

  try {
    /*
     * Do not load guild configuration before showModal(). A slow config
     * read must never make a valid tag selection expire as Unknown
     * interaction (10062). The modal submit revalidates the department/tag
     * before any ticket is created.
     */
    const modal =
      new ModalBuilder()
        .setCustomId(
          `ticket:modal:${departmentId}:${tagId}`,
        )
        .setTitle(
          'Support Request',
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
          'Describe your issue (up to 4,000 characters)',
        )
        .setPlaceholder(
          'Paste or type the full issue. Keep paragraphs and bullet points as written.',
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

async function showReportTargetSelector(interaction: ButtonInteraction, page = 0): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ Reporting is only available inside a ticket.');
    return;
  }

  const topic = interaction.channel.topic ?? '';
  const staff = getStaffContext(interaction, topic);
  if (!staff.authorized) {
    await replyError(interaction, '❌ Only configured moderators or administrators can submit a report.');
    return;
  }

  const targetIds = Array.from(new Set([
    getField(topic, 'owner'),
    ...(getField(topic, 'users') ?? '').split(',').filter(Boolean),
    ...(getField(topic, 'claimed_by') ?? '').split(',').filter(Boolean),
  ].filter((id): id is string => Boolean(id) && id !== interaction.user.id)));

  if (!targetIds.length) {
    await replyError(interaction, '❌ There are no other reportable participants on this ticket.');
    return;
  }

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(targetIds.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visibleTargets = targetIds.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ticket:report:target')
        .setPlaceholder('Choose the reported user')
        .addOptions(visibleTargets.map((id) => ({
          label: 'User ' + id.slice(-6),
          value: id,
          description: id === getField(topic, 'owner') ? 'Ticket owner' : 'Ticket participant',
        }))),
    ),
  ];

  if (pageCount > 1) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket:panel:report:page:' + (safePage - 1))
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage === 0),
        new ButtonBuilder()
          .setCustomId('ticket:panel:report:page:' + safePage)
          .setLabel('Page ' + (safePage + 1) + ' / ' + pageCount)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId('ticket:panel:report:page:' + (safePage + 1))
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage >= pageCount - 1),
      ),
    );
  }

  await interaction.editReply({
    content: '🚩 **Report a user**\nChoose the participant whose behaviour you want to report.' +
      (pageCount > 1 ? '\nPage ' + (safePage + 1) + ' of ' + pageCount + '.' : ''),
    components,
  });
}

async function handleReportTargetSelection(interaction: StringSelectMenuInteraction): Promise<void> {
  await interaction.deferUpdate();
  const targetId = interaction.values[0];
  const topic = interaction.channel?.type === ChannelType.GuildText ? interaction.channel.topic ?? '' : '';
  const settings = await getAdvancedSettings(interaction.guild!.id);

  const rows = Object.values(settings.reports.categories).slice(0, 25);
  await interaction.editReply({
    content: '🚩 **Report category**\nChoose the category that best describes the behaviour. The category set is built into SupportForge and is separate from ticket use-case/departments.',
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('ticket:report:category:' + targetId)
          .setPlaceholder('Choose a report category')
          .addOptions(rows.map((category) => ({
            label: category.name.slice(0, 100),
            value: category.id,
            emoji: category.emoji,
            description: 'Select a subcategory next',
          }))),
      ),
    ],
  });
}

async function handleReportCategorySelection(interaction: StringSelectMenuInteraction): Promise<void> {
  await interaction.deferUpdate();
  const parts = interaction.customId.split(':');
  const targetId = parts[3] ?? '';
  const categoryId = interaction.values[0];
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const category = settings.reports.categories[categoryId];

  if (!category) {
    await interaction.editReply({ content: '❌ That report category is no longer available.', components: [] });
    return;
  }

  await interaction.editReply({
    content: '🚩 **Report subcategory**\nChoose the most specific reason.',
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('ticket:report:subcategory:' + targetId + ':' + categoryId)
          .setPlaceholder('Choose a report subcategory')
          .addOptions(Object.values(category.subcategories).slice(0, 25).map((sub) => ({
            label: sub.name.slice(0, 100),
            value: sub.id,
            description: category.name,
          }))),
      ),
    ],
  });
}

async function handleReportSubcategorySelection(interaction: StringSelectMenuInteraction): Promise<void> {
  const parts = interaction.customId.split(':');
  const targetId = parts[3] ?? '';
  const categoryId = parts[4] ?? '';
  const subcategoryId = interaction.values[0];

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId('ticket:report:modal:' + targetId + ':' + categoryId + ':' + subcategoryId)
      .setTitle('Report User')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('description')
            .setLabel('What happened? (optional)')
            .setPlaceholder('Briefly describe the behaviour. Maximum 500 characters.')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(500),
        ),
      ),
  );
}

async function handleReportModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ This report can only be submitted from a ticket.');
    return;
  }

  const parts = interaction.customId.split(':');
  const targetUserId = parts[3] ?? '';
  const categoryId = parts[4] ?? '';
  const subcategoryId = parts[5] ?? '';
  const topic = interaction.channel.topic ?? '';
  const staff = getStaffContext(interaction, topic);
  if (!staff.authorized) {
    await replyError(interaction, '❌ Only configured moderators or administrators can submit reports.');
    return;
  }

  const nonce = Math.random().toString(36).slice(2, 10);
  pendingReportDecisions.set(nonce, {
    guildId: interaction.guild.id,
    channelId: interaction.channel.id,
    targetUserId,
    categoryId,
    subcategoryId,
    description: interaction.fields.getTextInputValue('description').trim().slice(0, 500),
    reporterUserId: interaction.user.id,
    ticketNumber: getField(topic, 'number'),
  });

  await interaction.editReply({
    content: '🚩 **Review report**\nChoose whether this incident should count as a serious violation (a flag) or simply be recorded without adding a flag.',
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('ticket:report:decision:' + nonce + ':flag').setLabel('Flag Violation').setEmoji('🚩').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('ticket:report:decision:' + nonce + ':record').setLabel('Record Only').setEmoji('📝').setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function handleReportDecision(interaction: ButtonInteraction): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  const parts = interaction.customId.split(':');
  const nonce = parts[3] ?? '';
  const decision = parts[4] ?? '';
  const pending = pendingReportDecisions.get(nonce);

  if (!pending || pending.reporterUserId !== interaction.user.id) {
    await replyError(interaction, '❌ This report review has expired or is not assigned to you.');
    return;
  }

  pendingReportDecisions.delete(nonce);

  const result = await recordReport(interaction.guild!, {
    targetUserId: pending.targetUserId,
    reporterUserId: pending.reporterUserId,
    reporterName: interaction.user.tag,
    categoryId: pending.categoryId,
    subcategoryId: pending.subcategoryId,
    description: pending.description,
    flagged: decision === 'flag',
    channelId: pending.channelId,
    ticketNumber: pending.ticketNumber,
  });

  const actions = result.appliedRules.length
    ? '\n\n⚙️ Automatic action(s): ' + result.appliedRules.map((rule) => rule.action + ' at ' + rule.threshold + ' flags').join(', ')
    : '';

  await interaction.editReply({
    content:
      (decision === 'flag' ? '🚩 **Violation flagged.**' : '📝 **Report recorded without a flag.**') +
      '\nReported user: <@' + pending.targetUserId + '>' +
      '\nCurrent flag count: **' + result.flagCount + '**' +
      actions,
    components: [],
  });
}

/* -------------------------------------------------------------------------- */
/* Panel button handlers                                                      */
/* -------------------------------------------------------------------------- */

async function showTicketHistory(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;

  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ Ticket history is only available inside a ticket channel.');
    return;
  }

  try {
    const channel = interaction.channel as TextChannel;
    const topic = channel.topic ?? '';
    const ticketNumber = getField(topic, 'number') ?? 'unknown';

    const events = await getTicketAuditHistory(
      interaction.guild.id,
      ticketNumber,
    );

    const recent = events.slice(-20).reverse();

    if (!recent.length) {
      await interaction.editReply(
        '📜 **Ticket #' + ticketNumber + ' History**\n\nNo audit events have been recorded for this ticket yet.',
      );
      return;
    }

    const lines = recent.map((event) => {
      const timestamp = Math.floor(new Date(event.timestamp).getTime() / 1000);
      const detail = event.detail?.trim();

      return (
        '• <t:' +
        timestamp +
        ':f> • **' +
        event.action
          .split('_')
          .map((part: string) => part.charAt(0) + part.slice(1).toLowerCase())
          .join(' ') +
        '** • ' +
        (event.actorName || 'Unknown') +
        (detail ? ' • ' + detail.slice(0, 160) : '')
      );
    });

    /* Discord message content is capped at 2,000 characters. */
    const chunks: string[] = [];
    let current = '';
    for (const line of lines) {
      const candidate = current ? current + '\n' + line : line;
      if (candidate.length > 2800 && current) {
        chunks.push(current);
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);

    const embeds = chunks.slice(0, 2).map((chunk, index) =>
      new EmbedBuilder()
        .setTitle(
          index === 0
            ? '📜 Ticket #' + ticketNumber + ' History'
            : '📜 Ticket #' + ticketNumber + ' History • Continued',
        )
        .setDescription(chunk)
        .setFooter({ text: 'Showing the ' + recent.length + ' most recent audit events.' }),
    );

    await interaction.editReply({ content: '', embeds });
  } catch (error) {
    console.error('❌ Failed to load ticket history:', error);
    await replyError(interaction, '❌ SupportForge could not load this ticket history.');
  }
}

async function renderDepartmentSelector(interaction: ButtonInteraction | StringSelectMenuInteraction, page = 0): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate();
  }
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) { await replyError(interaction, '❌ This action can only be used inside a ticket.'); return; }
  const channel = interaction.channel as TextChannel;
  if (!isTicketTopic(channel.topic ?? '')) { await replyError(interaction, '❌ This action can only be used inside a ticket.'); return; }
  const config = await getGuildConfig(interaction.guild.id);
  const departments = Object.values(config.departments).sort((x, y) => x.name.localeCompare(y.name));
  const size = 25, count = Math.max(1, Math.ceil(departments.length / size)), p = Math.min(Math.max(page, 0), count - 1);
  const current = getField(channel.topic ?? '', 'department');
  const menu = new StringSelectMenuBuilder().setCustomId('ticket:department:select').setPlaceholder('Choose a department').setMinValues(1).setMaxValues(1)
    .addOptions(departments.slice(p * size, (p + 1) * size).map((d) => ({ label: d.name.slice(0, 100), value: d.id, description: Object.keys(d.tags ?? {}).length + ' tag(s)', default: d.id === current })));
  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('ticket:department:page:' + (p - 1)).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
    new ButtonBuilder().setCustomId('ticket:department:page:' + (p + 1)).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(p >= count - 1),
    new ButtonBuilder().setCustomId('ticket:department:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  const payload = { content: '📂 **Choose a department**\nThe department controls the Discord category and staff routing. Tags belong to the department and never create categories.', components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), nav] };
  if (interaction.replied || interaction.deferred) await interaction.editReply(payload); else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function changeTicketDepartment(interaction: StringSelectMenuInteraction): Promise<void> {
  /*
   * Department changes can trigger category creation, permission mutations
   * and topic updates. Acknowledge the select immediately so Discord does not
   * expire the interaction while those operations are running.
   */
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate();
  }

  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) { await replyError(interaction, '❌ This action can only be used inside a ticket.'); return; }
  const channel = interaction.channel as TextChannel; const topic = channel.topic ?? '';
  const status = (await getPersistedTicketStatus(channel.id)) ?? getTicketStatus(topic);
  if (!isTicketTopic(topic) || !isActiveTicketStatus(status)) { await replyError(interaction, '❌ Only active tickets can be rerouted.'); return; }
  const staff = getStaffContext(interaction, topic);
  if (!staff.authorized) { await replyError(interaction, '❌ Only configured staff or administrators can change the department.'); return; }
  const departmentId = interaction.values[0]; const config = await getGuildConfig(interaction.guild.id); const department = config.departments[departmentId];
  if (!department) { await replyError(interaction, '❌ Department not found.'); return; }
  const oldDepartmentId = getField(topic, 'department');
  if (oldDepartmentId === departmentId) { await interaction.editReply({ content: 'ℹ️ This ticket is already in **' + department.name + '**.', components: [] }); return; }
  const tags = Object.values(department.tags ?? {}).sort((x, y) => x.name.localeCompare(y.name));
  if (!tags.length) { await replyError(interaction, '❌ The destination department has no tags. Add at least one tag first.'); return; }
  if (tags.length > 1) {
    await renderRoutingTagSelector(interaction, 0, department.id);
    return;
  }
  await applyTicketRouting(interaction, department, tags[0].id, status, topic);
}

async function renderRoutingTagSelector(interaction: ButtonInteraction | StringSelectMenuInteraction, page: number, departmentIdOverride?: string): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate();
  }
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) { await replyError(interaction, '❌ This action can only be used inside a ticket.'); return; }
  const channel = interaction.channel as TextChannel; const topic = channel.topic ?? '';
  const departmentId = departmentIdOverride ?? getField(topic, 'department'); const config = await getGuildConfig(interaction.guild.id); const department = departmentId ? config.departments[departmentId] : undefined;
  if (!department) { await replyError(interaction, '❌ This ticket department no longer exists.'); return; }
  const tags = Object.values(department.tags ?? {}).sort((x, y) => x.name.localeCompare(y.name));
  if (!tags.length) { await replyError(interaction, '❌ This department has no tags configured.'); return; }
  const size = 25, count = Math.max(1, Math.ceil(tags.length / size)), p = Math.min(Math.max(page, 0), count - 1);
  const currentTag = getField(topic, 'tags');
  const menu = new StringSelectMenuBuilder().setCustomId('ticket:routing-tag:select:' + department.id).setPlaceholder('Choose a tag').setMinValues(1).setMaxValues(1)
    .addOptions(tags.slice(p * size, (p + 1) * size).map((t) => ({ label: t.name.slice(0, 100), value: t.id, description: 'Subcategory of ' + department.name, default: t.id === currentTag })));
  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('ticket:routing-tag:page:' + (p - 1) + ':' + department.id).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
    new ButtonBuilder().setCustomId('ticket:routing-tag:page:' + (p + 1) + ':' + department.id).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(p >= count - 1),
    new ButtonBuilder().setCustomId('ticket:routing-tag:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  const payload = { content: '🏷️ **Tag • ' + department.name + '**\nTags are subcategories of this department. Changing a tag does not create or move a Discord category.', components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), nav] };
  if (interaction.replied || interaction.deferred) await interaction.editReply(payload); else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

async function applyTicketRouting(interaction: StringSelectMenuInteraction, department: DepartmentConfig, tagId: string, status: TicketStatus, topic: string): Promise<void> {
  const channel = interaction.channel as TextChannel; const config = await getGuildConfig(interaction.guild!.id);
  const oldDepartmentId = getField(topic, 'department'); const oldDepartment = oldDepartmentId ? config.departments[oldDepartmentId] : undefined;
  const category = await ensureDepartmentCategory(interaction.guild!, department);
  const newTopic = setField(setField(setField(topic, 'department', department.id), 'staff', department.staffRoleId ?? 'none'), 'tags', tagId);
  try {
    await runChannelMutation(channel, 'Ticket routing update', async () => {
      if (oldDepartmentId !== department.id) {
        await setChannelParent(channel.id, category.id, 'Move ticket to department category');
        if (oldDepartment?.staffRoleId && oldDepartment.staffRoleId !== department.staffRoleId) await setChannelPermissionOverwrite(channel.id, oldDepartment.staffRoleId, [], [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory], 0, 'Remove previous department staff');
        if (department.staffRoleId) await setChannelPermissionOverwrite(channel.id, department.staffRoleId, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks], [], 0, 'Grant department staff');
      }
      await setChannelTopic(channel.id, newTopic, 'Update department and tag metadata');
    });
    channel.topic = newTopic;
    updateRuntimeTicketState(channel, newTopic, status);

    /*
     * Rerouting can replace the department staff role while a ticket is already
     * claimed. Reapply ticket visibility so the new department does not expose
     * a private claimed ticket to unassigned staff.
     */
    await applyTicketVisibilityMode(
      channel,
      newTopic,
      status === 'claimed' ? 'claimed' : 'unclaimed',
    );

    await updatePersistedTicketMetadata(channel.id, {
      departmentId: department.id,
      tagId,
    });
    await updateMainMessage(channel, getField(newTopic, 'message'), status, newTopic);
    await interaction.editReply({ content: '✅ Ticket routed to **' + department.name + ' → ' + (department.tags[tagId]?.name ?? 'tag') + '**.', components: [] });
    if (config.supportCategoryId) await logTicketEvent(interaction.guild!, config.supportCategoryId, { ticketNumber: getField(newTopic, 'number') ?? 'unknown', event: 'ticket_routing_changed', actor: interaction.user.tag, actorId: interaction.user.id, actorName: interaction.user.tag, detail: 'Department=' + department.name + '; tag=' + (department.tags[tagId]?.name ?? tagId) + '.' });
  } catch (error) { console.error('❌ Ticket routing update failed:', error); await interaction.editReply({ content: '❌ The ticket routing update failed.', components: [] }).catch(() => undefined); }
}

async function changeTicketRoutingTag(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate();
  }

  const parts = interaction.customId.split(':'); const departmentId = parts[3] ?? ''; const tagId = interaction.values[0] ?? '';
  const config = await getGuildConfig(interaction.guild!.id); const department = config.departments[departmentId];
  if (!department?.tags?.[tagId]) { await replyError(interaction, '❌ That tag is not valid for this department.'); return; }
  const channel = interaction.channel as TextChannel; const topic = channel.topic ?? ''; const status = (await getPersistedTicketStatus(channel.id)) ?? getTicketStatus(topic);
  const staff = getStaffContext(interaction, topic);
  if (!isTicketTopic(topic) || !isActiveTicketStatus(status) || !staff.authorized) { await replyError(interaction, '❌ Only configured staff or administrators can change ticket tags.'); return; }
  await applyTicketRouting(interaction, department, tagId, status, topic);
}

async function showPrioritySelector(
  interaction: ButtonInteraction,
): Promise<void> {
  const priorities: Array<[TicketPriority, string, string]> = [
    ['low', 'Low', '🟢'],
    ['normal', 'Normal', '🟡'],
    ['high', 'High', '🟠'],
    ['urgent', 'Urgent', '🔴'],
    ['critical', 'Critical', '🟣'],
  ];

  const channel =
    interaction.channel?.type === ChannelType.GuildText
      ? interaction.channel as TextChannel
      : null;

  const currentPriority =
    channel
      ? await getEffectiveTicketPriority(channel.id, channel.topic ?? '')
      : 'normal';

  const priorityRow =
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...priorities.map(([priority, label, emoji]) =>
        new ButtonBuilder()
          .setCustomId(`ticket:priority:set:${priority}`)
          .setLabel(label)
          .setEmoji(emoji)
          .setStyle(
            priority === currentPriority
              ? ButtonStyle.Primary
              : ButtonStyle.Secondary,
          ),
      ),
    );

  const cancelRow =
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket:priority:cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );

  await interaction.editReply({
    content:
      '⚡ **Choose Ticket Priority**\n' +
      'Select one of the five priority levels below. No typing is required.',
    components: [priorityRow, cancelRow],
  });
}

async function applyTicketPriority(
  interaction: ButtonInteraction,
  priority: TicketPriority,
): Promise<void> {
  await interaction.deferUpdate();

  if (
    !interaction.guild ||
    interaction.channel?.type !== ChannelType.GuildText
  ) {
    await replyError(
      interaction,
      '❌ This action can only be used inside a ticket.',
    );
    return;
  }

  const channel = interaction.channel as TextChannel;
  const state = getRuntimeTicketState(channel);
  const topic = channel.topic ?? state.topic;
  const status =
    (await getPersistedTicketStatus(channel.id)) ??
    getTicketStatus(topic);

  if (!isTicketTopic(topic) || !isActiveTicketStatus(status)) {
    await replyError(
      interaction,
      '❌ Only active tickets can have their priority changed.',
    );
    return;
  }

  const staff = getStaffContext(interaction, topic);
  if (!staff.authorized) {
    await replyError(
      interaction,
      '❌ Only configured staff or administrators can change ticket priority.',
    );
    return;
  }

  const newTopic = setField(
    topic,
    'priority',
    priority,
  );

  await updatePersistedTicketMetadata(
    channel.id,
    { priority },
  );

  channel.topic = newTopic;
  updateRuntimeTicketState(
    channel,
    newTopic,
    status,
  );

  /*
   * Priority is intentionally NOT synchronized by a Discord channel PATCH.
   * Discord applies a strict resource-specific limit to channel updates;
   * repeatedly rewriting the channel name/topic for cosmetic priority
   * changes wastes that quota. The persistent ticket record and panel state
   * are the source of truth for priority.
   */

  await interaction.editReply({
    content: `✅ Ticket priority changed to **${({ low: '🟢 Low', normal: '🟡 Normal', high: '🟠 High', urgent: '🔴 Urgent', critical: '🟣 Critical' } as Record<TicketPriority, string>)[priority]}**.`,
    components: [],
  });

  const config = await getGuildConfig(channel.guild.id);
  if (config.supportCategoryId) {
    await logTicketEvent(
      channel.guild,
      config.supportCategoryId,
      {
        ticketNumber: getField(newTopic, 'number') ?? 'unknown',
        event: 'ticket_priority_changed',
        actor: interaction.user.tag,
        actorId: interaction.user.id,
        actorName: interaction.user.tag,
        detail: 'Priority changed to ' + priority + '.',
      },
    );
  }

  void updateMainMessage(
    channel,
    getField(newTopic, 'message'),
    status,
    newTopic,
  );
}


async function handleTicketVoiceStart(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate();
  }
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ Voice mode is only available inside a ticket.');
    return;
  }
  const channel = interaction.channel as TextChannel;
  const topic = channel.topic ?? '';
  const status = (await getPersistedTicketStatus(channel.id)) ?? getTicketStatus(topic);
  if (!isTicketTopic(topic) || status !== 'claimed') {
    await replyError(interaction, '❌ Voice mode is available only for claimed tickets.');
    return;
  }
  const claimedBy = getField(topic, 'claimed_by');
  const claimedIds = (claimedBy ?? '').split(',').filter(Boolean);
  if (!claimedIds.length || !claimedIds.includes(interaction.user.id)) {
    await replyError(interaction, '❌ Only an assigned moderator can start voice mode.');
    return;
  }
  if (!claimedBy) {
    await replyError(interaction, '❌ Claim the ticket before starting voice mode.');
    return;
  }
  try {
    const result = await startTicketVoiceMode(interaction.guild, channel, topic);
    channel.topic = result.topic;
    const ticketNumber = getField(result.topic, 'number') ?? 'unknown';
    await updateMainMessage(channel, getField(result.topic, 'message'), status, result.topic);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🎙️ Private Voice Mode Active')
          .setDescription('A private voice room has been created for this ticket. Only the ticket owner and assigned moderators can connect. The room capacity is sized for the configured moderator limit plus the customer, and screen sharing is enabled.')
          .addFields({ name: 'Voice channel', value: result.voiceChannel.toString() })
          .setTimestamp(),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Join Private Voice').setEmoji('🎙️')
            .setURL('https://discord.com/channels/' + interaction.guild.id + '/' + result.voiceChannel.id),
        ),
      ],
      allowedMentions: { parse: [] },
    });
    const config = await getGuildConfig(interaction.guild.id);
    if (config.supportCategoryId) {
      await logTicketEvent(interaction.guild, config.supportCategoryId, {
        ticketNumber,
        event: 'ticket_voice_started',
        actor: interaction.user.tag,
        actorId: interaction.user.id,
        actorName: interaction.user.tag,
        detail: 'Created private voice channel ' + result.voiceChannel.name + ' for the owner and assigned moderators. Capacity follows the configured moderator limit plus the customer; screen sharing enabled.',
      });
    }
  } catch (error) {
    console.error('❌ Failed to start ticket voice mode:', error);
    await replyError(interaction, '❌ SupportForge could not start private voice mode. The ticket itself was not changed.');
  }
}

async function handleTicketVoiceEnd(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate();
  }
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ Voice mode is only available inside a ticket.');
    return;
  }
  const channel = interaction.channel as TextChannel;
  const topic = channel.topic ?? '';
  const status = (await getPersistedTicketStatus(channel.id)) ?? getTicketStatus(topic);
  if (!isTicketTopic(topic) || status !== 'claimed') {
    await replyError(interaction, '❌ This ticket is no longer using an active voice session.');
    return;
  }
  const claimedBy = getField(topic, 'claimed_by');
  const claimedIds = (claimedBy ?? '').split(',').filter(Boolean);
  if (!claimedIds.length || !claimedIds.includes(interaction.user.id)) {
    await replyError(interaction, '❌ Only an assigned moderator can end voice mode.');
    return;
  }
  try {
    const newTopic = await endTicketVoiceMode(interaction.guild, channel, topic, status, 'SupportForge voice mode ended');
    channel.topic = newTopic;
    await updateMainMessage(channel, getField(newTopic, 'message'), status, newTopic);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🔚 Private Voice Mode Ended')
          .setDescription('The temporary private voice room has been removed. This ticket is back to normal text mode.')
          .setTimestamp(),
      ],
    });
    const config = await getGuildConfig(interaction.guild.id);
    if (config.supportCategoryId) {
      await logTicketEvent(interaction.guild, config.supportCategoryId, {
        ticketNumber: getField(newTopic, 'number') ?? 'unknown',
        event: 'ticket_voice_ended',
        actor: interaction.user.tag,
        actorId: interaction.user.id,
        actorName: interaction.user.tag,
        detail: 'Private voice channel deleted and ticket returned to text mode.',
      });
    }
  } catch (error) {
    console.error('❌ Failed to end ticket voice mode:', error);
    await replyError(interaction, '❌ SupportForge could not end voice mode safely.');
  }
}

async function handleTicketVoiceJoin(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await interaction.editReply('❌ Voice mode is only available inside a ticket.');
    return;
  }
  const channel = interaction.channel as TextChannel;
  const topic = channel.topic ?? '';
  const voiceId = getField(topic, 'voice_channel_id');
  const claimedBy = getField(topic, 'claimed_by');
  const ownerId = getField(topic, 'owner');
  if (!voiceId || !claimedBy || !ownerId) {
    await interaction.editReply('❌ No active private voice session was found for this ticket.');
    return;
  }
  const claimedIds = (claimedBy ?? '').split(',').filter(Boolean);
  const allowed = interaction.user.id === ownerId || claimedIds.includes(interaction.user.id);
  if (!allowed) {
    await interaction.editReply('❌ Only the ticket owner and assigned moderators can use this private voice session.');
    return;
  }
  const voiceChannel = interaction.guild.channels.cache.get(voiceId);
  if (voiceChannel?.type !== ChannelType.GuildVoice) {
    await interaction.editReply('❌ The private voice channel is no longer available.');
    return;
  }
  await interaction.editReply(
    '🎙️ **Private Voice Channel**\\n' +
      voiceChannel +
      '\\n\\nThis room is limited to the ticket owner and assigned moderator.',
  );
}

async function handlePanelButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const id =
    interaction.customId;

  if (id.startsWith('ticket:panel:page:')) {
    await interaction.deferUpdate();

    if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
      await replyError(interaction, '❌ The support panel can only be paged inside a server channel.');
      return;
    }

    const page = Number(id.slice('ticket:panel:page:'.length));
    if (!Number.isInteger(page) || page < 0) {
      await replyError(interaction, '❌ Invalid support panel page.');
      return;
    }

    try {
      const config = await getGuildConfig(interaction.guild.id);
      const panelChannel = interaction.channel as TextChannel;
      const isSupportPanel =
        panelChannel.id === config.panelChannelId ||
        panelChannel.topic?.startsWith('supportforge:panel');

      if (!isSupportPanel) {
        await replyError(
          interaction,
          '❌ This pagination control can only be used on the SupportForge support panel.',
        );
        return;
      }

      const departments = Object.values(config.departments).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const departmentsPerPage = departments.length > 20 ? 20 : 25;
      const pageCount = Math.max(
        1,
        Math.ceil(departments.length / departmentsPerPage),
      );
      const safePage = Math.min(page, pageCount - 1);
      const visibleDepartments = departments.slice(
        safePage * departmentsPerPage,
        (safePage + 1) * departmentsPerPage,
      );

      const rows: ActionRowBuilder<ButtonBuilder>[] = [];
      for (let i = 0; i < visibleDepartments.length; i += 5) {
        rows.push(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            visibleDepartments.slice(i, i + 5).map((department) =>
              new ButtonBuilder()
                .setCustomId('ticket:create:' + department.id)
                .setLabel(department.name.slice(0, 80))
                .setEmoji('🎫')
                .setStyle(ButtonStyle.Primary),
            ),
          ),
        );
      }

      if (pageCount > 1) {
        rows.push(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('ticket:panel:page:' + (safePage - 1))
              .setLabel('Previous')
              .setEmoji('⬅️')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(safePage === 0),
            new ButtonBuilder()
              .setCustomId('ticket:panel:page:' + (safePage + 1))
              .setLabel('Page ' + (safePage + 1) + ' / ' + pageCount)
              .setEmoji('📄')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId('ticket:panel:page:' + (safePage + 1))
              .setLabel('Next')
              .setEmoji('➡️')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(safePage >= pageCount - 1),
          ),
        );
      }

      await interaction.message.edit({ components: rows });
      await interaction.editReply({}).catch(() => undefined);
    } catch (error) {
      console.error('❌ Failed to change support panel page:', error);
      await replyError(interaction, '❌ SupportForge could not change the support panel page.');
    }
    return;
  }

  if (id === 'ticket:panel:voice:start') { await handleTicketVoiceStart(interaction); return; }
  if (id === 'ticket:panel:voice:end') { await handleTicketVoiceEnd(interaction); return; }
  if (id === 'ticket:panel:voice:join') { await handleTicketVoiceJoin(interaction); return; }
  if (id === 'ticket:panel:report' || id.startsWith('ticket:panel:report:page:')) {
    const page = id.startsWith('ticket:panel:report:page:') ? Number(id.slice('ticket:panel:report:page:'.length)) : 0;
    await showReportTargetSelector(interaction, Number.isInteger(page) ? page : 0);
    return;
  }
  if (id.startsWith('ticket:report:decision:')) { await handleReportDecision(interaction); return; }

  if (id === 'ticket:panel:priority') {
    if (!(await safeDeferReply(interaction))) {
      return;
    }
    await showPrioritySelector(interaction);
    return;
  }

  if (id.startsWith('ticket:priority:set:')) {
    const priority = parseTicketPriority(
      id.slice('ticket:priority:set:'.length),
    );
    if (!priority) {
      await replyError(interaction, '❌ Invalid ticket priority.');
      return;
    }
    await applyTicketPriority(interaction, priority);
    return;
  }

  if (id === 'ticket:priority:cancel') {
    await interaction.update({
      content: 'Priority selection cancelled.',
      components: [],
    });
    return;
  }

  if (id.startsWith('ticket:department:page:')) {
    const page = Number(id.slice('ticket:department:page:'.length));
    await interaction.deferUpdate();
    await renderDepartmentSelector(interaction, Number.isInteger(page) ? page : 0);
    return;
  }

  if (id === 'ticket:department:cancel') {
    await interaction.update({ content: 'Department selection cancelled.', components: [] });
    return;
  }

  if (id.startsWith('ticket:routing-tag:page:')) {
    const parts = id.slice('ticket:routing-tag:page:'.length).split(':');
    const page = Number(parts[0] ?? '0');
    const departmentId = parts[1] ?? undefined;
    await interaction.deferUpdate();
    await renderRoutingTagSelector(interaction, Number.isInteger(page) ? page : 0, departmentId);
    return;
  }

  if (id === 'ticket:routing-tag:cancel') {
    await interaction.update({ content: 'Routing tag selection cancelled.', components: [] });
    return;
  }

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
    await unclaimModerator(interaction);
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
    /*
     * Already acknowledged at handleTicketInteraction() entry.
     */

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
    } else if (id === 'ticket:panel:department') {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
      await renderDepartmentSelector(interaction, 0);
      return;
    } else if (
      id ===
      'ticket:panel:tag'
    ) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
      await renderRoutingTagSelector(interaction, 0);
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
            4000,
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
    /* Tag                                                                    */
    /* ---------------------------------------------------------------------- */

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
    /*
     * Move/Restore is allowed to perform several Discord API operations,
     * but the button acknowledgement must happen immediately. Defer before
     * routing so rate limits or other latency cannot cause Unknown
     * interaction (10062).
     */
    if (
      interaction.isButton() &&
      (
        interaction.customId === 'ticket:panel:move-bottom' ||
        interaction.customId === 'ticket:panel:restore-move' ||
        interaction.customId === 'ticket:panel:voice:start' ||
        interaction.customId === 'ticket:panel:voice:end'
      )
    ) {
      if (!(await safeDeferReply(interaction))) {
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'ticket:report:target') {
        await handleReportTargetSelection(interaction);
        return;
      }
      if (interaction.customId.startsWith('ticket:report:category:')) {
        await handleReportCategorySelection(interaction);
        return;
      }
      if (interaction.customId.startsWith('ticket:report:subcategory:')) {
        await handleReportSubcategorySelection(interaction);
        return;
      }
      if (interaction.customId === 'ticket:create-tag:select') {
        await handleTicketTagSelection(interaction);
        return;
      }
      if (interaction.customId.startsWith('ticket:routing-tag:select:')) {
        await changeTicketRoutingTag(interaction);
        return;
      }
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith('ticket:create-tag:page:')
    ) {
      const parts = interaction.customId.split(':');
      const departmentId = parts[3] ?? '';
      const page = Number(parts[4] ?? '0');

      await showTicketTagSelector(
        interaction,
        departmentId,
        Number.isInteger(page) ? page : 0,
      );
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId === 'ticket:create-tag:cancel'
    ) {
      await interaction.update({
        content: 'Ticket tag selection cancelled.',
        components: [],
      });
      return;
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

        await showTicketTagSelector(
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
        interaction.customId === 'ticket:panel:report' ||
        interaction.customId.startsWith('ticket:report:category:') ||
        interaction.customId.startsWith('ticket:report:decision:')
      ) {
        await handlePanelButton(interaction);
        return;
      }

      if (
        interaction.customId.startsWith('ticket:priority:set:') ||
        interaction.customId === 'ticket:priority:cancel'
      ) {
        await handlePanelButton(interaction);
        return;
      }

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
        interaction.customId.startsWith('ticket:modal:')
      ) {
        const parts = interaction.customId.split(':');
        const departmentId = parts[2] ?? '';
        const tagId = parts[3] ?? '';

        if (!departmentId || !tagId) {
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

      if (interaction.customId.startsWith('ticket:report:modal:')) {
        await handleReportModal(interaction);
        return;
      }

      if (
        interaction.customId.startsWith(
          'ticket:modal:',
        )
      ) {
        const parts = interaction.customId.split(':');
        const departmentId = parts[2] ?? '';
        const tagId = parts[3] ?? '';

        if (!departmentId || !tagId) {
          await replyError(
            interaction,
            '❌ Ticket department/tag could not be determined.',
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