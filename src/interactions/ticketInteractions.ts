import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
  CheckboxGroupBuilder,
  type Message,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';

import {
  allocateTicketNumber,
  getGuildConfig,
  getTier,
  isPremiumOrHigher,
  type DepartmentConfig,
  type CustomSupportPanelButton,
  updateGuildConfig,
} from '../services/configService';

import { assertTicketStatusTransition } from '../core/domain/ticketLifecycle';
import { projectDurableTicketTopic } from '../services/ticketTopicProjectionService';
import { buildTicketVisibilityPlan } from '../core/domain/ticketPermissionPlan';
import { classifyTicketRoutingComponent } from '../core/domain/ticketInteractionRouting';

import { generateTranscript } from '../services/transcriptService';

import {
  setChannelPermissionOverwrite,
  setChannelProperties,
  setChannelTopic,
} from '../services/discordChannelService';

import {
  ensureArchiveCategory,
  ensureClosedCategory,
  ensureOpenCategory,
  getOptionalStatusCategory,
} from '../services/ticketStorageService';

import { resetPanelActivity } from '../services/panelActivityService';
import { getAdvancedSettings, type TicketPriority } from '../services/advancedSettingsService';
import { getThemeColor } from '../services/uiThemeService';
import { translate } from '../i18n/translationService';
import type { TranslationKey } from '../i18n/locales/en-US';
import { ensureDepartmentCategory } from '../services/departmentCategoryService';
import { endTicketVoiceMode, startTicketVoiceMode, syncTicketVoiceParticipants } from '../services/voiceModeService';
import { getUserFlagCount, isTicketCreationRestricted, recordReport } from '../services/reportService';
import { listQuickReplies, sendQuickReplyInTicket } from '../services/quickReplyService';
import { getKnowledgeArticle, recordKnowledgeArticleShare } from '../services/knowledgeBaseService';

import {
  findActivePersistedTickets,
  getPersistedTicket,
  getPersistedTicketPriority,
  getPersistedTicketStatus,
  markPersistedTicketDeleted,
  registerTicket,
  setPersistedTicketStatus,
  transitionPersistedTicket,
  updatePersistedTicketMetadata,
} from '../services/ticketPersistenceService';

import {
  ensureAuditDeveloperInfrastructure,
  getTicketAuditHistory,
  logTicketEvent,
  logSystemEvent,
  logSettingsEvent,
} from '../services/auditLogService';
import {
  evaluateSupportHours,
  formatSupportHoursInstant,
} from '../services/supportHoursService';
import {
  TICKET_FORM_MODAL_TTL_MS,
  getCachedActiveTicketFormById,
  getCachedActiveTicketFormForRouting,
  getTicketFormForSubmission,
  getTicketFormForWizard,
  getTicketFormStepCount,
  getTicketFormWizardSession,
  getVisibleTicketFormFields,
  markTicketFormWizardCompleted,
  saveTicketFormWizardStep,
  validateTicketFormAnswers,
  recordTicketFormSubmissionDraft,
  setTicketFormSubmissionChannel,
  attachTicketFormSubmission,
  markTicketFormSubmissionFailure,
  type TicketFormVersion,
} from '../services/ticketFormService';
import {
  acquireTicketCreationLease,
  releaseTicketCreationLease,
} from '../services/ticketCreationLeaseService';

import {
  archiveTicketChannelForRecovery,
  beginTicketButtonDeletion,
  cancelTicketButtonDeletion,
} from '../services/ticketArchiveService';

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
import { getCustomPanel } from '../services/panelBuilderService';
import { parseCustomPanelInteractionId } from '../core/domain/customPanelInteraction';
import { canPerformTicketAction, isTicketManager } from '../core/domain/ticketAuthorization';
import { buildPrivateThreadTicketComponents, createPrivateThreadTicket, handlePrivateThreadTicketButton, registerInitialPrivateThreadTicket } from '../services/privateThreadTicketService';
import { handlePrivateThreadAuxButton, handlePrivateThreadAuxComponent } from '../services/privateThreadTicketAuxService';

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
  // Use topic data only for legacy channels without a durable ticket row.
  // A database outage must not silently authorize stale channel metadata.
  const persisted = await getPersistedTicket(channelId);
  return persisted
    ? persisted.priority ?? 'normal'
    : getTopicPriority(topic);
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

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

    return await action();
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
  expiresAt: number;
}

const MAX_PENDING_REPORT_DECISIONS = 1_000;
const PENDING_REPORT_DECISION_TTL_MS = 15 * 60_000;
const pendingReportDecisions = new Map<string, PendingReportDecision>();

function prunePendingReportDecisions(now = Date.now()): void {
  for (const [nonce, pending] of pendingReportDecisions) {
    if (pending.expiresAt <= now) {
      pendingReportDecisions.delete(nonce);
    }
  }

  while (pendingReportDecisions.size > MAX_PENDING_REPORT_DECISIONS) {
    const oldest = pendingReportDecisions.keys().next().value;
    if (typeof oldest !== 'string') break;
    pendingReportDecisions.delete(oldest);
  }
}

const ticketCreationLocks = new Set<string>();

interface RuntimeTicketState {
  topic: string;
  status: TicketStatus;
  updatedAt: number;
}

const MAX_RUNTIME_TICKET_CACHE_ENTRIES = 5_000;
const ticketRuntimeCache = new Map<string, RuntimeTicketState>();

function setRuntimeTicketState(
  channelId: string,
  state: RuntimeTicketState,
): void {
  ticketRuntimeCache.delete(channelId);

  while (ticketRuntimeCache.size >= MAX_RUNTIME_TICKET_CACHE_ENTRIES) {
    const oldest = ticketRuntimeCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    ticketRuntimeCache.delete(oldest);
  }

  ticketRuntimeCache.set(channelId, state);
}

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

  setRuntimeTicketState(channel.id, state);

  return state;
}

function updateRuntimeTicketState(
  channel: TextChannel,
  topic: string,
  status: TicketStatus,
): void {
  setRuntimeTicketState(channel.id, {
    topic,
    status,
    updatedAt: Date.now(),
  });
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
    | ChatInputCommandInteraction
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

function interactionActor(
  interaction: ButtonInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
): {
  id: string;
  attribution: 'actorKnown';
  confidence: 'high';
} {
  return {
    id: interaction.user.id,
    attribution: 'actorKnown',
    confidence: 'high',
  };
}

async function getEffectiveTicketTopic(
  channel: TextChannel,
  topic: string,
): Promise<string> {
  // Database failures must surface instead of falling back to stale Discord
  // topic state that could authorize an action against an obsolete ticket.
  const persisted = await getPersistedTicket(channel.id);
  if (!persisted) return topic;
  return projectDurableTicketTopic(topic, persisted);
}

function getStaffContext(
  interaction:
    | ButtonInteraction
    | ChatInputCommandInteraction
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

  const authorization = {
    actorId: interaction.user.id,
    ownerId,
    isConfiguredStaff: isStaff,
    isAdministrator: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)),
    canManageGuild: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)),
  };

  return {
    ownerId,
    staffRole,
    isStaff,
    isAdmin: admin,
    authorized: isTicketManager(authorization),
  };
}

/**
 * Safely acknowledge a reply/error.
 *
 * This function deliberately does not attempt a second acknowledgement.
 * Discord interactions can only be acknowledged once.
 */
function getDiscordApiErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; rawError?: { code?: unknown } };
  const code = candidate.code ?? candidate.rawError?.code;
  return typeof code === 'number' ? code : null;
}

function isUnknownChannelError(error: unknown): boolean {
  return getDiscordApiErrorCode(error) === 10003;
}

function isUnknownMessageError(error: unknown): boolean {
  return getDiscordApiErrorCode(error) === 10008;
}

async function editReplyOrFollowUp(
  interaction: ButtonInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  try {
    await interaction.editReply(content);
  } catch (error) {
    if (!isUnknownMessageError(error)) throw error;

    // The original interaction response may have been deleted by another
    // handler. The ticket operation must not be reported as failed merely
    // because its acknowledgement message no longer exists.
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
    }).catch((followUpError) => {
      console.warn(
        '⚠️ The original interaction response was missing and a follow-up could not be delivered (Discord code ' +
          String(getDiscordApiErrorCode(followUpError) ?? 'unknown') +
          ').',
      );
    });
  }
}

async function replyError(
  interaction:
    | ButtonInteraction
    | ChatInputCommandInteraction
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction
    | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  try {
    if (
      interaction.deferred &&
      !interaction.replied
    ) {
      await interaction.editReply(content);
      return;
    }

    if (
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    if (isUnknownMessageError(error)) {
      await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral,
      }).catch((followUpError) => {
        console.warn(
          '⚠️ Could not deliver an interaction error response (Discord code ' +
            String(getDiscordApiErrorCode(followUpError) ?? 'unknown') +
            ').',
        );
      });
      return;
    }

    console.error('❌ Failed to send interaction error:', error);
  }
}

async function safeDeferReply(
  interaction:
    | ButtonInteraction
    | ChatInputCommandInteraction
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

  const transcriptChannel =
    guild.channels.cache.get(transcriptChannelId) ??
    await guild.channels.fetch(transcriptChannelId).catch((error) => {
      console.warn(
        '⚠️ Could not resolve the configured transcript channel while reopening a ticket:',
        error,
      );
      return null;
    });

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
   * Remove matching ResolvX transcript posts from the recent transcript
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
      await getGuildConfig(
          channel.guild.id,
        );

    let message;
    try {
      message =
        channel.messages.cache.get(messageId) ??
        await channel.messages.fetch(messageId);
    } catch {
      /*
       * Closed-ticket controls are moved to the bottom as a new message.
       * The historical message= topic field intentionally remains stable,
       * so recover the current panel by scanning recent messages.
       */
      const recent = await channel.messages.fetch({ limit: 100 });

      const ticketNumber =
        getField(topic, 'number') ?? 'unknown';

      message = recent.find(
        (candidate) =>
          candidate.author.id === channel.client.user?.id &&
          candidate.embeds.some(
            (embed) =>
              embed.title ===
              `🎫 ResolvX Ticket #${ticketNumber}`,
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

    await message.edit({
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
      });
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
  mode: 'unclaimed' | 'claimed' | 'closed',
  formerClaimedBy?: string,
  options?: {
    topic?: string;
    channelName?: string;
    parentId?: string;
    removeRoleIds?: string[];
  },
): Promise<void> {
  const staffRoleId = getField(topic, 'staff');
  const ownerId = getField(topic, 'owner');
  const claimedModerators = (getField(topic, 'claimed_by') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const users = (getField(topic, 'users') ?? '').split(',').map((id) => id.trim()).filter(Boolean);

  if (!channel.guild.members.me || !ownerId) {
    throw new Error('Ticket privacy could not resolve the bot or ticket owner.');
  }

  const existing = [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
    id: overwrite.id,
    kind: overwrite.type === 0 ? 'role' as const : 'member' as const,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  }));
  const roleIds = new Set<string>([
    ...channel.guild.roles.cache.keys(),
    ...existing.filter((overwrite) => overwrite.kind === 'role').map((overwrite) => overwrite.id),
  ]);

  const plan = buildTicketVisibilityPlan({
    existing,
    roleIds,
    staffRoleId,
    everyoneRoleId: channel.guild.roles.everyone.id,
    botId: channel.guild.members.me.id,
    ownerId,
    userIds: users,
    claimedModeratorIds: claimedModerators,
    formerClaimantIds: (formerClaimedBy ?? '').split(',').map((id) => id.trim()).filter(Boolean),
    removeRoleIds: options?.removeRoleIds,
    mode,
  });

  const properties: {
    topic?: string;
    name?: string;
    parentId?: string;
    permissionOverwrites?: Array<{ id: string; allow?: Array<bigint | number | string>; deny?: Array<bigint | number | string> }>;
  } = {};

  if (options?.topic !== undefined && (channel.topic ?? '') !== options.topic) {
    properties.topic = options.topic;
  }
  if (options?.channelName !== undefined && channel.name !== options.channelName) {
    properties.name = options.channelName;
  }
  if (options?.parentId !== undefined && channel.parentId !== options.parentId) {
    properties.parentId = options.parentId;
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

  if (Object.keys(properties).length === 0) return;

  await setChannelProperties(
    channel.id,
    properties,
    roleIds,
    'Synchronize ResolvX ticket metadata and privacy in one channel update',
    { deferLongRateLimit: false },
  );
  if (properties.topic !== undefined) channel.topic = properties.topic;
  if (properties.name !== undefined) channel.name = properties.name;
}

/* -------------------------------------------------------------------------- */
/* Ticket creation                                                            */
/* -------------------------------------------------------------------------- */

interface PreparedTicketFormData {
  form: TicketFormVersion;
  answers: Record<string, unknown>;
  subject: string;
  description: string;
}


async function ensureSupportHoursAllows(
  interaction: ButtonInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  guildId: string,
  departmentId: string,
  panelId?: string,
): Promise<boolean> {
  const decision = await evaluateSupportHours(guildId, { departmentId, panelId });
  if (decision.ticketCreationAllowed) return true;

  const locale = (await getAdvancedSettings(guildId)).locale;
  const nextOpening = decision.nextOpeningAt
    ? translate(locale, 'ticket.intake.nextOpening', {
        nextOpening: formatSupportHoursInstant(decision.nextOpeningAt, decision.timezone),
      })
    : translate(locale, 'ticket.intake.noNextOpening');
  const message = translate(locale, 'ticket.intake.outsideHours', {
    timezone: decision.timezone,
    nextOpening,
  });
  await replyError(interaction, message);

  // Audit delivery must not delay Discord's initial acknowledgement.
  void (async () => {
    const guild = interaction.guild;
    if (!guild) return;
    const config = await getGuildConfig(guildId);
    if (!config.supportCategoryId) return;
    await logSettingsEvent(guild, config.supportCategoryId, {
      action: 'SUPPORT_HOURS_BLOCKED',
      actorId: interaction.user.id,
      actorName: interaction.user.tag,
      detail: 'Blocked new ticket intake for department ' + departmentId +
        (panelId ? ' via panel ' + panelId : '') +
        '; timezone=' + decision.timezone +
        '; policy=' + (decision.scopeType ?? 'none') +
        '; policyVersion=' + (decision.policyVersion ?? 'none') + '.',
    });
  })().catch((error) => console.warn('Support-hours block audit failed:', error));
  return false;
}

async function createTicket(
  interaction: ModalSubmitInteraction,
  departmentId: string,
  tagId: string,
  formRoute?: { formId: string; version: number; expiresAt: number; submissionId?: string; panelId?: string },
  preparedForm?: PreparedTicketFormData,
  alreadyAcknowledged = false,
  panelId?: string,
): Promise<void> {
  if (!alreadyAcknowledged && !(await safeDeferReply(interaction))) {
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
    | ThreadChannel
    | undefined;
  let creationLease: string | null = null;
  let selectedForm: TicketFormVersion | undefined;
  let formAnswers: Record<string, unknown> | undefined;
  let formDraftRecorded = false;

  try {
    creationLease = await acquireTicketCreationLease(
      guild.id,
      interaction.user.id,
      departmentId,
    );
    if (!creationLease) {
      await replyError(
        interaction,
        '⏳ Another ticket request for this department is already being processed. Please wait a moment and try again.',
      );
      return;
    }

    if (await isTicketCreationRestricted(guild.id, interaction.user.id)) {
      const flags = await getUserFlagCount(guild.id, interaction.user.id);
      await replyError(
        interaction,
        `🚫 You are currently restricted from opening new ResolvX tickets because your account has reached **${flags}** moderation flag(s).`,
      );
      return;
    }

    const config =
      await getGuildConfig(
          guild.id,
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

    if (!(await ensureSupportHoursAllows(interaction, guild.id, departmentId, panelId ?? formRoute?.panelId))) {
      return;
    }

    if (formRoute) {
      if (!Number.isFinite(formRoute.expiresAt) || formRoute.expiresAt <= Date.now()) {
        await replyError(
          interaction,
          '⌛ This form expired. Reopen the support panel and submit the current form.',
        );
        return;
      }

      if (preparedForm) {
        selectedForm = preparedForm.form;
        formAnswers = preparedForm.answers;
      } else {
        selectedForm = await getTicketFormForSubmission({
          guildId: guild.id,
          departmentId,
          tagId,
          formId: formRoute.formId,
          version: formRoute.version,
        });
  
        const rawAnswers: Record<string, unknown> = {};
        for (const field of selectedForm.fields) {
          const customId = 'form_' + field.id;
          switch (field.type) {
            case 'dropdown':
            case 'multi_select':
              rawAnswers[field.id] = Array.from(interaction.fields.getStringSelectValues(customId));
              break;
            case 'checkbox':
              rawAnswers[field.id] = Array.from(interaction.fields.getCheckboxGroup(customId));
              break;
            case 'discord_user':
              rawAnswers[field.id] = Array.from(interaction.fields.getSelectedUsers(customId)?.keys() ?? []);
              break;
            case 'discord_role':
              rawAnswers[field.id] = Array.from(interaction.fields.getSelectedRoles(customId)?.keys() ?? []);
              break;
            case 'attachment':
              rawAnswers[field.id] = Array.from(interaction.fields.getUploadedFiles(customId)?.values() ?? []).map((file) => ({
                id: file.id,
                url: file.url,
                name: file.name,
                size: file.size,
                contentType: file.contentType,
              }));
              break;
            default:
              rawAnswers[field.id] = interaction.fields.getTextInputValue(customId);
              break;
          }
        }
        formAnswers = validateTicketFormAnswers(selectedForm.fields, rawAnswers);
  
        // Mentions/IDs are untrusted text. Verify that selected principals exist
        // in this server before accepting a response as valid.
        for (const field of selectedForm.fields) {
          const answer = formAnswers[field.id];
          if (typeof answer !== 'string') continue;
          if (field.type === 'discord_user') {
            const member = await guild.members.fetch(answer).catch(() => null);
            if (!member) throw new Error('"' + field.label + '" must reference a member of this server.');
          } else if (field.type === 'discord_role') {
            const role = await guild.roles.fetch(answer).catch(() => null);
            if (!role || role.managed) throw new Error('"' + field.label + '" must reference a normal role in this server.');
          }
        }
      }
    }

    const auditParentCategoryId = config.supportCategoryId;
    if (!auditParentCategoryId) {
      await replyError(
        interaction,
        '❌ ResolvX is not configured. Run `/supportforge setup` first.',
      );
      return;
    }

    /*
     * Only active tickets block creation. Prefer the indexed durable store,
     * then verify the small candidate set against Discord. The topic scan is
     * retained only as a compatibility fallback for legacy tickets that were
     * created before durable ticket persistence existed.
     */
    let existing: TextChannel | ThreadChannel | undefined;

    const persistedCandidates = await findActivePersistedTickets(
      guild.id,
      interaction.user.id,
      departmentId,
    );

    for (const candidate of persistedCandidates) {
      const channel =
        guild.channels.cache.get(candidate.channelId) ??
        await guild.channels.fetch(candidate.channelId).catch(() => null);

      if (
        channel?.type === ChannelType.GuildText &&
        isTicketTopic(channel.topic ?? '')
      ) {
        existing = channel;
        break;
      }
      if (
        channel?.type === ChannelType.PrivateThread &&
        candidate.metadata.workspaceKind === 'private-thread' &&
        candidate.guildId === guild.id
      ) {
        existing = channel;
        break;
      }

      await markPersistedTicketDeleted(
        candidate.channelId,
        'Active ticket channel no longer exists during duplicate-ticket reconciliation.',
      );
    }

    if (!existing) {
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

        if (isActiveTicketStatus(getTicketStatus(topic))) {
          existing = channel;
          break;
        }
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
      (preparedForm?.subject ?? interaction.fields.getTextInputValue('subject'))
        .trim();

    const description =
      (preparedForm?.description ?? interaction.fields.getTextInputValue('description'))
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
     * Create the ticket in the existing ResolvX parent first. The
     * department-specific category is provisioned only after the ticket,
     * its panel, and its durable record have been created successfully.
     */
    const number =
      await allocateTicketNumber(
          guild.id,
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

    if (selectedForm && formAnswers) {
      await recordTicketFormSubmissionDraft({
        interactionId: formRoute?.submissionId ?? interaction.id,
        guildId: guild.id,
        form: selectedForm,
        submittedBy: interaction.user.id,
        answers: formAnswers,
      });
      formDraftRecorded = true;
      if (formRoute?.submissionId) {
        await markTicketFormWizardCompleted(formRoute.submissionId);
      }
    }

    let topic = [
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
      `subject=${encodeURIComponent(cleanSubject)}`,
      `number=${number}`,
      `opened_at=${now}`,
      `updated_at=${now}`,
    ].join(' ');

    // Keep the durable form-submission key in channel metadata so recovery can
    // reconstruct the ticket if Discord creates the channel but PostgreSQL
    // temporarily fails before registerTicket commits.
    if (selectedForm) {
      topic = setField(topic, 'form_submission', formRoute?.submissionId ?? interaction.id);
      topic = setField(topic, 'form_id', selectedForm.id);
      topic = setField(topic, 'form_version', String(selectedForm.version));
    }

    const bot =
      guild.members.me;

    if (!bot) {
      throw new Error(
        'ResolvX bot member could not be resolved.',
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

    let threadParentChannelId: string | null = null;
    try {
      if (advancedSettings.ticketWorkspace.mode === 'private-threads') {
        const created = await createPrivateThreadTicket(
          guild,
          department,
          String(number),
          cleanSubject,
          interaction.user.id,
        );
        ticketChannel = created.thread;
        threadParentChannelId = created.parent.id;
        await registerInitialPrivateThreadTicket(guild.id, created.thread, {
          ticketNumber: String(number),
          departmentId,
          tagId,
          ownerId: interaction.user.id,
          priority: advancedSettings.ticketDefaults.priority,
          createdAt: now,
          staffRoleId: department.staffRoleId,
          ticketTopic: topic,
          threadParentChannelId: created.parent.id,
          subject: cleanSubject,
        });
      } else {
        ticketChannel = await guild.channels.create({
          name: getTicketChannelName(
            String(number).padStart(4, '0'),
            'open',
            advancedSettings.ticketDefaults.priority,
          ),
          type: ChannelType.GuildText,
          parent: auditParentCategoryId,
          topic,
          permissionOverwrites: overwrites,
          reason: `SupportForge ticket #${number}`,
        }) as TextChannel;
      }

      if (formDraftRecorded) {
        await setTicketFormSubmissionChannel(formRoute?.submissionId ?? interaction.id, ticketChannel.id).catch((error) => {
          // Continue creating the ticket; its topic includes the submission ID,
          // allowing the recovery worker to find the channel if this write fails.
          console.warn('Could not associate the new ticket channel with its form draft yet:', error);
        });
      }

      const panel =
        await ticketChannel.send({
            embeds: [
              buildTicketPanelEmbed(
                guild,
                ticketChannel.name,
                topic,
                config,
              ),
            ],
            components: ticketChannel.type === ChannelType.PrivateThread
              ? buildPrivateThreadTicketComponents('open', ticketChannel.id)
              : buildTicketPanelComponents('open', topic),
          });

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
      if (ticketChannel.type === ChannelType.GuildText) {
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
        }
        ticketChannel.topic = finalTopic;
        updateRuntimeTicketState(ticketChannel, finalTopic, 'open');
      } else {
        await updatePersistedTicketMetadata(ticketChannel.id, {
          metadata: {
            ticketTopic: finalTopic,
            panelMessageId: panel.id,
            panelChannelId: panel.channelId,
          },
        }, {
          id: interaction.user.id,
          attribution: 'actorKnown',
          confidence: 'high',
        });
      }

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
          participantIds: [interaction.user.id],
          metadata: {
            panelMessageId: panel.id,
            panelChannelId: panel.channelId,
            sourcePanelMessageId: interaction.message?.id ?? null,
            sourcePanelChannelId: interaction.channelId,
            sourcePanelMessageUrl: interaction.message?.url ?? null,
            subject: cleanSubject,
            staffRoleId: department.staffRoleId,
            openedAt: now,
            lastActivityAt: now,
            lastCustomerMessageAt: now,
            ticketChannelType: ticketChannel.type === ChannelType.PrivateThread ? 'private-thread' : 'text',
            ...(ticketChannel.type === ChannelType.PrivateThread ? {
              workspaceKind: 'private-thread',
              threadParentChannelId,
              ticketTopic: finalTopic,
            } : {}),
            ...(selectedForm ? {
              formSubmissionInteractionId: formRoute?.submissionId ?? interaction.id,
              formId: selectedForm.id,
              formVersion: selectedForm.version,
            } : {}),
          },
        },
        {
          id: interaction.user.id,
          attribution: 'actorKnown',
          confidence: 'high',
        },
      );

      const requestEmbed = new EmbedBuilder()
        .setColor(getThemeColor(config.theme))
        .setTitle('📨 Support Request')
        .setDescription(cleanDescription)
        .addFields(
          { name: 'Subject', value: cleanSubject, inline: false },
          { name: 'Ticket', value: `#${number}`, inline: true },
          { name: 'Department', value: department.name, inline: true },
        );

      if (selectedForm && formAnswers) {
        requestEmbed.addFields({
          name: 'Form',
          value: selectedForm.name + ' • version ' + selectedForm.version,
          inline: false,
        });
      }

      const requestMessage = await ticketChannel.send({
        allowedMentions: { parse: [] },
        embeds: [requestEmbed],
      });

      /*
       * Discord limits one embed to 25 fields and all embeds in a message to
       * 6,000 combined characters. Keep the initial request embed compact,
       * then send bounded answer pages so a valid 25-field form cannot break
       * ticket creation during message serialization.
       */
      if (selectedForm && formAnswers) {
        const submittedAnswers = formAnswers;
        const answerFields = selectedForm.fields.map((field) => {
          const answer = submittedAnswers[field.id];
          const rendered = Array.isArray(answer)
            ? answer.join(', ')
            : typeof answer === 'boolean'
              ? (answer ? 'Yes' : 'No')
              : answer && typeof answer === 'object' && 'url' in answer
                ? String((answer as { name?: unknown }).name ?? 'Attachment') +
                  ' (' + String((answer as { size?: unknown }).size ?? '?') + ' bytes) ' +
                  String((answer as { url?: unknown }).url ?? '')
                : String(answer ?? '—');
          return {
            name: field.label.slice(0, 45),
            value: (rendered || '—').slice(0, 400),
            inline: false,
          };
        });

        const pageSize = 10;
        const pageCount = Math.ceil(answerFields.length / pageSize);
        for (let page = 0; page < pageCount; page += 1) {
          const pageFields = answerFields.slice(page * pageSize, (page + 1) * pageSize);
          await ticketChannel.send({
            allowedMentions: { parse: [] },
            embeds: [
              new EmbedBuilder()
                .setColor(getThemeColor(config.theme))
                .setTitle('📋 Ticket Form Answers' + (pageCount > 1 ? ' • ' + (page + 1) + '/' + pageCount : ''))
                .setDescription('Form **' + selectedForm.name.slice(0, 80) + '** • version ' + selectedForm.version)
                .addFields(pageFields),
            ],
          });
        }
      }

      await updatePersistedTicketMetadata(
        ticketChannel.id,
        {
          metadata: {
            firstCustomerMessageId: requestMessage.id,
            firstCustomerMessageAt: now,
            lastActivityAt: now,
            lastCustomerMessageAt: now,
          },
        },
        {
          id: interaction.user.id,
          attribution: 'actorKnown',
          confidence: 'high',
        },
      );

      if (selectedForm && formDraftRecorded) {
        const persistedTicket = await getPersistedTicket(ticketChannel.id);
        if (!persistedTicket) {
          throw new Error('Ticket form answers were saved, but the durable ticket record could not be found.');
        }
        await setTicketFormSubmissionChannel(formRoute?.submissionId ?? interaction.id, ticketChannel.id);
        await attachTicketFormSubmission({
          interactionId: formRoute?.submissionId ?? interaction.id,
          ticketId: persistedTicket.id,
          channelId: ticketChannel.id,
        });
      }

      let departmentCategoryName =
        advancedSettings.ticketWorkspace.mode === 'private-threads'
          ? 'private thread workspace for ' + department.name
          : department.name;
      if (ticketChannel.type === ChannelType.GuildText) {
        try {
          const departmentCategory = await ensureDepartmentCategory(guild, department);
          departmentCategoryName = departmentCategory.name;
        } catch (categoryError) {
          // Keep the durable ticket; setup/repair can reconcile category placement later.
          console.warn(
            '⚠️ Ticket #' + number +
              ' was created successfully, but department category provisioning is pending:',
            categoryError,
          );
        }
      }

      await interaction.editReply({
        content:
          '✅ ' + translate(advancedSettings.locale, 'ticket.created.title', { ticketNumber: number }) +
          ': ' + ticketChannel + '\n' +
          translate(advancedSettings.locale, 'ticket.created.description'),
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
              detail: `Ticket created in department ${department.name} under ${departmentCategoryName}.`,
            },
          );
        } catch (error) {
          console.error('⚠️ Ticket creation audit failed:', error);
        }
      })();
    } catch (error) {
      if (formDraftRecorded) {
        await markTicketFormSubmissionFailure(
          formRoute?.submissionId ?? interaction.id,
          'Ticket initialization is incomplete; the response has been retained for recovery.',
        ).catch((persistenceError) => {
          console.warn('Could not mark the retained form response for recovery:', persistenceError);
        });
      }

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
          `⚠️ Ticket #${getField(ticketChannel.type === ChannelType.GuildText ? (ticketChannel.topic ?? '') : topic, 'number') ?? 'unknown'} was created but initialization did not complete. The channel/thread has been preserved for recovery.`,
          error,
        );

        const recoveryThemeColor = getThemeColor((await getGuildConfig(guild.id)).theme);
        await ticketChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(recoveryThemeColor)
              .setTitle('⚠️ ResolvX Ticket Recovery')
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
⚠️ One setup step did not complete, so ResolvX preserved the ticket for recovery instead of reporting a false creation failure.`,
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
      '❌ ResolvX could not create the ticket. Please try again.',
    );
  } finally {
    if (creationLease) {
      await releaseTicketCreationLease(
        guild.id,
        interaction.user.id,
        departmentId,
        creationLease,
      ).catch((error) => {
        console.warn('Could not release ResolvX ticket creation lease:', error);
      });
    }
    ticketCreationLocks.delete(lockKey);
  }
}

async function unclaimModerator(interaction: ButtonInteraction): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ This action can only be used inside a ticket.');
    return;
  }

  const channel = interaction.channel as TextChannel;
  const topic = await getEffectiveTicketTopic(channel, channel.topic ?? '');
  const status = getTicketStatus(topic);
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
    const transitionAt = new Date().toISOString();
    newTopic = setField(
      setField(
        newTopic,
        'claimed_by',
        remaining.join(','),
      ),
      'updated_at',
      transitionAt,
    );
    const ownerId = getField(newTopic, 'owner');
    const additionalParticipants = (getField(newTopic, 'users') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    await transitionPersistedTicket(
      channel.id,
      'claimed',
      {
        claimedByIds: remaining,
        participantIds: [...new Set([...(ownerId ? [ownerId] : []), ...additionalParticipants])],
        metadata: {
          lastActivityAt: transitionAt,
          lastStaffActivityAt: transitionAt,
        },
      },
      interactionActor(interaction),
      transitionAt,
    );

    try {
      await applyTicketVisibilityMode(
        channel,
        newTopic,
        'claimed',
        interaction.user.id,
        { topic: newTopic },
      );
    } catch (error) {
      console.warn(
        'Ticket claimant state is durable; Discord permissions/topic will be reconciled by the outbox:',
        error,
      );
    }
    updateRuntimeTicketState(channel, newTopic, 'claimed');
    await syncTicketVoiceParticipants(interaction.guild, newTopic);
    await updateMainMessage(channel, getField(newTopic, 'message'), 'claimed', newTopic);
    await interaction.editReply('✅ You left the ticket. Other assigned moderators remain on it.');
    return;
  }

  newTopic = removeField(newTopic, 'claimed_by');
  newTopic = removeField(newTopic, 'claimed_at');
  newTopic = setField(newTopic, 'status', 'open');
  const transitionAt = new Date().toISOString();
  newTopic = setField(newTopic, 'updated_at', transitionAt);
  const ownerId = getField(newTopic, 'owner');
  const additionalParticipants = (getField(newTopic, 'users') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  /*
   * The state/event/outbox transaction happens before channel edits. The
   * publisher also owns temporary voice cleanup, so a restart at this point
   * cannot orphan a private room or create two competing cleanup attempts.
   */
  await transitionPersistedTicket(
    channel.id,
    'open',
    {
      claimedByIds: [],
      participantIds: [...new Set([...(ownerId ? [ownerId] : []), ...additionalParticipants])],
      metadata: {
        claimedAt: null,
        assignedAt: null,
        lastActivityAt: transitionAt,
        lastStaffActivityAt: transitionAt,
      },
    },
    interactionActor(interaction),
    transitionAt,
  );

  try {
    await applyTicketVisibilityMode(
      channel,
      newTopic,
      'unclaimed',
      interaction.user.id,
      { topic: newTopic },
    );
  } catch (error) {
    console.warn(
      'Ticket is durably unclaimed; Discord topic/name/permissions will be reconciled by the outbox:',
      error,
    );
  }
  updateRuntimeTicketState(channel, newTopic, 'open');

  await updateMainMessage(channel, getField(newTopic, 'message'), 'open', newTopic);
  await interaction.editReply('✅ You left the ticket. It is now open for another moderator to claim.');
}

/* -------------------------------------------------------------------------- */
/* Ticket status transitions                                                  */
/* -------------------------------------------------------------------------- */

async function transition(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
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
    // Load guild policy before changing durable ticket state so localization
    // cannot make a committed transition appear to have failed.
    const advancedSettings = await getAdvancedSettings(interaction.guild.id);

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
        'Invalid ResolvX ticket topic.',
      );
    }

    /*
     * A claimed ticket can be joined by another moderator until the configured
     * simultaneous-moderator limit is reached.
     */
    if (
      oldStatus === newStatus &&
      !(newStatus === 'claimed' && 'customId' in interaction && interaction.customId === 'ticket:claim')
    ) {
      await interaction.editReply(
        `ℹ️ This ticket is already **${capitalize(newStatus)}**.`,
      );
      return;
    }

    if (
      !(newStatus === 'claimed' && 'customId' in interaction && interaction.customId === 'ticket:claim' && oldStatus === 'claimed')
    ) {
      assertTicketStatusTransition(oldStatus, newStatus);
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

    const lifecycleAction = newStatus === 'claimed'
      ? 'claim'
      : newStatus === 'pending'
        ? 'pending'
        : newStatus === 'open'
          ? 'resume'
          : newStatus === 'closed'
            ? 'close'
            : newStatus === 'reopened'
              ? 'reopen'
              : 'archive';
    const authorization = {
      actorId: interaction.user.id,
      ownerId: staff.ownerId,
      isConfiguredStaff: staff.isStaff,
      isAdministrator: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)),
      canManageGuild: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)),
    };
    if (!canPerformTicketAction(authorization, lifecycleAction, oldStatus)) {
      await interaction.editReply(
        newStatus === 'open'
          ? '❌ Only configured staff/admins or the ticket owner resuming their own pending ticket can resume it.'
          : '❌ Only configured department staff or administrators can perform this action.',
      );
      return;
    }

    if (newStatus === 'claimed') {
      const claimedIds = (getField(oldTopic, 'claimed_by') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      const settings = advancedSettings;

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
      // Transcript cleanup is deferred until the durable reopen transition commits.

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
     * The database transition, ticket metadata, domain events, and outbox
     * intent commit together before any Discord-side lifecycle mutations.
     * The outbox worker repairs the Discord representation if the following
     * calls fail or are interrupted by a process restart.
     */
    const transitionTime = new Date().toISOString();
    newTopic = setField(newTopic, 'updated_at', transitionTime);
    const metadataPatch: Record<string, unknown> = {};
    if (newStatus === 'pending') {
      metadataPatch.pendingSince = getField(newTopic, 'pending_since') ?? transitionTime;
    } else if (oldStatus === 'pending') {
      metadataPatch.pendingSince = null;
    }
    if (newStatus === 'reopened') {
      metadataPatch.reopenedAt = getField(newTopic, 'reopened_at') ?? transitionTime;
      metadataPatch.closedAt = null;
      metadataPatch.archivedAt = null;
      metadataPatch.transcriptId = null;
      metadataPatch.transcriptDestinationId = null;
      metadataPatch.pendingSince = null;
    }
    if (newStatus === 'archived') {
      metadataPatch.archivedAt = getField(newTopic, 'archived_at') ?? transitionTime;
    }
    if (newStatus !== 'claimed' && getField(oldTopic, 'voice_channel_id')) {
      metadataPatch.voiceChannelId = null;
      metadataPatch.voiceChannelName = null;
      metadataPatch.voiceStartedAt = null;
      metadataPatch.voiceParticipantIds = [];
    }

    await transitionPersistedTicket(
      channel.id,
      newStatus,
      {
        claimedByIds: (getField(newTopic, 'claimed_by') ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
        participantIds: (getField(newTopic, 'users') ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
        ...(Object.keys(metadataPatch).length ? { metadata: metadataPatch } : {}),
      },
      interactionActor(interaction),
    );

    if (newStatus === 'reopened') {
      try {
        await removePreviousTicketTranscript(interaction.guild!, oldTopic);
      } catch (error) {
        console.warn(
          '⚠️ Previous ticket transcript could not be removed after durable reopen:',
          error,
        );
      }
    }

    /*
     * Voice room cleanup is now secondary to the durable ticket state. Keep
     * the old voice fields available to the cleanup service, while avoiding
     * a separate ticket-topic REST request.
     */
    if (newStatus !== 'claimed' && getField(oldTopic, 'voice_channel_id')) {
      newTopic = await endTicketVoiceMode(
        interaction.guild!,
        channel,
        newTopic,
        newStatus,
        'ResolvX voice mode ended because ticket status changed',
        { deferTicketTopicUpdate: true, queueRename: false },
      );
    }

    /*
     * Discord channel mutations are secondary side effects. A long Discord
     * rate limit must never prevent the durable lifecycle transition from
     * being recorded in PostgreSQL.
     *
     * Do not update discord.js' cached topic when the REST write failed.
     * Pretending the write succeeded creates stale-state bugs on the next
     * interaction.
     */
    const sideEffectFailures: string[] = [];
    let destinationCategoryId: string | undefined;

    try {
      if (newStatus === 'closed') {
        destinationCategoryId = (await ensureClosedCategory(interaction.guild!)).id;
      } else if (newStatus === 'archived') {
        destinationCategoryId = (await ensureArchiveCategory(interaction.guild!)).id;
      } else if (newStatus === 'claimed' || newStatus === 'pending') {
        const optionalCategory = await getOptionalStatusCategory(
          interaction.guild!,
          newStatus,
        );
        if (optionalCategory) destinationCategoryId = optionalCategory.id;
      } else if (newStatus === 'reopened' || newStatus === 'open') {
        const currentConfig = await getGuildConfig(interaction.guild!.id);
        const departmentId = getField(oldTopic, 'department');
        const departmentConfig = departmentId
          ? currentConfig.departments[departmentId]
          : undefined;
        const departmentCategory = departmentConfig?.categoryId
          ? interaction.guild!.channels.cache.get(departmentConfig.categoryId)
          : undefined;

        if (departmentCategory?.type === ChannelType.GuildCategory) {
          destinationCategoryId = departmentCategory.id;
        } else {
          destinationCategoryId = (await ensureOpenCategory(interaction.guild!)).id;
        }
      }
    } catch (storageError) {
      sideEffectFailures.push('ticket storage category');
      console.warn(
        '⚠️ Ticket state was saved, but its storage category could not be prepared:',
        storageError,
      );
    }

    const ticketNumberForName = getField(newTopic, 'number') ?? 'unknown';
    const desiredChannelName = getTicketChannelName(
      ticketNumberForName,
      newStatus,
      await getEffectiveTicketPriority(channel.id, newTopic),
    );

    if (newStatus === 'claimed') {
      try {
        // Ticket topic, channel name, optional status category, and ACL are
        // sent together because they share the Modify Channel route bucket.
        await applyTicketVisibilityMode(
          channel,
          newTopic,
          'claimed',
          undefined,
          {
            topic: newTopic,
            channelName: desiredChannelName,
            ...(destinationCategoryId ? { parentId: destinationCategoryId } : {}),
          },
        );
      } catch (error) {
        sideEffectFailures.push('ticket channel metadata/category/permissions');
        console.warn(
          '⚠️ Claimed ticket channel synchronization is pending/failed; durable state will still be updated:',
          error,
        );
      }

      try {
        await syncTicketVoiceParticipants(interaction.guild!, newTopic);
      } catch (error) {
        sideEffectFailures.push('voice participants');
        console.warn(
          '⚠️ Voice participant synchronization deferred:',
          error,
        );
      }
    } else if (
      newStatus === 'open' ||
      newStatus === 'pending' ||
      newStatus === 'reopened'
    ) {
      try {
        await applyTicketVisibilityMode(
          channel,
          newTopic,
          'unclaimed',
          getField(oldTopic, 'claimed_by'),
          {
            topic: newTopic,
            channelName: desiredChannelName,
            ...(destinationCategoryId ? { parentId: destinationCategoryId } : {}),
          },
        );
      } catch (error) {
        sideEffectFailures.push('ticket channel metadata/category/permissions');
        console.warn(
          '⚠️ Ticket lifecycle channel synchronization is pending/failed; durable state will still be updated:',
          error,
        );
      }
    } else {
      try {
        await applyTicketVisibilityMode(
          channel,
          newTopic,
          'closed',
          getField(oldTopic, 'claimed_by'),
          {
            topic: newTopic,
            channelName: desiredChannelName,
            ...(destinationCategoryId ? { parentId: destinationCategoryId } : {}),
          },
        );
      } catch (error) {
        sideEffectFailures.push('ticket channel metadata/category/read-only permissions');
        console.warn(
          '⚠️ Closed/archived ticket permissions or metadata are pending/failed; durable state will still be updated:',
          error,
        );
      }
    }

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
     * Refresh the panel immediately, then schedule a relocation to the
     * bottom of the conversation. This is especially important when a
     * closed ticket is reopened after a long conversation: the old panel
     * may be hundreds of messages above the current activity.
     */
    try {
      await updateMainMessage(
        channel,
        messageId,
        newStatus,
        newTopic,
      );
    } catch (error) {
      sideEffectFailures.push('ticket panel refresh');
      console.warn(
        '⚠️ Ticket panel refresh was deferred; durable state is already updated:',
        error,
      );
    }

    const locale = advancedSettings.locale;
    const statusLabel = translate(locale, ('ticket.status.' + newStatus) as TranslationKey);
    await interaction.editReply(
      sideEffectFailures.length
        ? '⚠️ ' + translate(locale, 'ticket.status.syncWarning', {
            status: statusLabel,
            details: sideEffectFailures.join(', '),
          })
        : '✅ ' + translate(locale, 'ticket.status.changed', { status: statusLabel }),
    );

    /*
     * Background announcement.
     */
    void channel
      .send(
        '📌 ' + translate(locale, 'ticket.status.announcement', {
          ticketNumber: getField(newTopic, 'number') ?? 'unknown',
          status: statusLabel,
          actor: interaction.user.toString(),
        }),
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
  interaction: ButtonInteraction | ChatInputCommandInteraction,
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
  let closeSyncRunningInBackground = false;

  try {
    // Read the display locale before transcript and lifecycle mutations begin.
    const locale = (await getAdvancedSettings(interaction.guild.id)).locale;
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
      await getEffectiveTicketTopic(
        channel,
        latestTopic || state.topic,
      );

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
        'Invalid ResolvX ticket topic.',
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

    try {
      assertTicketStatusTransition(status, 'closed');
    } catch {
      await interaction.editReply(
        `❌ Ticket #${getField(topic, 'number') ?? 'unknown'} cannot be closed from its current state (**${capitalize(status)}**).`,
      );
      return;
    }

    const staff =
      getStaffContext(
        interaction,
        topic,
      );

    const closeAuthorization = {
      actorId: interaction.user.id,
      ownerId: staff.ownerId,
      isConfiguredStaff: staff.isStaff,
      isAdministrator: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)),
      canManageGuild: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)),
    };
    if (!canPerformTicketAction(closeAuthorization, 'close', status)) {
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
      await getGuildConfig(
          interaction.guild.id,
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

    const transcriptMessage = await transcriptChannel.send({
        content:
          `📄 Transcript for ticket **#${ticketNumber}**`,
        files: [
          transcript,
        ],
      });

    /*
     * Transcript successfully uploaded.
     *
     * Closing a ticket no longer changes channel permissions or requires a
     * Discord channel PATCH. The lifecycle state is persisted locally so the
     * closed-ticket message guard continues to work after a restart.
     */
    const closeTimestamp = closedAt.toISOString();
    let closedTopic = setField(
      setField(
        setField(topic, 'status', 'closed'),
        'closed_at',
        closeTimestamp,
      ),
      'transcript_id',
      transcriptMessage.id,
    );
    closedTopic = setField(closedTopic, 'updated_at', closeTimestamp);

    const ownerIdForParticipants = getField(topic, 'owner');
    const participants = [
      ...new Set([
        ...(ownerIdForParticipants ? [ownerIdForParticipants] : []),
        ...(getField(topic, 'users') ?? '').split(',').map((id) => id.trim()).filter(Boolean),
      ]),
    ];
    const voiceChannelId = getField(topic, 'voice_channel_id');
    const closeMetadata: Record<string, unknown> = {
      closedAt: closeTimestamp,
      closedById: interaction.user.id,
      closedByTag: interaction.user.tag,
      transcriptId: transcriptMessage.id,
      transcriptDestinationId: transcriptChannelId,
      lastActivityAt: closeTimestamp,
      lastStaffActivityAt: closeTimestamp,
    };
    if (voiceChannelId) {
      closeMetadata.voiceChannelId = voiceChannelId;
      closeMetadata.voiceChannelName = getField(topic, 'voice_channel_name') ?? null;
      closeMetadata.voiceStartedAt = getField(topic, 'voice_started_at') ?? null;
      closeMetadata.voiceStartedBy = getField(topic, 'voice_started_by') ?? null;
    }

    /*
     * Transcript delivery succeeded. Commit the complete closed state and
     * transcript reference before touching Discord channel state. The event
     * and outbox entries are in this same database transaction.
     */
    await transitionPersistedTicket(
      channel.id,
      'closed',
      {
        participantIds: participants,
        metadata: closeMetadata,
      },
      interactionActor(interaction),
      closeTimestamp,
    );

    /*
     * The transcript and closed lifecycle state are now durable. Do not keep
     * the Discord interaction in its thinking state while Discord applies
     * channel/category changes, which can be delayed by per-route rate limits.
     * The outbox also retries failed channel reconciliation.
     */
    updateRuntimeTicketState(channel, closedTopic, 'closed');
    await editReplyOrFollowUp(
      interaction,
      '✅ ' + translate(locale, 'ticket.closed.saved', { ticketNumber }),
    );

    closeSyncRunningInBackground = true;
    void (async () => {
      let channelSyncFailed = false;
      let channelMissing = false;

      try {
        if (voiceChannelId) {
          try {
            closedTopic = await endTicketVoiceMode(
              interaction.guild!,
              channel,
              closedTopic,
              'closed',
              'ResolvX voice mode ended because ticket was closed',
              { deferTicketTopicUpdate: true, queueRename: false },
            );
            closedTopic = setField(closedTopic, 'updated_at', closeTimestamp);
            await transitionPersistedTicket(
              channel.id,
              'closed',
              {
                metadata: {
                  voiceChannelId: null,
                  voiceChannelName: null,
                  voiceStartedAt: null,
                  voiceStartedBy: null,
                },
              },
              interactionActor(interaction),
              closeTimestamp,
            );
          } catch (error) {
            channelSyncFailed = true;
            console.warn(
              `⚠️ Ticket #${ticketNumber} was closed durably, but private voice cleanup remains pending:`,
              error,
            );
          }
        }

        const closedChannelName = getTicketChannelName(
          ticketNumber,
          'closed',
          await getEffectiveTicketPriority(channel.id, closedTopic),
        );

        try {
          const closedCategory = await ensureClosedCategory(interaction.guild!);
          await applyTicketVisibilityMode(
            channel,
            closedTopic,
            'closed',
            getField(topic, 'claimed_by'),
            {
              topic: closedTopic,
              channelName: closedChannelName,
              parentId: closedCategory.id,
            },
          );
          channel.topic = closedTopic;
          channel.name = closedChannelName;
          console.log(`✅ Closed ticket #${ticketNumber} Discord channel sync completed.`);
        } catch (error) {
          channelSyncFailed = true;
          channelMissing = isUnknownChannelError(error);
          if (channelMissing) {
            console.warn(
              `⚠️ Ticket #${ticketNumber} was closed durably, but its Discord channel no longer exists; channel synchronization was skipped.`,
            );
          } else {
            console.warn(
              `⚠️ Ticket #${ticketNumber} is closed in durable storage, but the Discord topic/category/name update is pending or failed:`,
              error,
            );
          }
        }

        updateRuntimeTicketState(channel, closedTopic, 'closed');

        if (!channelMissing) {
          /*
           * These Discord messages are ancillary. They must not delay the
           * close acknowledgement or block durable ticket closure.
           */
          void updateMainMessage(
            channel,
            messageId,
            'closed',
            closedTopic,
          ).catch((error) => {
            console.warn(`⚠️ Closed ticket #${ticketNumber} panel refresh failed:`, error);
          });

          void channel
            .send('🔒 ' + translate(locale, 'ticket.closed.announcement', {
              ticketNumber,
              actor: interaction.user.toString(),
            }))
            .catch((error) => {
              console.error('⚠️ Close announcement failed:', error);
            });
        }

        if (channelSyncFailed) {
          console.warn(
            `⚠️ Ticket #${ticketNumber} is closed in PostgreSQL; background Discord synchronization needs reconciliation.`,
          );
        }

        try {
          if (config.supportCategoryId) {
            await logTicketEvent(
              interaction.guild!,
              config.supportCategoryId,
              {
                ticketNumber,
                event: 'ticket_closed',
                actor: interaction.user.tag,
                detail: 'Transcript uploaded successfully and ticket status changed to closed.',
              },
            );
          }
        } catch (error) {
          console.error('⚠️ Close audit failed:', error);
        }
      } catch (error) {
        console.error(
          `❌ Background synchronization failed for durably closed ticket #${ticketNumber}:`,
          error,
        );
      } finally {
        ticketActionLocks.delete(lockKey);
      }
    })();

    return;
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
    if (!closeSyncRunningInBackground) {
      ticketActionLocks.delete(
        lockKey,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Ticket creation modal                                                      */
/* -------------------------------------------------------------------------- */

export async function showTicketCreationModalFromCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // A slash command can open a modal directly only before it is deferred.
  // This gives ticket creation a real slash-command entry point while reusing
  // the same versioned-form and modal-submit pipeline as the panel button.
  if (!interaction.guild) {
    await interaction.reply({ content: 'Ticket creation must be used inside a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guild = interaction.guild;
  const departmentId = interaction.options.getString('department-id', true).trim();
  const tagId = interaction.options.getString('tag-id', true).trim();

  try {
    if (!(await ensureSupportHoursAllows(interaction, guild.id, departmentId))) return;
    // The intake admission check uses preloaded policy state; ticket creation rechecks it after the form is submitted.
    const cachedForm = getCachedActiveTicketFormForRouting(guild.id, departmentId, tagId);
    if (!cachedForm.ready) {
      await interaction.reply({ content: 'Ticket forms are still loading. Please try again in a moment.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (cachedForm.form) {
      const expiresAt = Date.now() + TICKET_FORM_MODAL_TTL_MS;
      const sessionId = randomBytes(10).toString('base64url');
      await interaction.showModal(buildTicketFormModal(cachedForm.form, tagId, expiresAt, sessionId, 1, {}));
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId('ticket:modal:' + departmentId + ':' + tagId)
      .setTitle('Support Request');
    const subjectInput = new TextInputBuilder()
      .setCustomId('subject')
      .setPlaceholder('Briefly describe your issue')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);
    const descriptionInput = new TextInputBuilder()
      .setCustomId('description')
      .setPlaceholder('Keep paragraphs and bullet points as written.')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);
    modal.addLabelComponents(
      new LabelBuilder().setLabel('What do you need help with?').setTextInputComponent(subjectInput),
      new LabelBuilder().setLabel('Describe your issue').setDescription('Up to 4,000 characters').setTextInputComponent(descriptionInput),
    );
    await interaction.showModal(modal);
  } catch (error) {
    console.error('Failed to open ticket creation modal from slash command:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'ResolvX could not open the ticket form. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }
}

async function showTicketTagSelector(
  interaction: ButtonInteraction,
  departmentId: string,
  page = 0,
  panelId?: string,
): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  if (!interaction.guild) {
    await replyError(interaction, '❌ This action must be used inside a server.');
    return;
  }

  if (!(await ensureSupportHoursAllows(interaction, interaction.guild.id, departmentId, panelId))) return;

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
    .setCustomId('ticket:create-tag:select:' + departmentId + (panelId ? ':' + panelId : ''))
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
            'ticket:create-tag:page:' + departmentId + ':' + (safePage - 1) + (panelId ? ':' + panelId : ''),
          )
          .setLabel('Previous')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage === 0),
        new ButtonBuilder()
          .setCustomId('ticket:create-tag:page:' + departmentId + ':' + safePage + (panelId ? ':' + panelId : ''))
          .setLabel('Page ' + (safePage + 1) + ' / ' + pageCount)
          .setEmoji('📄')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(
            'ticket:create-tag:page:' + departmentId + ':' + (safePage + 1) + (panelId ? ':' + panelId : ''),
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
  const panelId = parts[4] || undefined;
  const tagId = interaction.values[0] ?? '';

  /*
   * The tag menu was generated from the current department configuration.
   * Do not perform another configuration load before showModal(): the
   * interaction has a very short acknowledgement window. The modal submit
   * validates the department/tag again before creating the ticket.
   */
  await showTicketCreationModal(interaction, departmentId, tagId, panelId);
}

interface ParsedTicketFormModalId {
  formId: string;
  version: number;
  expiresAt: number;
  sessionId: string;
  tagId: string;
  step: number;
  panelId?: string;
}

function encodeFormIdForModal(formId: string): string {
  const hex = formId.replace(/-/g, '');
  if (!/^[a-f0-9]{32}$/i.test(hex)) throw new Error('The ticket form identifier is malformed.');
  return Buffer.from(hex, 'hex').toString('base64url');
}

function decodeFormIdFromModal(encoded: string): string | null {
  try {
    const hex = Buffer.from(encoded, 'base64url').toString('hex');
    if (!/^[a-f0-9]{32}$/i.test(hex)) return null;
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' + hex.slice(20);
  } catch {
    return null;
  }
}

function buildTicketFormModalCustomId(args: {
  formId: string;
  version: number;
  expiresAt: number;
  sessionId: string;
  tagId: string;
  step: number;
  panelId?: string;
}): string {
  const customId = [
    'tf',
    encodeFormIdForModal(args.formId),
    String(args.version),
    Math.floor(args.expiresAt / 1000).toString(36),
    args.sessionId,
    Buffer.from(args.tagId, 'utf8').toString('base64url'),
    String(args.step),
    ...(args.panelId ? [Buffer.from(args.panelId, 'utf8').toString('base64url')] : []),
  ].join(':');
  if (customId.length > 100) throw new Error('This form route is too long to fit Discord’s modal custom-id limit.');
  return customId;
}

function parseTicketFormModalCustomId(customId: string): ParsedTicketFormModalId | null {
  const parts = customId.split(':');
  if ((parts.length !== 7 && parts.length !== 8) || parts[0] !== 'tf') return null;
  const formId = decodeFormIdFromModal(parts[1] ?? '');
  const version = Number(parts[2]);
  const expiresSeconds = Number.parseInt(parts[3] ?? '', 36);
  const sessionId = parts[4] ?? '';
  const tagIdEncoded = parts[5] ?? '';
  const step = Number(parts[6]);
  let tagId = '';
  let panelId: string | undefined;
  try {
    tagId = Buffer.from(tagIdEncoded, 'base64url').toString('utf8');
    if (parts[7]) panelId = Buffer.from(parts[7], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if ((panelId !== undefined && !/^[A-Za-z0-9_-]{1,50}$/.test(panelId)) ||
      !formId || !Number.isSafeInteger(version) || version < 1 ||
      !Number.isSafeInteger(expiresSeconds) || expiresSeconds < 1 ||
      !/^[A-Za-z0-9_-]{12,20}$/.test(sessionId) ||
      !tagId || tagId.length > 100 ||
      !Number.isInteger(step) || step < 1 || step > 10) {
    return null;
  }
  return { formId, version, expiresAt: expiresSeconds * 1000, sessionId, tagId, step, ...(panelId ? { panelId } : {}) };
}

function buildTicketFormModal(
  form: TicketFormVersion,
  tagId: string,
  expiresAt: number,
  sessionId: string,
  step: number,
  priorAnswers: Record<string, unknown>,
  panelId?: string,
): ModalBuilder {
  const customId = buildTicketFormModalCustomId({
    formId: form.id,
    version: form.version,
    expiresAt,
    sessionId,
    tagId,
    step,
    panelId,
  });
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle((form.name + (step > 1 ? ' • Step ' + step : '')).slice(0, 45));
  const labels: LabelBuilder[] = [];

  if (step === 1) {
    labels.push(
      new LabelBuilder()
        .setLabel('What do you need help with?')
        .setDescription('A short title helps the support team scan your request.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('subject')
            .setPlaceholder('Briefly describe your issue')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100),
        ),
      new LabelBuilder()
        .setLabel('Describe your issue')
        .setDescription('Required • Up to 4,000 characters')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('description')
            .setPlaceholder('Keep paragraphs and bullet points as written.')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000),
        ),
    );
  }

  for (const field of getVisibleTicketFormFields(form.fields, step, priorAnswers)) {
    const customId = 'form_' + field.id;
    const label = new LabelBuilder().setLabel(field.label.slice(0, 45));
    const fieldGuidance = [field.required ? 'Required' : 'Optional', field.placeholder].filter(Boolean).join(' • ');
    if (fieldGuidance) label.setDescription(fieldGuidance.slice(0, 100));

    switch (field.type) {
      case 'dropdown': {
        const select = new StringSelectMenuBuilder()
          .setCustomId(customId)
          .setPlaceholder((field.placeholder || 'Choose an option').slice(0, 150))
          .setRequired(field.required)
          .setMinValues(field.required ? 1 : 0)
          .setMaxValues(1)
          .addOptions((field.choices ?? []).map((choice) =>
            new StringSelectMenuOptionBuilder().setLabel(choice.slice(0, 100)).setValue(choice),
          ));
        label.setStringSelectMenuComponent(select);
        break;
      }
      case 'multi_select': {
        const select = new StringSelectMenuBuilder()
          .setCustomId(customId)
          .setPlaceholder((field.placeholder || 'Choose one or more options').slice(0, 150))
          .setRequired(field.required)
          .setMinValues(field.required ? 1 : 0)
          .setMaxValues(Math.max(1, Math.min(25, field.choices?.length ?? 1)))
          .addOptions((field.choices ?? []).map((choice) =>
            new StringSelectMenuOptionBuilder().setLabel(choice.slice(0, 100)).setValue(choice),
          ));
        label.setStringSelectMenuComponent(select);
        break;
      }
      case 'discord_user': {
        label.setUserSelectMenuComponent(
          new UserSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder((field.placeholder || 'Choose a server member').slice(0, 150))
            .setRequired(field.required)
            .setMinValues(field.required ? 1 : 0)
            .setMaxValues(1),
        );
        break;
      }
      case 'discord_role': {
        label.setRoleSelectMenuComponent(
          new RoleSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder((field.placeholder || 'Choose a server role').slice(0, 150))
            .setRequired(field.required)
            .setMinValues(field.required ? 1 : 0)
            .setMaxValues(1),
        );
        break;
      }
      case 'checkbox': {
        label.setCheckboxGroupComponent(
          new CheckboxGroupBuilder()
            .setCustomId(customId)
            .setRequired(field.required)
            .setMinValues(field.required ? 1 : 0)
            .setMaxValues(1)
            .addOptions({ label: 'Confirm', value: 'checked' }),
        );
        break;
      }
      case 'attachment': {
        label.setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId(customId)
            .setRequired(field.required)
            .setMinValues(field.required ? 1 : 0)
            .setMaxValues(1),
        );
        break;
      }
      default: {
        const maxLength = Math.min(4000, Math.max(1, field.maxLength ?? (field.type === 'long_text' ? 1500 : 100)));
        const input = new TextInputBuilder()
          .setCustomId(customId)
          .setPlaceholder((field.placeholder || field.label).slice(0, 100))
          .setStyle(field.type === 'long_text' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(field.required)
          .setMaxLength(maxLength);
        if ((field.minLength ?? 0) > 0) input.setMinLength(field.minLength ?? 0);
        label.setTextInputComponent(input);
        break;
      }
    }
    labels.push(label);
  }

  if (labels.length === 0) throw new Error('This step has no visible fields and cannot be displayed.');
  modal.addLabelComponents(...labels);
  return modal;
}

async function showTicketCreationModal(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  departmentId: string,
  tagId: string,
  panelId?: string,
): Promise<void> {
  if (!interaction.guild) {
    await replyError(
      interaction,
      '❌ This action can only be used inside a server.',
    );
    return;
  }

  try {
    if (!(await ensureSupportHoursAllows(interaction, interaction.guild.id, departmentId, panelId))) return;
    /*
     * The support-hours service is initialized before login and evaluates its
     * cached policy without a network call. Submission rechecks the policy.
     */
    /*
     * Form configuration is stored durably in Neon. Only the matching
     * active form version is embedded in the modal ID; submission validates
     * that version again so a stale modal can never silently use edited rules.
     */
    const cachedForm = getCachedActiveTicketFormForRouting(
      interaction.guild.id,
      departmentId,
      tagId,
    );
    if (!cachedForm.ready) {
      await replyError(
        interaction,
        '⌛ Ticket forms are still loading. Please try again in a moment.',
      );
      return;
    }
    const form = cachedForm.form;
    if (form) {
      const expiresAt = Date.now() + TICKET_FORM_MODAL_TTL_MS;
      const sessionId = randomBytes(10).toString('base64url');
      await interaction.showModal(
        buildTicketFormModal(form, tagId, expiresAt, sessionId, 1, {}, panelId),
      );
      return;
    }

    // Keep the no-form legacy flow compact. Department and tag are validated
    // by createTicket after it acknowledges the modal submission.
    const customId = 'ticket:modal:' + departmentId + ':' + tagId + (panelId ? ':panel:' + panelId : '');
    const modal = new ModalBuilder()
      .setCustomId(customId)
      .setTitle('Support Request');

    const subjectInput = new TextInputBuilder()
      .setCustomId('subject')
      .setPlaceholder('Briefly describe your issue')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const descriptionInput = new TextInputBuilder()
      .setCustomId('description')
      .setPlaceholder('Keep paragraphs and bullet points as written.')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);

    const labels: LabelBuilder[] = [
      new LabelBuilder()
        .setLabel('What do you need help with?')
        .setDescription('A short title helps the support team scan your request.')
        .setTextInputComponent(subjectInput),
      new LabelBuilder()
        .setLabel('Describe your issue')
        .setDescription('Required • Up to 4,000 characters')
        .setTextInputComponent(descriptionInput),
    ];

    modal.addLabelComponents(...labels);

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
      '❌ ResolvX could not open the ticket creation form. Please try again.',
    );
  }
}

function readTicketFormStepAnswers(
  interaction: ModalSubmitInteraction,
  fields: TicketFormVersion['fields'],
): Record<string, unknown> {
  const rawAnswers: Record<string, unknown> = {};
  for (const field of fields) {
    const customId = 'form_' + field.id;
    switch (field.type) {
      case 'dropdown':
      case 'multi_select':
        rawAnswers[field.id] = Array.from(interaction.fields.getStringSelectValues(customId));
        break;
      case 'checkbox':
        rawAnswers[field.id] = Array.from(interaction.fields.getCheckboxGroup(customId));
        break;
      case 'discord_user':
        rawAnswers[field.id] = Array.from(interaction.fields.getSelectedUsers(customId)?.keys() ?? []);
        break;
      case 'discord_role':
        rawAnswers[field.id] = Array.from(interaction.fields.getSelectedRoles(customId)?.keys() ?? []);
        break;
      case 'attachment':
        rawAnswers[field.id] = Array.from(interaction.fields.getUploadedFiles(customId)?.values() ?? []).map((file) => ({
          id: file.id,
          url: file.url,
          name: file.name,
          size: file.size,
          contentType: file.contentType,
        }));
        break;
      default:
        rawAnswers[field.id] = interaction.fields.getTextInputValue(customId);
        break;
    }
  }
  return validateTicketFormAnswers(fields, rawAnswers);
}

async function validateTicketFormPrincipals(
  interaction: ModalSubmitInteraction,
  answers: Record<string, unknown>,
  fields: TicketFormVersion['fields'],
): Promise<void> {
  if (!interaction.guild) throw new Error('This form must be submitted inside a server.');
  for (const field of fields) {
    const answer = answers[field.id];
    if (typeof answer !== 'string') continue;
    if (field.type === 'discord_user') {
      const member = await interaction.guild.members.fetch(answer).catch(() => null);
      if (!member) throw new Error('"' + field.label + '" must reference a member of this server.');
    } else if (field.type === 'discord_role') {
      const role = await interaction.guild.roles.fetch(answer).catch(() => null);
      if (!role || role.managed) throw new Error('"' + field.label + '" must reference a normal role in this server.');
    }
  }
}

async function handleTicketFormWizardContinue(interaction: ButtonInteraction): Promise<void> {
  const route = parseTicketFormModalCustomId(interaction.customId);
  if (!interaction.guild || !route) {
    await replyError(interaction, translate((await getAdvancedSettings(interaction.guild!.id)).locale, 'forms.continuation.invalid'));
    return;
  }
  if (route.expiresAt <= Date.now()) {
    await replyError(interaction, 'This form expired. Reopen the support panel and start again.');
    return;
  }

  try {
    const cached = getCachedActiveTicketFormById(
      interaction.guild.id,
      route.formId,
      route.version,
      route.tagId,
    );
    if (!cached.ready) {
      await replyError(interaction, 'Ticket forms are still loading. Please try again in a moment.');
      return;
    }
    if (!cached.form) {
      await replyError(interaction, 'This form changed or was disabled. Reopen the support panel and start again.');
      return;
    }
    const session = await getTicketFormWizardSession({
      sessionId: route.sessionId,
      guildId: interaction.guild.id,
      submittedBy: interaction.user.id,
      formId: route.formId,
      formVersion: route.version,
      tagId: route.tagId,
      step: route.step,
    });
    const visibleFields = getVisibleTicketFormFields(cached.form.fields, route.step, session.answers);
    if (!visibleFields.length) {
      await replyError(interaction, 'This form step has no visible questions. Reopen the support panel and start again.');
      return;
    }
    await interaction.showModal(
      buildTicketFormModal(
        cached.form,
        route.tagId,
        route.expiresAt,
        route.sessionId,
        route.step,
        session.answers,
        route.panelId,
      ),
    );
  } catch (error) {
    console.error('Failed to continue ticket form wizard:', error);
    await replyError(
      interaction,
      error instanceof Error ? error.message : 'Could not continue this form. Reopen the support panel and start again.',
    );
  }
}

async function handleTicketFormWizardModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) {
    await replyError(interaction, '❌ This action can only be used inside a server.');
    return;
  }

  if (!(await safeDeferReply(interaction))) return;

  const route = parseTicketFormModalCustomId(interaction.customId);
  if (!route) {
    await replyError(interaction, '❌ This ticket form link is malformed. Reopen the support panel.');
    return;
  }
  if (route.expiresAt <= Date.now()) {
    await replyError(interaction, '⌛ ' + translate((await getAdvancedSettings(interaction.guild!.id)).locale, 'forms.expired'));
    return;
  }

  try {
    const cached = getCachedActiveTicketFormById(
      interaction.guild.id,
      route.formId,
      route.version,
      route.tagId,
    );
    if (!cached.ready) {
      await replyError(interaction, '⌛ Ticket forms are still loading. Please reopen the support panel in a moment.');
      return;
    }
    if (!cached.form) {
      await replyError(interaction, 'This form changed or was disabled. Reopen the support panel and start again.');
      return;
    }

    let priorSession: Awaited<ReturnType<typeof getTicketFormWizardSession>> | undefined;
    if (route.step > 1) {
      priorSession = await getTicketFormWizardSession({
        sessionId: route.sessionId,
        guildId: interaction.guild.id,
        submittedBy: interaction.user.id,
        formId: route.formId,
        formVersion: route.version,
        tagId: route.tagId,
        step: route.step,
      });
    }

    // Use the last known-good schema for component extraction, then compare
    // it to the current DB version before advancing or creating a ticket.
    const cachedForm = cached.form;
    const visibleFields = getVisibleTicketFormFields(
      cachedForm.fields,
      route.step,
      priorSession?.answers ?? {},
    );
    if (visibleFields.length === 0) {
      await replyError(interaction, 'This form step no longer has visible questions. Reopen the support panel and start again.');
      return;
    }

    let subject = priorSession?.subject ?? null;
    let description = priorSession?.description ?? null;
    if (route.step === 1) {
      subject = interaction.fields.getTextInputValue('subject').trim();
      description = interaction.fields.getTextInputValue('description').trim();
      if (!subject || subject.length > 100 || !description || description.length > 4000) {
        await replyError(interaction, '❌ Enter a subject of 1–100 characters and a description of 1–4,000 characters.');
        return;
      }
    }

    const stepAnswers = readTicketFormStepAnswers(interaction, visibleFields);
    await validateTicketFormPrincipals(interaction, stepAnswers, visibleFields);
    const answersForVisibility = { ...(priorSession?.answers ?? {}), ...stepAnswers };

    const maxStep = getTicketFormStepCount(cachedForm.fields);
    let nextStep: number | undefined;
    for (let candidateStep = route.step + 1; candidateStep <= maxStep; candidateStep += 1) {
      if (getVisibleTicketFormFields(cachedForm.fields, candidateStep, answersForVisibility).length > 0) {
        nextStep = candidateStep;
        break;
      }
    }
    const finalStep = nextStep === undefined;
    const currentForm = await getTicketFormForWizard({
      guildId: interaction.guild.id,
      formId: route.formId,
      version: route.version,
      tagId: route.tagId,
    });
    if (currentForm.departmentId !== cachedForm.departmentId) {
      await replyError(interaction, 'This form’s routing changed. Reopen the support panel and start again.');
      return;
    }

    const session = await saveTicketFormWizardStep({
      sessionId: route.sessionId,
      guildId: interaction.guild.id,
      submittedBy: interaction.user.id,
      form: currentForm,
      tagId: route.tagId,
      step: route.step,
      nextStep: nextStep ?? maxStep + 1,
      answerDelta: stepAnswers,
      ...(route.step === 1 ? { subject: subject ?? '', description: description ?? '' } : {}),
      expiresAt: route.expiresAt,
      finalStep,
    });

    if (!finalStep && nextStep !== undefined) {
      const continueCustomId = buildTicketFormModalCustomId({
        formId: currentForm.id,
        version: currentForm.version,
        expiresAt: route.expiresAt,
        sessionId: route.sessionId,
        tagId: route.tagId,
        step: nextStep,
        panelId: route.panelId,
      });
      await interaction.editReply({
        content: '✅ ' + translate((await getAdvancedSettings(interaction.guild!.id)).locale, 'forms.answers.saved'),
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(continueCustomId)
              .setLabel('Continue form')
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      });
      return;
    }

    await createTicket(
      interaction,
      currentForm.departmentId,
      route.tagId,
      {
        formId: currentForm.id,
        version: currentForm.version,
        expiresAt: route.expiresAt,
        submissionId: route.sessionId,
        panelId: route.panelId,
      },
      {
        form: currentForm,
        answers: session.answers,
        subject: session.subject ?? '',
        description: session.description ?? '',
      },
      true,
      route.panelId,
    );
  } catch (error) {
    await replyError(
      interaction,
      '❌ ' + (error instanceof Error ? error.message : 'The ticket form could not be processed. Please try again.'),
    );
  }
}

function isTicketParticipant(topic: string, userId: string, reporterId?: string): boolean {
  if (!userId || (reporterId && userId === reporterId)) return false;

  const ownerId = getField(topic, 'owner');
  if (ownerId === userId) return true;

  const participants = [
    ...(getField(topic, 'users') ?? '').split(','),
    ...(getField(topic, 'claimed_by') ?? '').split(','),
  ].map((id) => id.trim()).filter(Boolean);

  return participants.includes(userId);
}

async function showReportTargetSelector(interaction: ButtonInteraction, page = 0): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ Reporting is only available inside a ticket.');
    return;
  }

  const topic = await getEffectiveTicketTopic(
    interaction.channel as TextChannel,
    interaction.channel.topic ?? '',
  );
  const reportSettings = await getAdvancedSettings(interaction.guild.id);

  if (!isTicketTopic(topic) || !isActiveTicketStatus(getTicketStatus(topic))) {
    await replyError(interaction, '❌ Reporting is only available on an active ResolvX ticket.');
    return;
  }

  if (!reportSettings.reports.enabled) {
    await interaction.editReply(
      '🛡️ User reporting is currently disabled by the server administrators.',
    );
    return;
  }

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
  const topic = interaction.channel?.type === ChannelType.GuildText
    ? await getEffectiveTicketTopic(
        interaction.channel as TextChannel,
        interaction.channel.topic ?? '',
      )
    : '';

  if (!isTicketParticipant(topic, targetId, interaction.user.id)) {
    await replyError(interaction, '❌ That user is no longer a reportable participant on this ticket.');
    return;
  }

  const settings = await getAdvancedSettings(interaction.guild!.id);

  const rows = Object.values(settings.reports.categories).slice(0, 25);
  await interaction.editReply({
    content: '🚩 **Report category**\nChoose the category that best describes the behaviour. The category set is built into ResolvX and is separate from ticket use-case/departments.',
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

async function renderReportSubcategorySelector(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  targetId: string,
  categoryId: string,
  page = 0,
): Promise<void> {
  const settings = await getAdvancedSettings(interaction.guild!.id);
  const category = settings.reports.categories[categoryId];

  if (!category) {
    await replyError(interaction, '❌ That report category is no longer available.');
    return;
  }

  const subcategories = Object.values(category.subcategories);
  if (!subcategories.length) {
    await replyError(interaction, '❌ That report category has no configured subcategories.');
    return;
  }

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(subcategories.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = subcategories.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ticket:report:subcategory:' + targetId + ':' + categoryId)
        .setPlaceholder('Choose a report subcategory')
        .addOptions(visible.map((sub) => ({
          label: sub.name.slice(0, 100),
          value: sub.id,
          description: category.name,
        }))),
    ),
  ];

  if (pageCount > 1) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket:report:subcategory:page:' + targetId + ':' + categoryId + ':' + (safePage - 1))
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage === 0),
        new ButtonBuilder()
          .setCustomId('ticket:report:subcategory:page:' + targetId + ':' + categoryId + ':' + safePage)
          .setLabel('Page ' + (safePage + 1) + ' / ' + pageCount)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId('ticket:report:subcategory:page:' + targetId + ':' + categoryId + ':' + (safePage + 1))
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage >= pageCount - 1),
      ),
    );
  }

  const payload = {
    content: '🚩 **Report subcategory**\nChoose the most specific reason.' +
      (pageCount > 1 ? '\nPage ' + (safePage + 1) + ' of ' + pageCount + '.' : ''),
    components,
  };

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply(payload);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

async function handleReportCategorySelection(interaction: StringSelectMenuInteraction): Promise<void> {
  await interaction.deferUpdate();
  const parts = interaction.customId.split(':');
  const targetId = parts[3] ?? '';
  const topic = interaction.channel?.type === ChannelType.GuildText
    ? await getEffectiveTicketTopic(
        interaction.channel as TextChannel,
        interaction.channel.topic ?? '',
      )
    : '';

  if (!isTicketParticipant(topic, targetId, interaction.user.id)) {
    await replyError(interaction, '❌ That user is no longer a reportable participant on this ticket.');
    return;
  }

  const settings = await getAdvancedSettings(interaction.guild!.id);
  if (!settings.reports.categories[interaction.values[0]]) {
    await replyError(interaction, '❌ That report category is no longer configured.');
    return;
  }

  const categoryId = interaction.values[0];
  await renderReportSubcategorySelector(interaction, targetId, categoryId, 0);
}

async function handleReportSubcategorySelection(interaction: StringSelectMenuInteraction): Promise<void> {
  const parts = interaction.customId.split(':');
  const targetId = parts[3] ?? '';
  const categoryId = parts[4] ?? '';
  const subcategoryId = interaction.values[0];
  const topic = interaction.channel?.type === ChannelType.GuildText
    ? await getEffectiveTicketTopic(
        interaction.channel as TextChannel,
        interaction.channel.topic ?? '',
      )
    : '';

  const settings = await getAdvancedSettings(interaction.guild!.id);
  if (
    !isTicketParticipant(topic, targetId, interaction.user.id) ||
    !settings.reports.categories[categoryId]?.subcategories[subcategoryId]
  ) {
    await replyError(interaction, '❌ This report selection is no longer valid for the current ticket.');
    return;
  }

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

  if (!isTicketTopic(topic) || !isActiveTicketStatus(getTicketStatus(topic))) {
    await replyError(interaction, '❌ Reporting is only available on an active ResolvX ticket.');
    return;
  }

  if (!isTicketParticipant(topic, targetUserId, interaction.user.id)) {
    await replyError(interaction, '❌ The reported user is no longer a participant on this ticket.');
    return;
  }

  const settings = await getAdvancedSettings(interaction.guild.id);
  if (
    !settings.reports.categories[categoryId]?.subcategories[subcategoryId]
  ) {
    await replyError(interaction, '❌ The selected report reason is no longer configured.');
    return;
  }

  const nonce = Math.random().toString(36).slice(2, 10);
  prunePendingReportDecisions();

  pendingReportDecisions.set(nonce, {
    guildId: interaction.guild.id,
    channelId: interaction.channel.id,
    targetUserId,
    categoryId,
    subcategoryId,
    description: interaction.fields.getTextInputValue('description').trim().slice(0, 500),
    reporterUserId: interaction.user.id,
    ticketNumber: getField(topic, 'number'),
    expiresAt: Date.now() + PENDING_REPORT_DECISION_TTL_MS,
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
  prunePendingReportDecisions();
  const pending = pendingReportDecisions.get(nonce);

  if (
    !pending ||
    pending.expiresAt <= Date.now() ||
    pending.reporterUserId !== interaction.user.id ||
    pending.guildId !== interaction.guild?.id ||
    pending.channelId !== interaction.channel?.id ||
    (decision !== 'flag' && decision !== 'record')
  ) {
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

  if (interaction.guild && !isPremiumOrHigher(await getTier(interaction.guild.id))) {
    await interaction.editReply(
      '🔒 Ticket history is available in Premium/Pro demo mode.',
    );
    return;
  }

  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, '❌ Ticket history is only available inside a ticket channel.');
    return;
  }

  try {
    const channel = interaction.channel as TextChannel;
    const topic = channel.topic ?? '';
    const staff = getStaffContext(interaction, topic);

    if (!staff.authorized) {
      await interaction.editReply(
        '❌ Ticket history is restricted to configured moderators or administrators.',
      );
      return;
    }

    const ticketNumber = getField(topic, 'number') ?? 'unknown';

    const events = await getTicketAuditHistory(
      interaction.guild.id,
      ticketNumber,
      channel.id,
    );

    const recent = events.slice(-20).reverse();

    if (!recent.length) {
      const historyThemeColor = getThemeColor((await getGuildConfig(interaction.guild.id)).theme);
      await interaction.editReply({
        content: '',
        embeds: [new EmbedBuilder()
          .setColor(historyThemeColor)
          .setTitle('📜 Ticket #' + ticketNumber + ' History')
          .setDescription('No audit events have been recorded for this ticket yet.')
          .setFooter({ text: 'Ticket activity will appear here as events are recorded.' })],
      });
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

    const historyThemeColor = getThemeColor((await getGuildConfig(interaction.guild.id)).theme);
    const embeds = chunks.slice(0, 2).map((chunk, index) =>
      new EmbedBuilder()
        .setColor(historyThemeColor)
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
    await replyError(interaction, '❌ ResolvX could not load this ticket history.');
  }
}

async function renderDepartmentSelector(interaction: ButtonInteraction | StringSelectMenuInteraction, page = 0): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    if (interaction.isButton()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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

export async function executeTicketReportCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, 'Reporting must be run inside an active ResolvX ticket.');
    return;
  }
  const channel = interaction.channel as TextChannel;
  const topic = await getEffectiveTicketTopic(channel, channel.topic ?? '');
  const status = (await getPersistedTicketStatus(channel.id)) ?? getTicketStatus(topic);
  if (!isTicketTopic(topic) || !isActiveTicketStatus(status)) {
    await replyError(interaction, 'Reporting is only available inside an active ResolvX ticket.');
    return;
  }
  const staff = getStaffContext(interaction, topic);
  if (!staff.authorized) {
    await replyError(interaction, 'Only configured staff or administrators can submit a report.');
    return;
  }
  const target = interaction.options.getUser('target', true);
  const categoryInput = interaction.options.getString('category-id', true).trim();
  const subcategoryInput = interaction.options.getString('subcategory-id', true).trim();
  const description = interaction.options.getString('description') ?? '';
  const flagged = interaction.options.getBoolean('flag', true);
  const reportSettings = await getAdvancedSettings(interaction.guild.id);
  const selectedCategory = Object.values(reportSettings.reports.categories).find((item) =>
    item.id.toLowerCase() === categoryInput.toLowerCase() || item.name.toLowerCase() === categoryInput.toLowerCase());
  const selectedSubcategory = selectedCategory
    ? Object.values(selectedCategory.subcategories).find((item) =>
        item.id.toLowerCase() === subcategoryInput.toLowerCase() || item.name.toLowerCase() === subcategoryInput.toLowerCase())
    : undefined;
  if (!selectedCategory || !selectedSubcategory) {
    await replyError(interaction, 'Report category/subcategory not found. Enter the configured name or ID shown in Settings → Reports.');
    return;
  }
  const categoryId = selectedCategory.id;
  const subcategoryId = selectedSubcategory.id;
  const participants = new Set([
    getField(topic, 'owner'),
    ...(getField(topic, 'users') ?? '').split(',').filter(Boolean),
    ...(getField(topic, 'claimed_by') ?? '').split(',').filter(Boolean),
  ].filter((id): id is string => Boolean(id)));
  if (!participants.has(target.id)) {
    await replyError(interaction, 'The target must be a participant in this ticket.');
    return;
  }
  if (target.id === interaction.user.id) {
    await replyError(interaction, 'You cannot report yourself.');
    return;
  }
  try {
    const result = await recordReport(interaction.guild, {
      targetUserId: target.id,
      reporterUserId: interaction.user.id,
      reporterName: interaction.user.tag,
      categoryId,
      subcategoryId,
      description,
      flagged,
      channelId: channel.id,
      ticketNumber: getField(topic, 'number') ?? 'unknown',
    });
    const config = await getGuildConfig(interaction.guild.id);
    if (config.supportCategoryId) {
      await logTicketEvent(interaction.guild, config.supportCategoryId, {
        ticketNumber: getField(topic, 'number') ?? 'unknown',
        event: 'ticket_report_submitted',
        actor: interaction.user.tag,
        actorId: interaction.user.id,
        actorName: interaction.user.tag,
        detail: 'Report ' + result.report.id + ' submitted for <@' + target.id + '>; category=' + result.report.categoryName + '; subcategory=' + result.report.subcategoryName + '; ' + (flagged ? 'flagged' : 'record-only') + '.',
      }).catch(() => undefined);
    }
    await interaction.editReply(
      'Report **' + result.report.id + '** recorded for <@' + target.id + '>. Category: **' + result.report.categoryName + ' → ' + result.report.subcategoryName + '**. Mode: **' + (flagged ? 'Flag violation' : 'Record only') + '**. Current flag count: **' + result.flagCount + '**.' +
      (result.appliedRules.length ? '\\nAutomatic rules reached: ' + result.appliedRules.map((rule) => rule.action).join(', ') + '.' : ''),
    );
  } catch (error) {
    await replyError(interaction, error instanceof Error ? error.message : 'The report could not be recorded.');
  }
}

export async function executeTicketVoiceCommand(
  interaction: ChatInputCommandInteraction,
  action: 'start' | 'end' | 'join',
): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  if (action === 'start') return handleTicketVoiceStart(interaction);
  if (action === 'end') return handleTicketVoiceEnd(interaction);
  return handleTicketVoiceJoin(interaction);
}

export async function executeTicketRoutingCommand(
  interaction: ChatInputCommandInteraction,
  mode: 'department' | 'tag',
): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await replyError(interaction, 'This command must be used inside a ResolvX ticket channel.');
    return;
  }
  const channel = interaction.channel as TextChannel;
  const topic = await getEffectiveTicketTopic(channel, channel.topic ?? '');
  const status = (await getPersistedTicketStatus(channel.id)) ?? getTicketStatus(topic);
  if (!isTicketTopic(topic) || !isActiveTicketStatus(status)) {
    await replyError(interaction, 'Only active ResolvX tickets can be rerouted.');
    return;
  }
  const staff = getStaffContext(interaction, topic);
  if (!staff.authorized) {
    await replyError(interaction, 'Only configured staff or administrators can change ticket routing.');
    return;
  }
  const config = await getGuildConfig(interaction.guild.id);
  const requestedDepartmentId = interaction.options.getString('department-id');
  const requestedTagId = interaction.options.getString('tag-id');
  const currentDepartmentId = getField(topic, 'department');
  const departmentId = mode === 'department' ? requestedDepartmentId : currentDepartmentId;
  const department = departmentId ? config.departments[departmentId] : undefined;
  if (!department) {
    await replyError(interaction, mode === 'department'
      ? 'Department ID not found. Use /supportforge form list to view department IDs.'
      : 'The current ticket department could not be resolved.');
    return;
  }
  const tagId = mode === 'tag'
    ? requestedTagId
    : requestedTagId ?? (department.tags[getField(topic, 'tags') ?? ''] ? getField(topic, 'tags')! : Object.keys(department.tags)[0]);
  if (!tagId || !department.tags[tagId]) {
    await replyError(interaction, 'Tag ID is not valid for that department. Use /supportforge form list to view department and tag IDs.');
    return;
  }
  await applyTicketRouting(interaction, department, tagId, status, topic);
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
  const channel = interaction.channel as TextChannel;
  const topic = await getEffectiveTicketTopic(channel, channel.topic ?? '');
  const status = getTicketStatus(topic);
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
  const channel = interaction.channel as TextChannel;
  const topic = await getEffectiveTicketTopic(channel, channel.topic ?? '');
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

async function applyTicketRouting(interaction: StringSelectMenuInteraction | ChatInputCommandInteraction, department: DepartmentConfig, tagId: string, status: TicketStatus, topic: string): Promise<void> {
  const channel = interaction.channel as TextChannel;
  const config = await getGuildConfig(interaction.guild!.id);
  const oldDepartmentId = getField(topic, 'department');
  const oldDepartment = oldDepartmentId
    ? config.departments[oldDepartmentId]
    : undefined;
  const departmentChanged = oldDepartmentId !== department.id;
  const category = departmentChanged
    ? await ensureDepartmentCategory(interaction.guild!, department)
    : null;
  const transitionAt = new Date().toISOString();
  const newTopic = setField(
    setField(
      setField(
        setField(topic, 'department', department.id),
        'staff',
        department.staffRoleId ?? 'none',
      ),
      'tags',
      tagId,
    ),
    'updated_at',
    transitionAt,
  );

  try {
    // The database owns routing metadata. A same-department tag change is
    // intentionally message-only and must not rewrite channel topics or ACLs.
    await transitionPersistedTicket(
      channel.id,
      status,
      {
        departmentId: department.id,
        tagId,
        metadata: {
          staffRoleId: department.staffRoleId ?? 'none',
          lastActivityAt: transitionAt,
          lastStaffActivityAt: transitionAt,
        },
      },
      interactionActor(interaction),
      transitionAt,
    );

    const syncFailures: string[] = [];
    if (departmentChanged) {
      if (!category) {
        throw new Error('Destination department category could not be provisioned.');
      }

      const oldRoleId = oldDepartment?.staffRoleId;
      try {
        // Moving the channel, updating routing metadata, and changing the
        // staff ACL all target the same Modify Channel route. Submit them in
        // one request to avoid a burst of consecutive PATCHes.
        await applyTicketVisibilityMode(
          channel,
          newTopic,
          status === 'claimed' ? 'claimed' : 'unclaimed',
          getField(topic, 'claimed_by'),
          {
            topic: newTopic,
            parentId: category.id,
            removeRoleIds: oldRoleId && oldRoleId !== department.staffRoleId ? [oldRoleId] : [],
          },
        );
      } catch (error) {
        syncFailures.push('Discord category/topic/permissions');
        console.warn('⚠️ Ticket routing was saved, but channel category/topic/permission synchronization is pending/failed:', error);
      }
    }

    updateRuntimeTicketState(channel, channel.topic ?? topic, status);
    await updateMainMessage(channel, getField(newTopic, 'message'), status, newTopic);
    const destinationLabel = department.tags[tagId]?.name ?? 'tag';
    await interaction.editReply({
      content: syncFailures.length
        ? '✅ Ticket routing saved as **' + department.name + ' → ' + destinationLabel + '**. Discord synchronization is pending or needs repair: ' + syncFailures.join(', ') + '.'
        : '✅ Ticket routed to **' + department.name + ' → ' + destinationLabel + '**.',
      components: [],
    });
    if (config.supportCategoryId) await logTicketEvent(interaction.guild!, config.supportCategoryId, {
      ticketNumber: getField(newTopic, 'number') ?? 'unknown',
      event: 'ticket_routing_changed',
      actor: interaction.user.tag,
      actorId: interaction.user.id,
      actorName: interaction.user.tag,
      detail: 'Department=' + department.name + '; tag=' + destinationLabel + '.',
    });
  } catch (error) {
    console.error('❌ Ticket routing update failed:', error);
    await interaction.editReply({ content: '❌ The ticket routing update failed.', components: [] }).catch(() => undefined);
  }
}

async function changeTicketRoutingTag(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate();
  }

  const parts = interaction.customId.split(':'); const departmentId = parts[3] ?? ''; const tagId = interaction.values[0] ?? '';
  const config = await getGuildConfig(interaction.guild!.id); const department = config.departments[departmentId];
  if (!department?.tags?.[tagId]) { await replyError(interaction, '❌ That tag is not valid for this department.'); return; }
  const channel = interaction.channel as TextChannel;
  const topic = await getEffectiveTicketTopic(channel, channel.topic ?? '');
  const status = getTicketStatus(topic);
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

  if (interaction.guild && !isPremiumOrHigher(await getTier(interaction.guild.id))) {
    await interaction.editReply(
      '🔒 Ticket priority controls are available in Premium/Pro demo mode.',
    );
    return;
  }

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
  const topic = await getEffectiveTicketTopic(
    channel,
    channel.topic ?? state.topic,
  );
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

  // Load locale before committing priority, so a settings read cannot turn a
  // successful durable mutation into a misleading failure response.
  const locale = (await getAdvancedSettings(channel.guild.id)).locale;
  const transitionAt = new Date().toISOString();
  const newTopic = setField(
    setField(topic, 'priority', priority),
    'updated_at',
    transitionAt,
  );

  await transitionPersistedTicket(
    channel.id,
    status,
    {
      priority,
      metadata: {
        lastActivityAt: transitionAt,
        lastStaffActivityAt: transitionAt,
      },
    },
    interactionActor(interaction),
    transitionAt,
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

  const priorityLabel = ({
    low: '🟢 ' + translate(locale, 'priority.low'),
    normal: '🟡 ' + translate(locale, 'priority.normal'),
    high: '🟠 ' + translate(locale, 'priority.high'),
    urgent: '🔴 ' + translate(locale, 'priority.urgent'),
    critical: '🟣 ' + translate(locale, 'priority.critical'),
  } as Record<TicketPriority, string>)[priority];
  await interaction.editReply({
    content: '✅ ' + translate(locale, 'ticket.priority.changed', { priority: priorityLabel }),
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


async function handleTicketVoiceStart(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    if (interaction.isButton()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    const voiceThemeColor = getThemeColor((await getGuildConfig(interaction.guild.id)).theme);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(voiceThemeColor)
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
    await replyError(interaction, '❌ ResolvX could not start private voice mode. The ticket itself was not changed.');
  }
}

async function handleTicketVoiceEnd(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    if (interaction.isButton()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    const newTopic = await endTicketVoiceMode(interaction.guild, channel, topic, status, 'ResolvX voice mode ended');
    channel.topic = newTopic;
    await updateMainMessage(channel, getField(newTopic, 'message'), status, newTopic);
    const voiceEndThemeColor = getThemeColor((await getGuildConfig(interaction.guild.id)).theme);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(voiceEndThemeColor)
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
    await replyError(interaction, '❌ ResolvX could not end voice mode safely.');
  }
}

async function handleTicketVoiceJoin(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    if (interaction.isButton()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
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

type QuickReplyInteraction = ButtonInteraction | StringSelectMenuInteraction;

async function getQuickReplyTicketContext(interaction: QuickReplyInteraction) {
  if (!interaction.guild || !interaction.guildId || !interaction.channel || !('send' in interaction.channel)) {
    throw new Error('Quick replies require a server ticket channel or private ticket thread.');
  }
  const ticket = await getPersistedTicket(interaction.channelId);
  if (!ticket || ticket.guildId !== interaction.guildId || ticket.channelId !== interaction.channelId ||
      ticket.deletedAt || !['open', 'claimed', 'pending', 'reopened'].includes(ticket.status)) {
    throw new Error('Quick replies are available only in an active managed ticket.');
  }

  const config = await getGuildConfig(interaction.guildId);
  const member = interaction.member;
  const roleIds = !member ? [] : Array.isArray(member.roles)
    ? member.roles
    : member.roles.cache.map((role) => role.id);
  const isAdmin = Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
  );
  const department = ticket.departmentId ? config.departments[ticket.departmentId] : undefined;
  const isTicketStaff = Boolean(department?.staffRoleId && roleIds.includes(department.staffRoleId));
  if (!isAdmin && !isTicketStaff) {
    throw new Error('Only the staff role configured for this ticket department or a server administrator can send quick replies.');
  }

  return {
    guild: interaction.guild,
    channel: interaction.channel as TextChannel | ThreadChannel,
    ticket,
    config,
    access: { isAdmin, roleIds },
    department,
  };
}

async function showQuickReplySelector(
  interaction: ButtonInteraction,
  requestedPage = 0,
): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  try {
    const context = await getQuickReplyTicketContext(interaction);
    const replies = (await listQuickReplies(
      interaction.guildId!,
      context.access,
    )).filter((reply) => reply.enabled);
    if (!replies.length) {
      await interaction.editReply('No enabled quick replies are available to your role. An administrator can configure them with /supportforge quick-reply save.');
      return;
    }

    const pageSize = 25;
    const pageCount = Math.max(1, Math.ceil(replies.length / pageSize));
    const page = Number.isInteger(requestedPage)
      ? Math.max(0, Math.min(pageCount - 1, requestedPage))
      : 0;
    const options = replies.slice(page * pageSize, (page + 1) * pageSize).map((reply) => ({
      label: reply.name.slice(0, 100),
      value: reply.id,
      description: (reply.category + ' • ' + (reply.tags.join(', ') || 'no tags')).slice(0, 100),
    }));
    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket:quick-reply:select')
      .setPlaceholder('Choose a saved response')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options);
    const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ];
    if (pageCount > 1) {
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket:quick-reply:page:' + (page - 1))
          .setLabel('Previous')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId('ticket:quick-reply:page:' + (page + 1))
          .setLabel('Next')
          .setEmoji('➡️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= pageCount - 1),
      ));
    }
    await interaction.editReply({
      content:
        'Choose a quick reply to send into this ticket. Page ' + (page + 1) + ' of ' + pageCount +
        '. Text is rendered with current ticket details; automatic mentions are disabled.',
      components,
    });
  } catch (error) {
    await interaction.editReply(error instanceof Error ? error.message.slice(0, 1900) : 'Quick replies are temporarily unavailable.');
  }
}

async function handleQuickReplySelection(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!(await safeDeferReply(interaction))) return;
  try {
    const context = await getQuickReplyTicketContext(interaction);
    const quickReplyId = interaction.values[0];
    if (!quickReplyId) throw new Error('Choose one quick reply from the current list.');
    const reply = await sendQuickReplyInTicket({
      guild: context.guild,
      channel: context.channel,
      quickReplyId,
      actorId: interaction.user.id,
      actorName: interaction.user.tag,
      actorUsername: interaction.user.username,
      isAdmin: context.access.isAdmin,
      roleIds: context.access.roleIds,
    });
    await interaction.editReply('Sent quick reply "' + reply.name + '". Automatic mentions are disabled; the ticket remains open.');
  } catch (error) {
    await interaction.editReply(error instanceof Error ? error.message.slice(0, 1900) : 'Quick reply could not be sent safely.');
  }
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
          '❌ This pagination control can only be used on the ResolvX support panel.',
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

      const pageSettings = await getAdvancedSettings(interaction.guild.id);
      const pageEmbed = interaction.message.embeds[0]
        ? EmbedBuilder.from(interaction.message.embeds[0])
        : new EmbedBuilder();

      const pageLines = visibleDepartments.length
        ? visibleDepartments.map((department) => `🎫 **${department.name}**`).join('\n') +
          (pageCount > 1
            ? '\n\nPage **' + (safePage + 1) + ' / ' + pageCount + '** • Use the buttons below to browse departments.'
            : '')
        : 'No ticket departments configured.';

      pageEmbed.setColor(getThemeColor((await getGuildConfig(interaction.guild.id)).theme));
      pageEmbed.setTitle(pageSettings.appearance.panelTitle);
      pageEmbed.setFooter({ text: pageSettings.appearance.panelFooter });
      pageEmbed.setDescription(
        `Welcome to **${interaction.guild.name}** support.\n\n` +
          pageSettings.appearance.panelDescription + '\n\n' +
          pageLines + '\n\n' +
          `🔒 Tickets are visible only to the ticket owner, assigned support staff, and administrators.`,
      );

      await interaction.message.edit({
        embeds: [pageEmbed],
        components: rows,
      });
      await interaction.editReply({}).catch(() => undefined);
    } catch (error) {
      console.error('❌ Failed to change support panel page:', error);
      await replyError(interaction, '❌ ResolvX could not change the support panel page.');
    }
    return;
  }

  if (id === 'ticket:panel:voice:start') { await handleTicketVoiceStart(interaction); return; }
  if (id === 'ticket:panel:voice:end') { await handleTicketVoiceEnd(interaction); return; }
  if (id === 'ticket:panel:voice:join') { await handleTicketVoiceJoin(interaction); return; }
  if (id.startsWith('ticket:report:subcategory:page:')) {
    const parts = id.split(':');
    const targetId = parts[4] ?? '';
    const categoryId = parts[5] ?? '';
    const page = Number(parts[6] ?? '0');
    await interaction.deferUpdate();
    await renderReportSubcategorySelector(interaction, targetId, categoryId, Number.isInteger(page) ? page : 0);
    return;
  }

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

    if (!isPremiumOrHigher(await getTier(interaction.guild!.id))) {
      await interaction.editReply(
        '🔒 Ticket priority controls are available in Premium/Pro demo mode.',
      );
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
      await replyError(interaction, '❌ ' + translate((await getAdvancedSettings(interaction.guild!.id)).locale, 'errors.invalidInput'));
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
        '❌ ResolvX could not move the ticket panel.',
      );
    }

    return;
  }
  if (id === 'ticket:panel:history') {
    await showTicketHistory(interaction);
    return;
  }

  if (id === 'ticket:panel:quick-reply') {
    await showQuickReplySelector(interaction);
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
      'ticket:panel:remove-user' ||
    id ===
      'ticket:panel:reassign' ||
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
      id === 'ticket:panel:add-user' ||
      id === 'ticket:panel:remove-user' ||
      id === 'ticket:panel:reassign'
    ) {
      const removingUser = id === 'ticket:panel:remove-user';
      const reassigningUser = id === 'ticket:panel:reassign';
      modal
        .setCustomId(
          reassigningUser ? 'ticket:panel-modal:reassign' :
            removingUser ? 'ticket:panel-modal:remove-user' : 'ticket:panel-modal:add-user',
        )
        .setTitle(
          reassigningUser ? 'Reassign Ticket' :
            removingUser ? 'Remove User from Ticket' : 'Add User to Ticket',
        );

      const input = new TextInputBuilder()
        .setCustomId('user')
        .setLabel(reassigningUser ? 'New assigned staff ID or mention' : 'User ID or mention')
        .setPlaceholder('123456789012345678 or @user')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      if (reassigningUser) {
        const reason = new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason (optional)')
          .setPlaceholder('Brief reason for reassignment')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500);
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reason));
      }
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
    } else if (id === 'ticket:panel:note') {
      if (!isPremiumOrHigher(await getTier(interaction.guild!.id))) {
        await interaction.reply({
          content: '🔒 Internal notes are available in Premium/Pro demo mode.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

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
  } else {
    await replyError(
      interaction,
      '❌ This ResolvX ticket control is no longer available. Please refresh the ticket panel.',
    );
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
      '❌ This is not a valid ResolvX ticket.',
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

    if (
      id === 'ticket:panel-modal:note' &&
      !isPremiumOrHigher(await getTier(interaction.guild!.id))
    ) {
      await interaction.editReply(
        '🔒 Internal notes are available in Premium/Pro demo mode.',
      );
      return;
    }

    /* ---------------------------------------------------------------------- */
    /* Add user                                                               */
    /* ---------------------------------------------------------------------- */

    if (
      id === 'ticket:panel-modal:add-user' ||
      id === 'ticket:panel-modal:remove-user' ||
      id === 'ticket:panel-modal:reassign'
    ) {
      const removingUser = id === 'ticket:panel-modal:remove-user';
      const reassigningUser = id === 'ticket:panel-modal:reassign';
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

      if (reassigningUser) {
        if (state.status === 'pending') {
          await interaction.editReply('❌ Resume this ticket before reassigning it.');
          return;
        }
        if (!['open', 'claimed', 'reopened'].includes(state.status)) {
          await interaction.editReply('❌ Only an open or claimed ticket can be reassigned.');
          return;
        }

        const staffRoleId = getField(state.topic, 'staff');
        if (!staffRoleId || staffRoleId === 'none') {
          await interaction.editReply('❌ This ticket has no configured department staff role, so reassignment cannot be validated safely.');
          return;
        }
        const targetMember = await channel.guild.members.fetch(userId).catch(() => null);
        if (!targetMember) {
          await interaction.editReply('❌ That user could not be found in this server.');
          return;
        }
        if (!targetMember.roles.cache.has(staffRoleId)) {
          await interaction.editReply('❌ That user is not part of this ticket department’s staff role.');
          return;
        }
        const currentAssignees = (getField(state.topic, 'claimed_by') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
        if (currentAssignees.length === 1 && currentAssignees[0] === userId) {
          await interaction.editReply('ℹ️ This ticket is already assigned to that staff member.');
          return;
        }

        const now = new Date().toISOString();
        let reassignedTopic = setField(setField(setField(state.topic, 'status', 'claimed'), 'claimed_by', userId), 'claimed_at', now);
        reassignedTopic = setField(reassignedTopic, 'assigned_at', now);
        reassignedTopic = setField(reassignedTopic, 'updated_at', now);
        if (currentAssignees.length) {
          reassignedTopic = setField(reassignedTopic, 'previous_assignee', currentAssignees.join(','));
        } else {
          reassignedTopic = removeField(reassignedTopic, 'previous_assignee');
        }
        reassignedTopic = removeField(reassignedTopic, 'pending_since');

        await transitionPersistedTicket(
          channel.id,
          'claimed',
          {
            claimedByIds: [userId],
            metadata: { lastActivityAt: now, lastStaffActivityAt: now },
          },
          interactionActor(interaction),
          now,
        );
        try {
          await applyTicketVisibilityMode(channel, reassignedTopic, 'claimed', userId, { topic: reassignedTopic });
        } catch (error) {
          console.warn('Ticket reassignment was saved durably, but Discord permissions/topic synchronization is pending:', error);
        }
        channel.topic = reassignedTopic;
        updateRuntimeTicketState(channel, reassignedTopic, 'claimed');
        await updateMainMessage(channel, getField(reassignedTopic, 'message'), 'claimed', reassignedTopic);

        const reason = interaction.fields.getTextInputValue('reason').trim();
        const before = currentAssignees.length ? currentAssignees.map((id) => '<@' + id + '>').join(', ') : 'unassigned';
        await channel.send('🔄 Ticket #' + (getField(reassignedTopic, 'number') ?? 'unknown') +
          ' was reassigned from ' + before + ' to <@' + userId + '> by ' + interaction.user.tag +
          (reason ? '\nReason: ' + reason : ''));

        const config = await getGuildConfig(channel.guild.id);
        if (config.supportCategoryId) {
          await logTicketEvent(channel.guild, config.supportCategoryId, {
            ticketNumber: getField(reassignedTopic, 'number') ?? 'unknown',
            event: 'ticket_reassigned',
            actor: interaction.user.tag,
            actorId: interaction.user.id,
            actorName: interaction.user.tag,
            detail: 'Reassigned ticket to <@' + userId + '>.' + (reason ? ' Reason: ' + reason : ''),
          });
        }
        await interaction.editReply('✅ Ticket was reassigned to <@' + userId + '>.');
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

      const ticketOwnerId = getField(state.topic, 'owner');
      if (removingUser && userId === ticketOwnerId) {
        await interaction.editReply('❌ You cannot remove the ticket owner.');
        return;
      }

      const alreadyOnTicket = users.includes(userId);
      if (removingUser && !alreadyOnTicket) {
        await interaction.editReply('ℹ️ That user is not explicitly added to this ticket.');
        return;
      }
      if (!removingUser && alreadyOnTicket) {
        await interaction.editReply('ℹ️ That user is already on this ticket.');
        return;
      }

      const nextUsers = removingUser
        ? users.filter((id) => id !== userId)
        : [...users, userId];

      const transitionAt = new Date().toISOString();
      newTopic = setField(
        setField(newTopic, 'users', nextUsers.join(',')),
        'updated_at',
        transitionAt,
      );

      const ownerId = getField(newTopic, 'owner');
      await transitionPersistedTicket(
        channel.id,
        state.status,
        {
          participantIds: [...new Set([...(ownerId ? [ownerId] : []), ...nextUsers])],
          metadata: {
            lastActivityAt: transitionAt,
            lastStaffActivityAt: transitionAt,
          },
        },
        interactionActor(interaction),
        transitionAt,
      );

      try {
        await applyTicketVisibilityMode(
          channel,
          newTopic,
          state.status === 'claimed' ? 'claimed' : 'unclaimed',
          getField(state.topic, 'claimed_by'),
          { topic: newTopic },
        );
      } catch (error) {
        console.warn(
          'Ticket participant was saved durably, but Discord topic/permission synchronization is pending:',
          error,
        );
      }

      channel.topic = newTopic;
      updateRuntimeTicketState(channel, newTopic, state.status);

      await interaction.editReply(
        removingUser
          ? `✅ <@${userId}> has been removed from the ticket.`
          : `✅ <@${userId}> has been added to the ticket.`,
      );

      const userConfig = await getGuildConfig(channel.guild.id);
      if (userConfig.supportCategoryId) {
        await logTicketEvent(
          channel.guild,
          userConfig.supportCategoryId,
          {
            ticketNumber: getField(channel.topic ?? '', 'number') ?? 'unknown',
            event: removingUser ? 'ticket_user_removed' : 'ticket_user_added',
            actor: interaction.user.tag,
            actorId: interaction.user.id,
            actorName: interaction.user.tag,
            detail: (removingUser ? 'Removed user <@' : 'Added user <@') + userId + '> from the ticket.',
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

      const noteThemeColor = getThemeColor((await getGuildConfig(channel.guild.id)).theme);
      await channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(noteThemeColor)
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
        });

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
/* Published custom-panel routing                                              */
/* -------------------------------------------------------------------------- */

function interactionRoleIds(interaction: ButtonInteraction): Set<string> {
  const member = interaction.member;
  if (!member || !('roles' in member)) return new Set();
  const roles = member.roles;
  if (Array.isArray(roles)) return new Set(roles);
  if ('cache' in roles) return new Set(roles.cache.keys());
  return new Set();
}

function hasRequiredPanelAccess(
  interaction: ButtonInteraction,
  panelRoleIds: string[],
  buttonRoleIds: string[],
): boolean {
  if (
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) return true;
  const roles = interactionRoleIds(interaction);
  const panelAllows = panelRoleIds.length === 0 || panelRoleIds.some((roleId) => roles.has(roleId));
  const buttonAllows = buttonRoleIds.length === 0 || buttonRoleIds.some((roleId) => roles.has(roleId));
  return panelAllows && buttonAllows;
}

async function startCustomPanelTarget(
  interaction: ButtonInteraction,
  button: CustomSupportPanelButton,
  panelId?: string,
): Promise<void> {
  if (!interaction.guild) {
    await replyError(interaction, 'This support panel can only be used inside a server.');
    return;
  }

  if (button.targetType === 'form') {
    if (!button.formId || !button.formVersion || !button.tagId) {
      await replyError(interaction, 'This form button is incomplete. Ask an administrator to repair and republish the panel.');
      return;
    }
    const cached = getCachedActiveTicketFormById(
      interaction.guild.id,
      button.formId,
      button.formVersion,
      button.tagId,
    );
    if (!cached.ready) {
      await replyError(interaction, 'Ticket forms are still loading. Please try again in a moment.');
      return;
    }
    if (!cached.form) {
      await replyError(interaction, 'This panel points to a form version that was changed or deactivated. Ask an administrator to edit and republish the panel.');
      return;
    }
    if (!(await ensureSupportHoursAllows(interaction, interaction.guild.id, button.departmentId, panelId))) return;
    const expiresAt = Date.now() + TICKET_FORM_MODAL_TTL_MS;
    const sessionId = randomBytes(10).toString('base64url');
    await interaction.showModal(
      buildTicketFormModal(cached.form, button.tagId, expiresAt, sessionId, 1, {}, panelId),
    );
    return;
  }

  if (!button.departmentId) {
    await replyError(interaction, 'This panel button has no department target. Ask an administrator to repair the panel.');
    return;
  }
  if (button.tagId) {
    await showTicketCreationModal(interaction, button.departmentId, button.tagId, panelId);
  } else {
    await showTicketTagSelector(interaction, button.departmentId, 0, panelId);
  }
}

async function handleCustomPanelEntry(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) {
    await replyError(interaction, 'Custom support panels only work inside a server.');
    return;
  }

  const parsed = parseCustomPanelInteractionId(interaction.customId);
  if (!parsed) {
    await replyError(interaction, 'This panel button is malformed or outdated. Refresh the support panel and try again.');
    return;
  }
  const { action, panelId, buttonId, sourceMessageId, promptOwnerId } = parsed;
  const isConfirm = action === 'confirm';
  const isCancel = action === 'cancel';

  // Confirmation controls live on an ephemeral response, not the public panel.
  // They are valid only for the initiating user and currently published source.
  if (isConfirm || isCancel) {
    if (
      interaction.user.id !== promptOwnerId ||
      !interaction.message.flags.has(MessageFlags.Ephemeral)
    ) {
      await replyError(interaction, 'This confirmation belongs to another user or is not a valid private prompt.');
      return;
    }
  }

  // Cancellation is non-destructive and should remain available even if the
  // panel was unpublished or the user's role changed while the prompt was open.
  if (isCancel) {
    await interaction.update({
      content: 'Ticket request cancelled. No ticket was created.',
      embeds: [],
      components: [],
    }).catch(() => undefined);
    return;
  }

  const panel = await getCustomPanel(interaction.guild.id, panelId);
  if (!panel || !panel.publishedConfig || !panel.publishedMessageId || !panel.publishedChannelId) {
    await replyError(interaction, 'This panel is no longer published. Ask an administrator to publish the current draft.');
    return;
  }
  const livePanel = panel.publishedConfig;
  const sourceIsCurrent = isConfirm || isCancel
    ? sourceMessageId === panel.publishedMessageId
    : interaction.message.id === panel.publishedMessageId;
  if (!sourceIsCurrent || interaction.channelId !== panel.publishedChannelId) {
    await replyError(interaction, 'This is an old or copied panel button. Use the current published support panel instead.');
    return;
  }

  const button = livePanel.buttons.find((candidate) => candidate.id === buttonId);
  if (!button) {
    await replyError(interaction, 'This button belongs to an older panel revision. The administrator must republish the current panel.');
    return;
  }
  if (!hasRequiredPanelAccess(interaction, livePanel.allowedRoleIds ?? [], button.allowedRoleIds ?? [])) {
    await replyError(interaction, 'You do not have a role allowed to use this support-panel option.');
    return;
  }
  if (!(await ensureSupportHoursAllows(interaction, interaction.guild.id, button.departmentId, panelId))) return;

  if (!isConfirm && button.confirmationMessage) {
    const confirmation = new EmbedBuilder()
      .setColor(getThemeColor((await getGuildConfig(interaction.guild.id)).theme))
      .setTitle('Confirm support request')
      .setDescription(button.confirmationMessage.slice(0, 4096))
      .setFooter({ text: 'ResolvX • No ticket is created until you confirm' });
    const confirmationPrefix = 'ticket:custom:';
    await interaction.reply({
      embeds: [confirmation],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(confirmationPrefix + 'confirm:' + panelId + ':' + buttonId + ':' + panel.publishedMessageId + ':' + interaction.user.id)
            .setLabel('Continue')
            .setEmoji('🎫')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(confirmationPrefix + 'cancel:' + panelId + ':' + buttonId + ':' + panel.publishedMessageId + ':' + interaction.user.id)
            .setLabel('Cancel')
            .setEmoji('↩️')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    // A confirm click is accepted only after the private prompt owner, source
    // public message, published snapshot, role restrictions and target have
    // all been revalidated. The action then reuses the normal ticket flow.
    await startCustomPanelTarget(interaction, button, panelId);
  } catch (error) {
    console.error('Custom support-panel route failed:', error);
    await replyError(interaction, 'ResolvX could not open this ticket request. Please try again or use another support-panel option.');
  }
}

/* -------------------------------------------------------------------------- */
/* Main interaction router                                                    */
/* -------------------------------------------------------------------------- */

export async function executeTicketLifecycleCommand(
  interaction: ChatInputCommandInteraction,
  action: 'close' | 'reopen',
): Promise<void> {
  // Slash commands execute the lifecycle transition directly. They must not
  // depend on a second interaction with a panel button to finish the action.
  if (action === 'close') {
    await closeTicket(interaction);
    return;
  }
  await transition(interaction, 'reopened');
}


async function handleTicketDeletionInteraction(interaction: ButtonInteraction): Promise<void> {
  const confirmationAction =
    interaction.customId === 'ticket:delete:confirm-one' ||
    interaction.customId === 'ticket:delete:confirm-two' ||
    interaction.customId === 'ticket:delete:cancel';
  if (confirmationAction) {
    // Update the existing ephemeral confirmation instead of creating another
    // reply. This disables stale confirmation buttons and prevents duplicate
    // destructive operations from old copies of the same prompt.
    try {
      await interaction.deferUpdate();
    } catch (error) {
      console.warn('Could not acknowledge ticket deletion confirmation:', error);
      return;
    }
  } else if (!(await safeDeferReply(interaction))) {
    return;
  }
  if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
    await interaction.editReply('This deletion control only works inside a ticket channel.');
    return;
  }

  const channel = interaction.channel as TextChannel;
  const topic = channel.topic ?? '';
  if (!isTicketTopic(topic)) {
    await interaction.editReply('This channel is not a managed ResolvX ticket.');
    return;
  }

  const config = await getGuildConfig(interaction.guild.id);
  const ticket = await getPersistedTicket(channel.id);
  const departmentId = ticket?.departmentId ?? getField(topic, 'department') ?? '';
  const department = config.departments[departmentId];
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const isStaff = Boolean(member && department?.staffRoleId && member.roles.cache.has(department.staffRoleId));
  const canDelete = canPerformTicketAction({
    actorId: interaction.user.id,
    ownerId: ticket?.ownerId ?? getField(topic, 'owner'),
    isConfiguredStaff: isStaff,
    isAdministrator: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)),
    canManageGuild: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)),
    canManageChannels: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)),
  }, 'delete', ticket?.status ?? getTicketStatus(topic));
  if (!canDelete) {
    await interaction.editReply('Only configured department staff or administrators with Manage Channels can delete this ticket.');
    return;
  }

  const color = getThemeColor(config.theme);
  const cancel = new ButtonBuilder()
    .setCustomId('ticket:delete:cancel')
    .setLabel('Cancel')
    .setEmoji('↩️')
    .setStyle(ButtonStyle.Secondary);

  if (interaction.customId === 'ticket:delete:cancel') {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(color).setTitle('Ticket deletion cancelled').setDescription('The ticket channel and its archived messages were left unchanged.')],
      components: [],
    });
    return;
  }

  if (interaction.customId === 'ticket:delete:start') {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(color)
          .setTitle('⚠️ Confirm ticket deletion · Step 1 of 2')
          .setDescription(
            'You are about to delete **#' + (ticket?.ticketNumber ?? getField(topic, 'number') ?? 'unknown') +
            '**. ResolvX will archive the available conversation and then delete this channel. This action removes the current channel URL and cannot be undone in place.',
          )
          .setFooter({ text: 'ResolvX • Two-step deletion protection' }),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('ticket:delete:confirm-one').setLabel('Confirm step 1 of 2').setEmoji('⚠️').setStyle(ButtonStyle.Danger),
          cancel,
        ),
      ],
    });
    return;
  }

  if (interaction.customId === 'ticket:delete:confirm-one') {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(color)
          .setTitle('🚨 Final confirmation · Step 2 of 2')
          .setDescription(
            'This is the second confirmation. ResolvX will finish archiving the ticket history before deleting the channel. If archival fails, deletion will be cancelled. A separate deletion-review record will be created.',
          )
          .setFooter({ text: 'ResolvX • Final confirmation required' }),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('ticket:delete:confirm-two').setLabel('Delete ticket permanently').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
          cancel,
        ),
      ],
    });
    return;
  }

  if (interaction.customId !== 'ticket:delete:confirm-two') {
    await interaction.editReply('This deletion confirmation is no longer recognized. Reopen the ticket panel and start again.');
    return;
  }

  let intentRecorded = false;
  let channelDeleted = false;
  try {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(color)
          .setTitle('📦 Preparing ticket archive')
          .setDescription('ResolvX is saving message history, edits, attachment metadata and accessible attachment files before deletion. The channel will remain if archival cannot finish.')
          .setFooter({ text: 'ResolvX • Durable recovery' }),
      ],
      components: [],
    });

    await archiveTicketChannelForRecovery(channel);

    const supportCategoryId = config.supportCategoryId;
    const ticketNumber = ticket?.ticketNumber ?? getField(topic, 'number') ?? 'unknown';
    if (supportCategoryId) {
      // Write the audit trail before deletion. The durable pending intent is
      // then created immediately before the Discord delete request so a stale
      // intent is less likely to misclassify a later native deletion.
      await ensureAuditDeveloperInfrastructure(interaction.guild, supportCategoryId);
      await logTicketEvent(interaction.guild, supportCategoryId, {
        ticketNumber,
        ticketChannelId: channel.id,
        event: 'TICKET_DELETE_BUTTON_CONFIRMED',
        actor: interaction.user.tag,
        actorId: interaction.user.id,
        actorName: interaction.user.tag,
        detail: 'Ticket deletion completed the two-confirmation flow. A separate Settings review will ask whether this deletion was a mistake.',
      });
      await logSystemEvent(
        interaction.guild,
        supportCategoryId,
        'TICKET_DELETE_BUTTON_CONFIRMED',
        'Ticket #' + ticketNumber + ' deletion initiated through the ticket button by ' + interaction.user.tag + ' (' + interaction.user.id + '). Confirmation count: 2. Channel ID: ' + channel.id,
      );
    }

    // Neon intent is durable before the destructive Discord API call.
    await beginTicketButtonDeletion(channel, interaction.user.id, interaction.user.tag);
    intentRecorded = true;
    await channel.delete('ResolvX ticket Delete button; actor ' + interaction.user.id + '; two confirmations completed');
    channelDeleted = true;
  } catch (error) {
    if (intentRecorded && !channelDeleted) {
      await cancelTicketButtonDeletion(channel.id).catch(() => undefined);
    }
    const detail = error instanceof Error ? error.message : 'Unknown deletion error.';
    console.error('ResolvX ticket-button deletion failed:', error);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(color)
          .setTitle('❌ Ticket deletion did not complete')
          .setDescription(detail.slice(0, 3500) + '\n\nThe ticket channel was not intentionally deleted by ResolvX. Check the archive and bot permissions before retrying.')
          .setFooter({ text: 'ResolvX • Database and channel state are preserved where possible' }),
      ],
      components: [],
    }).catch(() => undefined);
    return;
  }

  // The delete endpoint has succeeded. A missing interaction response must not
  // retroactively misreport a successful deletion as a failed operation.
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(color)
        .setTitle('✅ Ticket channel deleted')
        .setDescription('The channel was deleted after the durable archive step. Open **Settings → Repair System → Ticket Deletion Review** to answer “Was this ticket deleted by mistake?” The original channel ID and recovered-message attribution remain in the archive.')
        .setFooter({ text: 'ResolvX • The replacement channel will have a new ID and URL if restored.' }),
    ],
    components: [],
  }).catch((error) => {
    console.warn('Ticket channel deletion succeeded, but the ephemeral confirmation could not be edited:', error instanceof Error ? error.message : 'unknown interaction response failure');
  });
}

export async function handleTicketInteraction(
  interaction:
    | ButtonInteraction
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction
    | ModalSubmitInteraction,
): Promise<void> {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('ticket:quick-reply:page:')) {
      const rawPage = interaction.customId.slice('ticket:quick-reply:page:'.length);
      const page = Number(rawPage);
      if (!/^\\d{1,3}$/.test(rawPage) || !Number.isInteger(page) || page < 0 || page > 999) {
        if (await safeDeferReply(interaction)) {
          await interaction.editReply('This quick-reply page control is invalid. Reopen Quick Reply from the ticket panel.');
        }
        return;
      }
      await showQuickReplySelector(interaction, page);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('sf:kb:share:')) {
      if (!(await safeDeferReply(interaction))) return;
      const parts = interaction.customId.split(':');
      const articleId = parts[3] ?? '';
      const targetChannelId = parts[4] ?? '';
      if (!interaction.guildId || !interaction.guild || !articleId || !targetChannelId ||
          interaction.channelId !== targetChannelId) {
        await interaction.editReply('This article-share control is no longer valid in this ticket. Run /supportforge knowledge suggest again.');
        return;
      }

      const ticket = await getPersistedTicket(targetChannelId);
      if (!ticket || ticket.guildId !== interaction.guildId || ticket.channelId !== targetChannelId ||
          ticket.deletedAt || !['open', 'claimed', 'pending', 'reopened'].includes(ticket.status)) {
        await interaction.editReply('This ticket is no longer active. No article was shared.');
        return;
      }

      const config = await getGuildConfig(interaction.guildId);
      const member = interaction.member;
      const roleIds = !member ? [] : Array.isArray(member.roles)
        ? member.roles
        : member.roles.cache.map((role) => role.id);
      const isAdmin = Boolean(
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
      );
      const department = ticket.departmentId ? config.departments[ticket.departmentId] : undefined;
      const isTicketStaff = Boolean(department?.staffRoleId && roleIds.includes(department.staffRoleId));
      if (!isAdmin && !isTicketStaff) {
        await interaction.editReply('You need the staff role configured for this ticket department to share an article.');
        return;
      }

      const access = { isAdmin, isStaff: isAdmin || isTicketStaff, roleIds };
      const article = await getKnowledgeArticle(interaction.guildId, articleId, access);
      if (!article || article.status !== 'published') {
        await interaction.editReply('This published article is no longer available to your role. No content was shared.');
        return;
      }

      const summary = article.summary.slice(0, 500);
      const excerpt = article.body.slice(0, 2200);
      const truncated = article.body.length > excerpt.length;
      const targetChannel = interaction.channel;
      if (!targetChannel || !('send' in targetChannel)) {
        await interaction.editReply('This ticket channel is not available for sharing. No article was posted.');
        return;
      }
      const shareChannel = targetChannel as TextChannel | ThreadChannel;
      const shareDescription = [
        summary,
        '**Category:** ' + article.category,
        '**Tags:** ' + (article.tags.join(', ') || 'none'),
        excerpt,
        ...(truncated ? ['Open /supportforge knowledge view with article ID ' + article.id + ' for the full article.'] : []),
        '_This is a suggested resource, not a replacement for human support. The ticket remains open for follow-up._',
      ].filter(Boolean).join('\n\n').slice(0, 3900);
      await shareChannel.send({
        embeds: [new EmbedBuilder().setTitle('📚 Suggested article: ' + article.title)
          .setDescription(shareDescription)
          .setFooter({ text: 'Knowledge Base article ' + article.id + ' • revision ' + article.revision })],
        allowedMentions: { parse: [] },
      });
      try {
        await recordKnowledgeArticleShare(interaction.guildId, article.id, access, interaction.user.id);
      } catch {
        console.warn('Knowledge Base article was shared, but its usage metric could not be recorded.');
      }
      if (config.supportCategoryId) {
        try {
        await logTicketEvent(interaction.guild, config.supportCategoryId, {
          ticketNumber: ticket.ticketNumber ?? ticket.id,
          ticketChannelId: ticket.channelId,
          event: 'KNOWLEDGE_ARTICLE_SHARED',
          actorId: interaction.user.id,
          actor: interaction.user.tag,
          actorName: interaction.user.tag,
          detail: 'Shared published Knowledge Base article ' + article.id + ' revision ' + article.revision + ' via a ticket suggestion control.',
        });
        } catch {
          console.warn('Knowledge Base article was shared, but its ticket audit notification failed.');
        }
      }
      await interaction.editReply('Shared "' + article.title + '" in this ticket. Automatic mentions are disabled; the ticket remains open.');
      return;
    }

    if (interaction.customId.startsWith('ticket:thread:')) {
      if (interaction.isButton() && interaction.customId.startsWith('ticket:thread:quick-reply:')) {
        const targetThreadId = interaction.customId.split(':')[3] ?? '';
        if (!targetThreadId || targetThreadId !== interaction.channelId) {
          if (await safeDeferReply(interaction)) {
            await interaction.editReply('This quick-reply control no longer matches the current ticket thread.');
          }
          return;
        }
        await showQuickReplySelector(interaction);
        return;
      }
      if (interaction.isButton()) {
        const handled = await handlePrivateThreadAuxButton(interaction);
        if (!handled) await handlePrivateThreadTicketButton(interaction);
      } else {
        await handlePrivateThreadAuxComponent(interaction);
      }
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('ticket:delete:')) {
      await handleTicketDeletionInteraction(interaction);
      return;
    }
    const routingComponentRoute = classifyTicketRoutingComponent(interaction.customId);
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
      if (interaction.customId === 'ticket:quick-reply:select') {
        await handleQuickReplySelection(interaction);
        return;
      }
      if (routingComponentRoute === 'department-select') {
        await changeTicketDepartment(interaction);
        return;
      }
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
      if (interaction.customId.startsWith('ticket:create-tag:select:')) {
        await handleTicketTagSelection(interaction);
        return;
      }
      if (routingComponentRoute === 'routing-tag-select') {
        await changeTicketRoutingTag(interaction);
        return;
      }
    }

    if (
      interaction.isButton() &&
      (routingComponentRoute === 'department-navigation' ||
       routingComponentRoute === 'routing-tag-navigation')
    ) {
      await handlePanelButton(interaction);
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith('ticket:create-tag:page:')
    ) {
      const parts = interaction.customId.split(':');
      const departmentId = parts[3] ?? '';
      const page = Number(parts[4] ?? '0');
      const panelId = parts[5] || undefined;

      await showTicketTagSelector(
        interaction,
        departmentId,
        Number.isInteger(page) ? page : 0,
        panelId,
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

    if (interaction.isButton() && interaction.customId.startsWith('tf:')) {
      await handleTicketFormWizardContinue(interaction);
      return;
    }

    if (
      interaction.isButton()
    ) {
      // Custom-panel buttons bind to immutable published snapshots. This keeps
      // unpublished edits from changing the meaning of buttons already visible
      // to customers.
      if (interaction.customId.startsWith('ticket:custom:')) {
        await handleCustomPanelEntry(interaction);
        return;
      }

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
        `⚠️ Unhandled ResolvX button: ${interaction.customId}`,
      );

      await replyError(
        interaction,
        '❌ This ResolvX button is no longer available. Please refresh the panel.',
      );

      return;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith('tf:')
    ) {
      await handleTicketFormWizardModal(interaction);
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

        const panelId = parts[4] === 'panel' ? parts[5] : undefined;
        const formId = parts[4] === 'panel' ? undefined : parts[4];
        const version = Number(parts[5]);
        const expiresAt = Number(parts[6]);
        const formRoute = formId
          ? Number.isInteger(version) && version > 0 && Number.isFinite(expiresAt)
            ? { formId, version, expiresAt }
            : undefined
          : undefined;

        if (formId && !formRoute) {
          await replyError(
            interaction,
            '❌ This form submission link is malformed. Reopen the support panel.',
          );
          return;
        }

        await createTicket(
          interaction,
          departmentId,
          tagId,
          formRoute,
          undefined,
          false,
          panelId,
        );

        return;
      }

      if (interaction.customId.startsWith('ticket:report:modal:')) {
        await handleReportModal(interaction);
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
        `⚠️ Unhandled ResolvX modal: ${interaction.customId}`,
      );

      await replyError(
        interaction,
        '❌ This ResolvX form is no longer available. Please try again.',
      );

      return;
    }
  } catch (error) {
    console.error(
      '❌ Unhandled ResolvX interaction error:',
      error,
    );

    await replyError(
      interaction,
      '❌ ResolvX encountered an unexpected error while processing this action.',
    );
  }
}