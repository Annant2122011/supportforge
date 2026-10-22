
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type Guild,
  type TextChannel,
} from 'discord.js';

import {
  getGuildConfig,
  registerManagedCategory,
  getTier,
  newDepartmentId,
  newTagId,
  setTier,
  tierLabel,
  updateGuildConfig,
  type DepartmentConfig,
  type SupportForgeTier,
} from '../services/configService';

import { executeTicketCommand } from '../interactions/ticketCommandTools';
import { getPersistedTicketStatus } from '../services/ticketPersistenceService';
import { UI_THEMES, getThemeColor } from '../services/uiThemeService';
import { LOCALE_OPTIONS } from '../i18n/localeRegistry';
import { handleSettingsSlashCommand } from '../interactions/settingsCommandTools';
import {
  applyTicketFormTemplate,
  buildQuickTicketFormFields,
  createTicketForm,
  createTicketFormTemplate,
  deleteTicketFormTemplate,
  listTicketFormTemplates,
  listTicketForms,
  parseTicketFormFields,
  setTicketFormActive,
  updateTicketFormFields,
} from '../services/ticketFormService';

import {
  getAdvancedSettings,
  updateAdvancedSettings,
  type TicketPriority,
} from '../services/advancedSettingsService';

import {
  ensureArchiveCategory,
  ensureClosedCategory,
  ensureOpenCategory,
  ensureOptionalStatusCategory,
} from '../services/ticketStorageService';

import {
  ensureAllDepartmentCategories,
} from '../services/departmentCategoryService';

import { ensureAuditDeveloperInfrastructure, getOrCreateAuditChannel, logSettingsEvent, logSystemEvent, handleAuditSlashCommand } from '../services/auditLogService';
import { performFactoryReset } from '../services/factoryResetService';
import { recoverMissingTicketRecords } from '../services/ticketRecoveryService';
import { addUseCasePreset } from '../services/useCasePresetService';
import { moveTicketPanelToBottom } from '../services/ticketPanelService';
import {
  buildCustomPanelComponents,
  buildCustomPanelEmbed,
  createCustomPanel,
  deleteCustomPanelDefinition,
  getCustomPanel,
  listCustomPanels,
  markCustomPanelPublished,
  restoreCustomPanelPublication,
  updateCustomPanel,
} from '../services/panelBuilderService';
import { requestGitHubDeployment } from '../services/updateService';

import {
  ensureSettingsChannel,
  refreshSettingsChannel,
} from '../services/settingsChannelService';
import {
  ensureChannelPurposeMessage,
  ensureSupportForgeCategoryPurposeMessages,
} from '../services/channelPurposeService';

import {
  getField,
  getTicketStatus,
} from '../services/ticketStateService';

const SUPPORT_CATEGORY_NAME = 'Support Forge';
const PANEL_CHANNEL_NAME = 'support-panel';
const PANEL_TOPIC = 'supportforge:panel';
const TRANSCRIPT_NAME = '📄 support-transcripts';
const TRANSCRIPT_TOPIC = 'supportforge:transcript';
const TICKET_PREFIX = 'supportforge:ticket';

type ManagedChannelOverwrite = {
  id: string;
  type: 0 | 1;
  allow: bigint[];
  deny: bigint[];
};

function permissionsToBitfield(values: readonly bigint[]): bigint {
  return values.reduce((combined, value) => combined | value, 0n);
}

function overwriteSetMatches(
  channel: CategoryChannel | TextChannel,
  expected: ManagedChannelOverwrite[],
): boolean {
  if (channel.permissionOverwrites.cache.size !== expected.length) return false;
  return expected.every((entry) => {
    const current = channel.permissionOverwrites.cache.get(entry.id);
    return Boolean(
      current &&
      current.type === entry.type &&
      current.allow.bitfield === permissionsToBitfield(entry.allow) &&
      current.deny.bitfield === permissionsToBitfield(entry.deny),
    );
  });
}

async function reconcileManagedTextChannel(
  channel: TextChannel,
  parentId: string,
  topic: string,
  expectedOverwrites: ManagedChannelOverwrite[],
  reason: string,
): Promise<void> {
  const changes: {
    parent?: string;
    lockPermissions?: false;
    topic?: string;
    permissionOverwrites?: ManagedChannelOverwrite[];
    reason: string;
  } = { reason };

  if (channel.parentId !== parentId) {
    changes.parent = parentId;
    changes.lockPermissions = false;
  }
  if (channel.topic !== topic) changes.topic = topic;
  if (!overwriteSetMatches(channel, expectedOverwrites)) {
    changes.permissionOverwrites = expectedOverwrites;
  }

  // Parent, topic and ACL all use PATCH /channels/{id}. Send one combined
  // request only when there is an actual difference to repair.
  if (Object.keys(changes).some((key) => key !== 'reason')) {
    await channel.edit(changes);
  }
}

function transcriptChannelOverwrites(
  guild: Guild,
  botId: string,
  staffRoleIds: string[],
): ManagedChannelOverwrite[] {
  return [
    {
      id: guild.roles.everyone.id,
      type: 0,
      allow: [],
      deny: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: botId,
      type: 1,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
      deny: [],
    },
    ...staffRoleIds.map((id) => ({
      id,
      type: 0 as const,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      deny: [PermissionFlagsBits.SendMessages],
    })),
  ];
}

function panelChannelOverwrites(
  guild: Guild,
  botId: string,
): ManagedChannelOverwrite[] {
  return [
    {
      id: guild.roles.everyone.id,
      type: 0,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ],
      deny: [PermissionFlagsBits.SendMessages],
    },
    {
      id: botId,
      type: 1,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
      ],
      deny: [],
    },
  ];
}

function containerOverwriteMatches(
  channel: CategoryChannel,
  overwriteId: string,
  allow: readonly bigint[],
  deny: readonly bigint[],
): boolean {
  const current = channel.permissionOverwrites.cache.get(overwriteId);
  return Boolean(
    current &&
    allow.every((permission) => current.allow.has(permission) && !current.deny.has(permission)) &&
    deny.every((permission) => current.deny.has(permission) && !current.allow.has(permission)),
  );
}

function isActiveTicketStatus(
  status: ReturnType<typeof getTicketStatus>,
): boolean {
  return (
    status === 'open' ||
    status === 'claimed' ||
    status === 'pending' ||
    status === 'reopened'
  );
}

function isAdminLike(
  interaction: ChatInputCommandInteraction,
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

function categoryButton(
  departmentId: string,
  label: string,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`ticket:create:${departmentId}`)
    .setLabel(label.slice(0, 80))
    .setEmoji('🎫')
    .setStyle(ButtonStyle.Primary);
}

export async function buildPanelEmbed(
  guild: Guild,
  departments: DepartmentConfig[],
  page = 0,
): Promise<EmbedBuilder> {
  const settings = await getAdvancedSettings(guild.id);
  const config = await getGuildConfig(guild.id);
  const departmentsPerPage = departments.length > 20 ? 20 : 25;
  const pageCount = Math.max(1, Math.ceil(departments.length / departmentsPerPage));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visibleDepartments = departments.slice(
    safePage * departmentsPerPage,
    (safePage + 1) * departmentsPerPage,
  );

  const lines = departments.length
    ? visibleDepartments.map((department) => `🎫 **${department.name}**`).join('\n') +
      (pageCount > 1
        ? '\n\nPage **' + (safePage + 1) + ' / ' + pageCount + '** • Use the buttons below to browse departments.'
        : '')
    : 'No ticket departments configured.';

  return new EmbedBuilder()
    .setColor(getThemeColor(config.theme))
    .setTitle(settings.appearance.panelTitle)
    .setDescription(
      `Welcome to **${guild.name}** support.\n\n` +
        settings.appearance.panelDescription + '\n\n' +
        `${lines}\n\n` +
        `🔒 Tickets are visible only to the ticket owner, assigned support staff, and administrators.`,
    )
    .setFooter({ text: settings.appearance.panelFooter })
    .setTimestamp();
}

async function ensureContainer(guild: Guild) {
  const saved = await getGuildConfig(guild.id);

  const bot = guild.members.me;

  if (!bot) {
    throw new Error(
      'ResolvX bot member could not be resolved.',
    );
  }

  if (saved.supportCategoryId) {
    const channel = guild.channels.cache.get(
      saved.supportCategoryId,
    );

    if (
      channel?.type ===
      ChannelType.GuildCategory
    ) {
      const everyoneAllow = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ];
      const everyoneDeny = [PermissionFlagsBits.SendMessages];
      const botAllow = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ];
      if (!containerOverwriteMatches(channel, guild.roles.everyone.id, everyoneAllow, everyoneDeny)) {
        await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: false,
        }, { reason: 'Repair ResolvX container permissions' });
      }
      if (!containerOverwriteMatches(channel, bot.id, botAllow, [])) {
        await channel.permissionOverwrites.edit(bot.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          ManageChannels: true,
          ManageMessages: true,
          EmbedLinks: true,
          AttachFiles: true,
        }, { reason: 'Allow ResolvX to manage its container' });
      }
      return channel;
    }
  }

  const category = await guild.channels.create({
          name: SUPPORT_CATEGORY_NAME,
          type: ChannelType.GuildCategory,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
              ],
              deny: [
                PermissionFlagsBits.SendMessages,
              ],
            },
            {
              id: bot.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles,
              ],
            },
          ],
        });

  await updateGuildConfig(
    guild.id,
    (config) => {
      config.supportCategoryId = category.id;
      config.managedCategoryIds = Array.from(
        new Set([...(config.managedCategoryIds ?? []), category.id]),
      );
    },
  );

  return category;
}

async function ensureTranscriptChannel(
  guild: Guild,
  parentId: string,
): Promise<TextChannel> {
  const config =
    await getGuildConfig(guild.id);

  const bot = guild.members.me;

  if (!bot) {
    throw new Error(
      'ResolvX bot member could not be resolved.',
    );
  }

  const staffRoleIds = [
    ...new Set(
      Object.values(config.departments)
        .map((department) => department.staffRoleId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  if (config.transcriptChannelId) {
    const saved = guild.channels.cache.get(
      config.transcriptChannelId,
    );

    if (
      saved?.type === ChannelType.GuildText
    ) {
      await reconcileManagedTextChannel(
        saved,
        parentId,
        `${TRANSCRIPT_TOPIC} guild=${guild.id}`,
        transcriptChannelOverwrites(guild, bot.id, staffRoleIds),
        'Repair ResolvX transcript channel parent, topic and access',
      );

      await ensureChannelPurposeMessage(
        saved,
        'This private channel is the ResolvX transcript archive. Closed ticket conversations are exported here as HTML transcripts for staff records, review, and historical reference.',
      );
      return saved;
    }
  }

  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.topic?.startsWith(
        TRANSCRIPT_TOPIC,
      ),
  );

  if (
    existing?.type === ChannelType.GuildText
  ) {
    await reconcileManagedTextChannel(
      existing,
      parentId,
      `${TRANSCRIPT_TOPIC} guild=${guild.id}`,
      transcriptChannelOverwrites(guild, bot.id, staffRoleIds),
      'Repair recovered ResolvX transcript channel parent, topic and access',
    );

    await updateGuildConfig(
      guild.id,
      (current) => {
        current.transcriptChannelId =
          existing.id;
      },
    );

    await ensureChannelPurposeMessage(
      existing,
      'This private channel is the ResolvX transcript archive. Closed ticket conversations are exported here as HTML transcripts for staff records, review, and historical reference.',
    );

    return existing;
  }

  const channel =
    await guild.channels.create({
      name: TRANSCRIPT_NAME,
      type: ChannelType.GuildText,
      parent: parentId,
      topic: `${TRANSCRIPT_TOPIC} guild=${guild.id}`,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        {
          id: bot.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        },
        ...staffRoleIds.map((roleId) => ({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
          ],
          deny: [
            PermissionFlagsBits.SendMessages,
          ],
        })),
      ],
    });

  await updateGuildConfig(
    guild.id,
    (current) => {
      current.transcriptChannelId =
        channel.id;
    },
  );

  await ensureChannelPurposeMessage(
    channel,
    'This private channel is the ResolvX transcript archive. Closed ticket conversations are exported here as HTML transcripts for staff records, review, and historical reference.',
  );

  return channel;
}

export async function ensurePanelChannel(
  guild: Guild,
  parentId: string,
): Promise<TextChannel> {
  const config =
    await getGuildConfig(guild.id);

  const bot = guild.members.me;

  if (!bot) {
    throw new Error(
      'ResolvX bot member could not be resolved.',
    );
  }

  if (config.panelChannelId) {
    const saved = guild.channels.cache.get(
      config.panelChannelId,
    );

    if (
      saved?.type === ChannelType.GuildText
    ) {
      await reconcileManagedTextChannel(
        saved,
        parentId,
        `${PANEL_TOPIC} guild=${guild.id}`,
        panelChannelOverwrites(guild, bot.id),
        'Repair ResolvX panel channel parent, topic and access',
      );
      return saved;
    }
  }

  /*
   * A channel name is not ownership proof. Recover a previous ResolvX
   * panel only from its managed topic; otherwise create a new panel channel.
   */
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.topic?.startsWith(PANEL_TOPIC),
  );

  if (
    existing?.type === ChannelType.GuildText
  ) {
    await reconcileManagedTextChannel(
      existing,
      parentId,
      `${PANEL_TOPIC} guild=${guild.id}`,
      panelChannelOverwrites(guild, bot.id),
      'Repair recovered ResolvX panel channel parent, topic and access',
    );

    await updateGuildConfig(
      guild.id,
      (current) => {
        current.panelChannelId =
          existing.id;
      },
    );

    return existing;
  }

  const channel =
    await guild.channels.create({
      name: PANEL_CHANNEL_NAME,
      type: ChannelType.GuildText,
      parent: parentId,
      topic: `${PANEL_TOPIC} guild=${guild.id}`,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
          ],
          deny: [
            PermissionFlagsBits.SendMessages,
          ],
        },
        {
          id: bot.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.EmbedLinks,
          ],
        },
      ],
    });

  await updateGuildConfig(
    guild.id,
    (current) => {
      current.panelChannelId =
        channel.id;
    },
  );

  return channel;
}

export async function syncPanel(
  guild: Guild,
  page = 0,
): Promise<void> {
  const config = await getGuildConfig(guild.id);
  const settings = await getAdvancedSettings(guild.id);

  const parent = await ensureContainer(guild);
  const panel = await ensurePanelChannel(guild, parent.id);

  const departments = Object.values(config.departments).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  /*
   * Discord limits a message to 25 components. Five rows can therefore hold
   * at most four rows of department buttons when the fifth row is reserved
   * for pagination.
   */
  const departmentsPerPage = departments.length > 20 ? 20 : 25;
  const pageCount = Math.max(1, Math.ceil(departments.length / departmentsPerPage));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const visibleDepartments = departments.slice(
    safePage * departmentsPerPage,
    (safePage + 1) * departmentsPerPage,
  );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let i = 0; i < visibleDepartments.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        visibleDepartments
          .slice(i, i + 5)
          .map((department) => categoryButton(department.id, department.name)),
      ),
    );
  }

  if (pageCount > 1) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket:panel:page:${safePage - 1}`)
          .setLabel('Previous')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage === 0),
        new ButtonBuilder()
          .setCustomId(`ticket:panel:page:${safePage + 1}`)
          .setLabel(`Page ${safePage + 1} / ${pageCount}`)
          .setEmoji('📄')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`ticket:panel:page:${safePage + 1}`)
          .setLabel('Next')
          .setEmoji('➡️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage >= pageCount - 1),
      ),
    );
  }

  const embed = await buildPanelEmbed(guild, departments, safePage);

  let message = config.panelMessageId
    ? await panel.messages.fetch(config.panelMessageId).catch(() => null)
    : null;

  if (!message) {
    const existingBotMessage = (
      await panel.messages.fetch({ limit: 50 })
    ).find(
      (candidate) =>
        candidate.author.id === guild.client.user?.id &&
        (
          candidate.embeds.some((embed) => embed.title === settings.appearance.panelTitle) ||
          candidate.components.some((row) =>
            row.type === 1 &&
            row.components.some((component) =>
              'customId' in component &&
              typeof component.customId === 'string' &&
              component.customId.startsWith('ticket:create:'),
            ),
          )
        ),
    );

    message = existingBotMessage ?? null;
  }

  if (message) {
    await message.edit({
      embeds: [embed],
      components: rows,
    });
  } else {
    message = await panel.send({
      embeds: [embed],
      components: rows,
    });
  }

  await updateGuildConfig(guild.id, (current) => {
    current.panelChannelId = panel.id;
    current.panelMessageId = message.id;
  });
}


export const data =
  new SlashCommandBuilder()
    .setName('supportforge')
    .setDescription(
      'Manage ResolvX and support tickets',
    )
    .setDMPermission(false)

    // ─────────────────────────────────────────────
    // SETUP
    // ─────────────────────────────────────────────

    .addSubcommand((subcommand) =>
      subcommand
        .setName('setup')
        .setDescription(
          'Create or repair the ResolvX system',
        ),
    )

    .addSubcommand((subcommand) =>
      subcommand
        .setName('restore')
        .setDescription(
          'Restore ResolvX after accidental deletion',
        ),
    )

    // ─────────────────────────────────────────────
    // CATEGORY MANAGEMENT
    // ─────────────────────────────────────────────

    .addSubcommandGroup((group) =>
      group
        .setName('category')
        .setDescription(
          'Manage ticket departments',
        )

        .addSubcommand((subcommand) =>
          subcommand
            .setName('add')
            .setDescription(
              'Add a ticket department',
            )
            .addStringOption((option) =>
              option
                .setName('name')
                .setDescription(
                  'Department name',
                )
                .setRequired(true)
                .setMaxLength(80),
            )
            .addRoleOption((option) =>
              option
                .setName('staff-role')
                .setDescription(
                  'Role that handles this department',
                )
                .setRequired(false),
            ),
        )

        .addSubcommand((subcommand) =>
          subcommand
            .setName('list')
            .setDescription('List configured ticket departments')
            .addIntegerOption((option) => option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1).setMaxValue(999)),
        )

        .addSubcommand((subcommand) =>
          subcommand
            .setName('remove')
            .setDescription(
              'Remove a ticket department',
            )
            .addStringOption((option) =>
              option
                .setName('name')
                .setDescription(
                  'Department name',
                )
                .setRequired(true)
                .setMaxLength(80),
            ),
        ),
    )

    // ─────────────────────────────────────────────
    // CUSTOM MULTI-PANEL BUILDER
    // ─────────────────────────────────────────────

    .addSubcommandGroup((group) =>
      group
        .setName('panel')
        .setDescription('Create, preview, publish, and manage support panels')
        .addSubcommand((subcommand) =>
          subcommand.setName('create').setDescription('Create a saved custom panel draft')
            .addStringOption((option) => option.setName('name').setDescription('Unique panel name').setRequired(true).setMaxLength(80))
            .addStringOption((option) => option.setName('title').setDescription('Panel heading').setRequired(true).setMaxLength(256))
            .addStringOption((option) => option.setName('description').setDescription('Instructions shown above the ticket buttons').setRequired(true).setMaxLength(4000))
            .addStringOption((option) => option.setName('buttons-json').setDescription('Optional ordered button JSON. Omit for an empty draft and manage buttons in Settings.').setRequired(false).setMaxLength(4000))
            .addStringOption((option) => option.setName('footer').setDescription('Optional footer text').setRequired(false).setMaxLength(2048))
            .addStringOption((option) => option.setName('color').setDescription('Optional six-digit hex color such as #22D3EE').setRequired(false).setMaxLength(7))
            .addStringOption((option) => option.setName('icon-url').setDescription('Optional public HTTPS icon URL').setRequired(false).setMaxLength(2048))
            .addStringOption((option) => option.setName('thumbnail-url').setDescription('Optional public HTTPS thumbnail URL').setRequired(false).setMaxLength(2048))
            .addStringOption((option) => option.setName('banner-url').setDescription('Optional public HTTPS banner image URL').setRequired(false).setMaxLength(2048)),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('list').setDescription('List saved custom panels'),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('show').setDescription('Show a saved custom panel')
            .addStringOption((option) => option.setName('panel-id').setDescription('Panel ID from the list').setRequired(true).setMaxLength(12)),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('update').setDescription('Update a saved panel draft')
            .addStringOption((option) => option.setName('panel-id').setDescription('Panel ID from the list').setRequired(true).setMaxLength(12))
            .addStringOption((option) => option.setName('name').setDescription('New panel name').setRequired(false).setMaxLength(80))
            .addStringOption((option) => option.setName('title').setDescription('New panel heading').setRequired(false).setMaxLength(256))
            .addStringOption((option) => option.setName('description').setDescription('New instructions').setRequired(false).setMaxLength(4000))
            .addStringOption((option) => option.setName('footer').setDescription('Footer text, or none to clear').setRequired(false).setMaxLength(2048))
            .addStringOption((option) => option.setName('color').setDescription('Hex color, or none to use server theme').setRequired(false).setMaxLength(7))
            .addStringOption((option) => option.setName('icon-url').setDescription('Icon URL, or none to clear').setRequired(false).setMaxLength(2048))
            .addStringOption((option) => option.setName('thumbnail-url').setDescription('Thumbnail URL, or none to clear').setRequired(false).setMaxLength(2048))
            .addStringOption((option) => option.setName('banner-url').setDescription('Banner image URL, or none to clear').setRequired(false).setMaxLength(2048))
            .addStringOption((option) => option.setName('buttons-json').setDescription('Replace/reorder buttons using the create schema').setRequired(false).setMaxLength(4000)),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('preview').setDescription('Preview the current draft privately; preview buttons are disabled')
            .addStringOption((option) => option.setName('panel-id').setDescription('Panel ID from the list').setRequired(true).setMaxLength(12)),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('publish').setDescription('Publish or update a panel message')
            .addStringOption((option) => option.setName('panel-id').setDescription('Panel ID from the list').setRequired(true).setMaxLength(12))
            .addChannelOption((option) => option.setName('channel').setDescription('Text channel where the panel will appear').setRequired(true).addChannelTypes(ChannelType.GuildText)),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('delete').setDescription('Delete a saved panel and its published message, never its tickets')
            .addStringOption((option) => option.setName('panel-id').setDescription('Panel ID from the list').setRequired(true).setMaxLength(12))
            .addBooleanOption((option) => option.setName('confirm').setDescription('Confirm deleting this panel definition/message').setRequired(true)),
        ),
    )

    // ─────────────────────────────────────────────
    // REUSABLE VERSIONED TICKET FORMS
    // ─────────────────────────────────────────────

    .addSubcommandGroup((group) =>
      group
        .setName('form')
        .setDescription('Create and manage versioned ticket forms')
        .addSubcommand((subcommand) =>
          subcommand
            .setName('list')
            .setDescription('List forms and valid department/tag IDs')
            .addIntegerOption((option) =>
              option
                .setName('page')
                .setDescription('Page number for long form/department lists')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(999),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('show')
            .setDescription('Show a form and its configured fields')
            .addStringOption((option) => option.setName('id').setDescription('Form ID from form list').setRequired(true).setMaxLength(36)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('guide')
            .setDescription('Show the supported ticket form field schema guide'),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('schema')
            .setDescription('View a ticket form schema as paginated JSON')
            .addStringOption((option) => option.setName('id').setDescription('Form ID from form list').setRequired(true).setMaxLength(36))
            .addIntegerOption((option) => option.setName('page').setDescription('Schema page number').setRequired(false).setMinValue(1).setMaxValue(999)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('quick-create')
            .setDescription('Create a simple form using guided questions instead of JSON')
            .addStringOption((option) => option.setName('name').setDescription('Form name').setRequired(true).setMaxLength(80))
            .addStringOption((option) => option.setName('department-id').setDescription('Existing department ID from form list').setRequired(true).setMaxLength(28))
            .addStringOption((option) => option.setName('tag-id').setDescription('Existing tag ID, or * for every tag in this department').setRequired(true).setMaxLength(28))
            .addStringOption((option) => option.setName('question-one').setDescription('First short-text question (1–45 characters)').setRequired(true).setMaxLength(45))
            .addStringOption((option) => option.setName('question-two').setDescription('Second short-text question (optional)').setRequired(false).setMaxLength(45)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('create')
            .setDescription('Create an inactive ticket form from a JSON field schema')
            .addStringOption((option) => option.setName('name').setDescription('Form name').setRequired(true).setMaxLength(80))
            .addStringOption((option) => option.setName('department-id').setDescription('Existing department ID from form list').setRequired(true).setMaxLength(28))
            .addStringOption((option) => option.setName('tag-id').setDescription('Existing tag ID, or * for every tag in this department').setRequired(true).setMaxLength(28))
            .addStringOption((option) => option.setName('fields-json').setDescription('JSON array with up to 25 custom fields across steps').setRequired(true).setMaxLength(6000)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('update')
            .setDescription('Create a new immutable version of a form schema')
            .addStringOption((option) => option.setName('id').setDescription('Form ID from form list').setRequired(true).setMaxLength(36))
            .addStringOption((option) => option.setName('fields-json').setDescription('Replacement JSON field definitions; prior versions are retained').setRequired(true).setMaxLength(6000)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('activate')
            .setDescription('Activate a form for its department/tag mapping')
            .addStringOption((option) => option.setName('id').setDescription('Form ID from form list').setRequired(true).setMaxLength(36)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('deactivate')
            .setDescription('Stop using a form for new tickets; keep historic versions and answers')
            .addStringOption((option) => option.setName('id').setDescription('Form ID from form list').setRequired(true).setMaxLength(36)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('template-save')
            .setDescription('Save a reusable ticket form template')
            .addStringOption((option) => option.setName('name').setDescription('Template name').setRequired(true).setMaxLength(80))
            .addStringOption((option) => option.setName('fields-json').setDescription('JSON array with up to 25 custom fields across steps').setRequired(true).setMaxLength(6000)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('template-list')
            .setDescription('List reusable form templates')
            .addIntegerOption((option) => option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1).setMaxValue(999)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('template-show')
            .setDescription('Show a saved template and its fields')
            .addStringOption((option) => option.setName('template-id').setDescription('Template ID from template-list').setRequired(true).setMaxLength(36)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('template-apply')
            .setDescription('Create an inactive form using a saved template')
            .addStringOption((option) => option.setName('template-id').setDescription('Template ID from template-list').setRequired(true).setMaxLength(36))
            .addStringOption((option) => option.setName('name').setDescription('Name for the new form').setRequired(true).setMaxLength(80))
            .addStringOption((option) => option.setName('department-id').setDescription('Existing department ID').setRequired(true).setMaxLength(28))
            .addStringOption((option) => option.setName('tag-id').setDescription('Existing tag ID or * for every tag').setRequired(true).setMaxLength(28)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('template-delete')
            .setDescription('Delete a saved template; created forms remain unchanged')
            .addStringOption((option) => option.setName('template-id').setDescription('Template ID from template-list').setRequired(true).setMaxLength(36)),
        ),
    )

    // ─────────────────────────────────────────────
    // PREMIUM
    // ─────────────────────────────────────────────

    .addSubcommandGroup((group) =>
      group
        .setName('premium')
        .setDescription(
          'Preview paid features',
        )

        .addSubcommand((subcommand) =>
          subcommand
            .setName('status')
            .setDescription(
              'Show the current tier',
            ),
        )

        .addSubcommand((subcommand) =>
          subcommand
            .setName('toggle-demo')
            .setDescription(
              'Cycle Free → Premium Demo → Pro Demo → Free',
            ),
        ),
    )

    // ─────────────────────────────────────────────
    // TICKET MANAGEMENT
    // ─────────────────────────────────────────────

    .addSubcommandGroup((group) =>
      group
        .setName('ticket')
        .setDescription(
          'Create tickets and manage ticket workflows',
        )

        // PRIORITY
        .addSubcommand((subcommand) =>
          subcommand
            .setName('create')
            .setDescription('Create a ticket without using the support panel button')
            .addStringOption((option) => option.setName('department-id').setDescription('Department ID from Settings → Departments').setRequired(true).setMaxLength(28))
            .addStringOption((option) => option.setName('tag-id').setDescription('Tag ID belonging to the selected department').setRequired(true).setMaxLength(28)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('priority')
            .setDescription(
              'Set ticket priority',
            )
            .addStringOption((option) =>
              option
                .setName('level')
                .setDescription(
                  'Priority',
                )
                .setRequired(true)
                .addChoices(
                  {
                    name: 'Low',
                    value: 'low',
                  },
                  {
                    name: 'Normal',
                    value: 'normal',
                  },
                  {
                    name: 'High',
                    value: 'high',
                  },
                  {
                    name: 'Urgent',
                    value: 'urgent',
                  },
                  {
                    name: 'Critical',
                    value: 'critical',
                  },
                ),
            ),
        )

        // INTERNAL NOTE
        .addSubcommand((subcommand) =>
          subcommand
            .setName('note')
            .setDescription(
              'Add an internal staff note',
            )
            .addStringOption((option) =>
              option
                .setName('text')
                .setDescription(
                  'Internal note',
                )
                .setRequired(true)
                .setMaxLength(4000),
            ),
        )

        // HISTORY
        .addSubcommand((subcommand) =>
          subcommand
            .setName('history')
            .setDescription(
              'Show recent ticket events',
            ),
        )

        .addSubcommand((subcommand) =>
          subcommand
            .setName('panel')
            .setDescription(
              'Open manual controls for the ticket panel',
            ),
        )

        .addSubcommand((subcommand) =>
          subcommand
            .setName('archive')
            .setDescription(
              'Archive the current closed ticket',
            ),
        )

        .addSubcommand((subcommand) =>
          subcommand
            .setName('delete')
            .setDescription('Delete this ticket after two explicit confirmations'),
        )

        // ADD USER
        .addSubcommand((subcommand) =>
          subcommand
            .setName('add-user')
            .setDescription(
              'Give a user access to this ticket',
            )
            .addUserOption((option) =>
              option
                .setName('user')
                .setDescription('User')
                .setRequired(true),
            ),
        )

        // REMOVE USER
        .addSubcommand((subcommand) =>
          subcommand
            .setName('remove-user')
            .setDescription(
              'Remove a user from this ticket',
            )
            .addUserOption((option) =>
              option
                .setName('user')
                .setDescription('User')
                .setRequired(true),
            ),
        )

        // CLAIM
        .addSubcommand((subcommand) =>
          subcommand
            .setName('claim')
            .setDescription(
              'Claim this ticket for yourself',
            ),
        )

        // UNCLAIM
        .addSubcommand((subcommand) =>
          subcommand
            .setName('unclaim')
            .setDescription(
              'Release your claim on this ticket',
            ),
        )

        // REASSIGN
        .addSubcommand((subcommand) =>
          subcommand
            .setName('reassign')
            .setDescription(
              'Reassign this ticket to another staff member',
            )
            .addUserOption((option) =>
              option
                .setName('staff')
                .setDescription(
                  'The staff member who should receive the ticket',
                )
                .setRequired(true),
            )
            .addStringOption((option) =>
              option
                .setName('reason')
                .setDescription(
                  'Optional reason for the reassignment',
                )
                .setRequired(false)
                .setMaxLength(500),
            ),
        )

        // PENDING
        .addSubcommand((subcommand) =>
          subcommand
            .setName('pending')
            .setDescription(
              'Mark this ticket as waiting for a response',
            ),
        )

        // RESUME
        .addSubcommand((subcommand) =>
          subcommand
            .setName('resume')
            .setDescription('Move a pending ticket back to open'),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('close').setDescription('Start the ticket close workflow'),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('reopen').setDescription('Reopen this closed ticket'),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('department')
            .setDescription('Move this ticket to a department directly')
            .addStringOption((option) => option.setName('department-id').setDescription('Department ID from /supportforge form list').setRequired(true).setMaxLength(28))
            .addStringOption((option) => option.setName('tag-id').setDescription('Optional tag ID for the destination department').setRequired(false).setMaxLength(28)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('tag')
            .setDescription('Set this ticket tag directly')
            .addStringOption((option) => option.setName('tag-id').setDescription('Tag ID from /supportforge form list').setRequired(true).setMaxLength(28)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('voice')
            .setDescription('Open private ticket voice controls')
            .addStringOption((option) => option.setName('action').setDescription('Voice action').setRequired(true).addChoices(
              { name: 'Start voice mode', value: 'start' },
              { name: 'End voice mode', value: 'end' },
              { name: 'Join private voice', value: 'join' },
            )),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('report')
            .setDescription('Submit a report about a participant in this ticket')
            .addUserOption((option) => option.setName('target').setDescription('Ticket participant being reported').setRequired(true))
            .addStringOption((option) => option.setName('category-id').setDescription('Configured report category name or ID').setRequired(true).setMaxLength(80))
            .addStringOption((option) => option.setName('subcategory-id').setDescription('Configured subcategory name or ID').setRequired(true).setMaxLength(80))
            .addStringOption((option) => option.setName('description').setDescription('Evidence or context (optional)').setRequired(false).setMaxLength(500))
            .addBooleanOption((option) => option.setName('flag').setDescription('Flag violation (true) or record only (false)').setRequired(true)),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('move-panel').setDescription('Move the ticket controls to the bottom'),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('settings')
        .setDescription('Manage ResolvX settings from slash commands')
        .addSubcommand((subcommand) =>
          subcommand.setName('overview').setDescription('Show a Settings overview and current configuration'),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('theme')
            .setDescription('View or change this server’s ResolvX color theme')
            .addStringOption((option) => option.setName('action').setDescription('Show the current theme or set a new one').setRequired(true).addChoices(
              { name: 'Show current theme', value: 'show' },
              { name: 'Set server theme', value: 'set' },
            ))
            .addStringOption((option) => option.setName('theme').setDescription('Theme palette to apply to this server').addChoices(
              ...UI_THEMES.map((theme) => ({ name: theme.label, value: theme.id })),
            )),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('panel')
            .setDescription('View or update ticket panel automation')
            .addStringOption((option) => option.setName('action').setDescription('Automation action').setRequired(true).addChoices(
              { name: 'Show settings', value: 'show' },
              { name: 'Toggle', value: 'toggle' },
              { name: 'Enable', value: 'enable' },
              { name: 'Disable', value: 'disable' },
            ))
            .addIntegerOption((option) => option.setName('visual-lines').setDescription('Visual line budget (6-40)').setMinValue(6).setMaxValue(40))
            .addIntegerOption((option) => option.setName('message-cap').setDescription('Message safety cap (5-30)').setMinValue(5).setMaxValue(30))
            .addIntegerOption((option) => option.setName('minimum-messages').setDescription('Minimum messages before moving (3-20)').setMinValue(3).setMaxValue(20)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('defaults')
            .setDescription('View or change default priority for new tickets')
            .addStringOption((option) => option.setName('priority').setDescription('Default priority').addChoices(
              { name: 'Low', value: 'low' }, { name: 'Normal', value: 'normal' },
              { name: 'High', value: 'high' }, { name: 'Urgent', value: 'urgent' }, { name: 'Critical', value: 'critical' },
            )),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('team')
            .setDescription('View or change the simultaneous moderator limit')
            .addIntegerOption((option) => option.setName('max-moderators').setDescription('Moderator limit (1-3)').setMinValue(1).setMaxValue(3)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('retention')
            .setDescription('View or change ticket retention settings')
            .addIntegerOption((option) => option.setName('closed-days').setDescription('Closed-ticket retention days (0-365)').setMinValue(0).setMaxValue(365))
            .addIntegerOption((option) => option.setName('archive-days').setDescription('Archived-ticket retention days (0-365)').setMinValue(0).setMaxValue(365)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('retention-action')
            .setDescription('Review eligible tickets or act on a pending retention approval')
            .addStringOption((option) => option.setName('action').setDescription('Retention approval action').setRequired(true).addChoices(
              { name: 'Review eligible tickets', value: 'review' },
              { name: 'Approve pending deletion', value: 'approve' },
              { name: 'Decline pending deletion', value: 'decline' },
            ))
            .addStringOption((option) => option.setName('scope').setDescription('Closed or archived tickets').setRequired(true).addChoices(
              { name: 'Closed tickets', value: 'closed' },
              { name: 'Archived tickets', value: 'archive' },
            ))
            .addBooleanOption((option) => option.setName('confirm-delete').setDescription('Required true to execute an approved deletion').setRequired(false)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('appearance')
            .setDescription('View or update the public support panel appearance')
            .addStringOption((option) => option.setName('title').setDescription('Panel title').setMaxLength(256))
            .addStringOption((option) => option.setName('description').setDescription('Panel description').setMaxLength(1500))
            .addStringOption((option) => option.setName('footer').setDescription('Panel footer').setMaxLength(2048)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('reports')
            .setDescription('View or change report intake')
            .addStringOption((option) => option.setName('action').setDescription('Report intake action').setRequired(true).addChoices(
              { name: 'Show status', value: 'show' }, { name: 'Toggle', value: 'toggle' },
              { name: 'Enable', value: 'enable' }, { name: 'Disable', value: 'disable' },
            )),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('report-rules')
            .setDescription('View or update report flag thresholds')
            .addIntegerOption((option) => option.setName('ticket-threshold').setDescription('Ticket restrictions; 0 disables').setMinValue(0).setMaxValue(1000))
            .addIntegerOption((option) => option.setName('server-threshold').setDescription('Server action threshold; 0 disables').setMinValue(0).setMaxValue(1000))
            .addIntegerOption((option) => option.setName('channel-threshold').setDescription('Channel action threshold; 0 disables').setMinValue(0).setMaxValue(1000))
            .addChannelOption((option) => option.setName('channel').setDescription('Channel for channel-restriction rule').addChannelTypes(ChannelType.GuildText)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('department-edit')
            .setDescription('Rename a department or change its staff role')
            .addStringOption((option) => option.setName('department-name').setDescription('Current department name').setRequired(true).setMaxLength(80))
            .addStringOption((option) => option.setName('new-name').setDescription('New department name').setRequired(true).setMaxLength(80))
            .addRoleOption((option) => option.setName('staff-role').setDescription('New staff role (optional)'))
            .addBooleanOption((option) => option.setName('clear-staff-role').setDescription('Remove current staff role')),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('tag-add')
            .setDescription('Add a ticket tag to a department')
            .addStringOption((option) => option.setName('department-name').setDescription('Department name').setRequired(true).setMaxLength(80))
            .addStringOption((option) => option.setName('name').setDescription('Tag name').setRequired(true).setMaxLength(80)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('tag-rename')
            .setDescription('Rename a ticket tag')
            .addStringOption((option) => option.setName('department-name').setDescription('Department name').setRequired(true).setMaxLength(80))
            .addStringOption((option) => option.setName('current-name').setDescription('Current tag name').setRequired(true).setMaxLength(80))
            .addStringOption((option) => option.setName('new-name').setDescription('New tag name').setRequired(true).setMaxLength(80)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('tag-remove')
            .setDescription('Remove a ticket tag')
            .addStringOption((option) => option.setName('department-name').setDescription('Department name').setRequired(true).setMaxLength(80))
            .addStringOption((option) => option.setName('tag-name').setDescription('Tag name to remove').setRequired(true).setMaxLength(80)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('usecase-add')
            .setDescription('Add a department preset with eight starter tags')
            .addStringOption((option) => option.setName('preset').setDescription('Preset to add').setRequired(true).addChoices(
              { name: 'Technical Support', value: 'technical-support' },
              { name: 'Sales', value: 'sales' },
              { name: 'Account & Access', value: 'account-access' },
              { name: 'Partnerships', value: 'partnerships' },
              { name: 'Reports & Abuse', value: 'reports-abuse' },
              { name: 'Refunds & Returns', value: 'refunds-returns' },
              { name: 'Product Support', value: 'product-support' },
              { name: 'VIP Support', value: 'vip-support' },
            )),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('storage')
            .setDescription('Add an optional status category or repair storage')
            .addStringOption((option) => option.setName('action').setDescription('Storage action').setRequired(true).addChoices(
              { name: 'Show current storage categories', value: 'status' },
              { name: 'Add Claimed category', value: 'claimed' },
              { name: 'Add Pending category', value: 'pending' },
              { name: 'Repair Closed/Archive storage', value: 'repair' },
            )),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('priority-role')
            .setDescription('Create or delete a ResolvX-managed priority role')
            .addStringOption((option) => option.setName('action').setDescription('Role action').setRequired(true).addChoices(
              { name: 'Show current roles', value: 'status' },
              { name: 'Create role', value: 'create' },
              { name: 'Delete managed role', value: 'delete' },
            ))
            .addStringOption((option) => option.setName('priority').setDescription('Priority (required for create/delete)').setRequired(false).addChoices(
              { name: 'Low', value: 'low' }, { name: 'Normal', value: 'normal' },
              { name: 'High', value: 'high' }, { name: 'Urgent', value: 'urgent' }, { name: 'Critical', value: 'critical' },
            )),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('repair')
            .setDescription('Repair ResolvX infrastructure')
            .addStringOption((option) => option.setName('mode').setDescription('Repair mode').setRequired(true).addChoices(
              { name: 'Normal infrastructure repair', value: 'normal' },
              { name: 'Closed/Archive storage repair', value: 'storage' },
            )),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('refresh').setDescription('Refresh the Settings dashboard and support panel'),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('manual')
            .setDescription('Display the quick or detailed staff manual summary')
            .addStringOption((option) => option.setName('version').setDescription('Manual version').setRequired(true).addChoices(
              { name: 'Quick overview', value: 'quick' }, { name: 'Detailed manual', value: 'detailed' },
            )),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('support-hours')
            .setDescription('Configure time-zone-aware support hours for this server, department, or panel')
            .addStringOption((option) => option.setName('action').setDescription('Support-hours action').setRequired(true).addChoices(
              { name: 'Show effective schedule', value: 'show' },
              { name: 'Set time zone', value: 'set-timezone' },
              { name: 'Set one weekday', value: 'set-day' },
              { name: 'Set outside-hours behavior', value: 'behavior' },
              { name: 'Enable schedule enforcement', value: 'enable' },
              { name: 'Disable schedule enforcement', value: 'disable' },
              { name: 'Remove this scope override', value: 'clear-scope' },
            ))
            .addStringOption((option) => option.setName('scope').setDescription('Which schedule to configure').setRequired(true).addChoices(
              { name: 'Server default', value: 'guild' },
              { name: 'Department override', value: 'department' },
              { name: 'Ticket panel override', value: 'panel' },
            ))
            .addStringOption((option) => option.setName('scope-id').setDescription('Department ID or panel ID; omit for server default').setMaxLength(40))
            .addStringOption((option) => option.setName('timezone').setDescription('IANA time zone, such as Asia/Kolkata').setMaxLength(100))
            .addStringOption((option) => option.setName('day').setDescription('Weekday to configure').addChoices(
              { name: 'Monday', value: 'monday' }, { name: 'Tuesday', value: 'tuesday' },
              { name: 'Wednesday', value: 'wednesday' }, { name: 'Thursday', value: 'thursday' },
              { name: 'Friday', value: 'friday' }, { name: 'Saturday', value: 'saturday' },
              { name: 'Sunday', value: 'sunday' },
            ))
            .addStringOption((option) => option.setName('intervals').setDescription('Example: 09:00-12:00,13:00-17:00; or closed').setMaxLength(300))
            .addStringOption((option) => option.setName('behavior').setDescription('What to do outside opening hours').addChoices(
              { name: 'Allow new tickets outside opening hours', value: 'allow' },
              { name: 'Restrict new ticket creation', value: 'restrict' },
            )),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('ticket-workspace')
            .setDescription('Choose the resource type used for new tickets')
            .addStringOption((option) => option.setName('action').setDescription('Show or change the ticket workspace mode').setRequired(true).addChoices(
              { name: 'Show current mode', value: 'show' },
              { name: 'Use private text channels', value: 'text-channels' },
              { name: 'Use private threads', value: 'private-threads' },
            )),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('inactivity')
            .setDescription('View or configure ticket inactivity auto-close')
            .addStringOption((option) => option.setName('action').setDescription('Inactivity policy action').setRequired(true).addChoices(
              { name: 'Show settings', value: 'show' },
              { name: 'Enable automation', value: 'enable' },
              { name: 'Disable automation', value: 'disable' },
              { name: 'Configure thresholds', value: 'configure' },
              { name: 'Set exempt roles', value: 'set-exempt-roles' },
              { name: 'Set exempt departments', value: 'set-exempt-departments' },
              { name: 'Clear all exemptions', value: 'clear-exemptions' },
            ))
            .addIntegerOption((option) => option.setName('idle-hours').setDescription('Hours of inactivity before warning (1–720)').setMinValue(1).setMaxValue(720))
            .addIntegerOption((option) => option.setName('grace-hours').setDescription('Hours after warning before auto-close (1–168)').setMinValue(1).setMaxValue(168))
            .addStringOption((option) => option.setName('exempt-roles').setDescription('Comma-separated Discord role IDs, up to 25').setMaxLength(1000))
            .addStringOption((option) => option.setName('exempt-departments').setDescription('Comma-separated department IDs, up to 25').setMaxLength(1000)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('language')
            .setDescription('Show or change this server’s bot message language')
            .addStringOption((option) => option
              .setName('locale')
              .setDescription('New language; omit this option to show the current setting')
              .addChoices(...LOCALE_OPTIONS.map((locale) => ({
                name: (locale.label + ' · ' + locale.nativeLabel).slice(0, 100),
                value: locale.value,
              })))),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('reset')
            .setDescription('Factory-reset ResolvX after typed confirmation')
            .addStringOption((option) => option.setName('confirmation').setDescription('Type DELETE SUPPORT FORGE exactly').setRequired(true).setMinLength(20).setMaxLength(20))
            .addBooleanOption((option) => option.setName('accumulate-audit').setDescription('Keep individual audit events for future summaries').setRequired(true)),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('settings-reports')
        .setDescription('Manage report categories and subcategories')
            .addSubcommand((subcommand) =>
              subcommand
                .setName('report-categories')
                .setDescription('List report categories and inspect their subcategories')
                .addStringOption((option) => option.setName('category-id').setDescription('Optional category ID to inspect').setRequired(false).setMaxLength(80))
                .addIntegerOption((option) => option.setName('page').setDescription('Page number for the category list').setRequired(false).setMinValue(1).setMaxValue(999)),
            )
            .addSubcommand((subcommand) =>
              subcommand
                .setName('report-subcategory-add')
                .setDescription('Add a report subcategory')
                .addStringOption((option) => option.setName('category-id').setDescription('Report category ID').setRequired(true).setMaxLength(80))
                .addStringOption((option) => option.setName('name').setDescription('Subcategory name').setRequired(true).setMaxLength(80)),
            )
            .addSubcommand((subcommand) =>
              subcommand
                .setName('report-subcategory-edit')
                .setDescription('Rename a report subcategory')
                .addStringOption((option) => option.setName('category-id').setDescription('Report category ID').setRequired(true).setMaxLength(80))
                .addStringOption((option) => option.setName('subcategory-id').setDescription('Subcategory ID').setRequired(true).setMaxLength(80))
                .addStringOption((option) => option.setName('name').setDescription('New subcategory name').setRequired(true).setMaxLength(80)),
            )
            .addSubcommand((subcommand) =>
              subcommand
                .setName('report-subcategory-remove')
                .setDescription('Remove a report subcategory')
                .addStringOption((option) => option.setName('category-id').setDescription('Report category ID').setRequired(true).setMaxLength(80))
                .addStringOption((option) => option.setName('subcategory-id').setDescription('Subcategory ID').setRequired(true).setMaxLength(80)),
            )
,
    )
    .addSubcommandGroup((group) =>
      group
        .setName('audit')
        .setDescription('Review audit summaries and manage audit controls')
        .addSubcommand((subcommand) =>
          subcommand.setName('summary').setDescription('Show the overall audit summary'),
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('daily').setDescription('Show the latest saved daily audit summary'),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('accumulation')
            .setDescription('View or manage raw audit-event retention')
            .addStringOption((option) => option.setName('action').setDescription('Audit retention action').setRequired(true).addChoices(
              { name: 'Show current status', value: 'status' },
              { name: 'Enable raw-event accumulation', value: 'enable' },
              { name: 'Disable and clear raw events', value: 'disable' },
            ))
            .addBooleanOption((option) => option.setName('confirm-delete').setDescription('Required true to clear retained raw events').setRequired(false)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('developer')
            .setDescription('Open developer audit view controls')
            .addStringOption((option) => option.setName('action').setDescription('Developer view action').setRequired(true).addChoices(
              { name: 'Show options', value: 'options' },
              { name: 'Enable Developer View', value: 'enable' },
              { name: 'Disable Developer View', value: 'disable' },
              { name: 'Open a Developer View page', value: 'page' },
            ))
            .addIntegerOption((option) => option.setName('page').setDescription('Developer audit page (only for page action)').setMinValue(0).setMaxValue(999)),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('panel')
            .setDescription('Move or refresh the audit control panel')
            .addStringOption((option) => option.setName('action').setDescription('Audit panel action').setRequired(true).addChoices(
              { name: 'Move panel down', value: 'move' },
              { name: 'Restore audit panel', value: 'restore' },
              { name: 'Refresh panel', value: 'refresh' },
            )),
        ),
    );

export async function runSupportForgeSetup(
  guild: Guild,
  restoreMode = false,
): Promise<{ supportCategoryId: string; departmentCount: number; legacyOpenCategoryId: string | null }> {
  const supportCategory = await ensureContainer(guild);
  await getOrCreateAuditChannel(guild, supportCategory.id);
  await ensureTranscriptChannel(guild, supportCategory.id);
  await ensurePanelChannel(guild, supportCategory.id);
  await ensureOpenCategory(guild);
  await ensureClosedCategory(guild);
  await ensureArchiveCategory(guild);
  await ensureSettingsChannel(guild, supportCategory.id);
  await ensureAllDepartmentCategories(guild);
  await ensureSupportForgeCategoryPurposeMessages(guild, supportCategory.id);

  let config = await getGuildConfig(guild.id);
  if (Object.keys(config.departments).length === 0) {
    const departmentId = newDepartmentId();
    await updateGuildConfig(guild.id, (current) => {
      const now = new Date().toISOString();
      const tagId = newTagId();
      current.departments[departmentId] = {
        id: departmentId,
        name: 'General Support',
        staffRoleId: null,
        tags: { [tagId]: { id: tagId, name: 'General', createdAt: now } },
        createdAt: now,
      };
    });
    config = await getGuildConfig(guild.id);
  }

  await syncPanel(guild);
  const legacyOpenCategory = config.openCategoryId
    ? guild.channels.cache.get(config.openCategoryId)
    : undefined;
  await logSystemEvent(
    guild,
    supportCategory.id,
    restoreMode ? 'SUPPORTFORGE_RESTORED' : 'SETUP_COMPLETED',
    (restoreMode ? 'ResolvX restore completed.' : 'ResolvX setup/repair completed.') +
      ' Support Forge=' + supportCategory.id +
      '; Open=' + (legacyOpenCategory?.id ?? 'not-created') +
      '; departments=' + Object.keys(config.departments).length + '.',
  );
  await refreshSettingsChannel(guild);
  return {
    supportCategoryId: supportCategory.id,
    departmentCount: Object.keys(config.departments).length,
    legacyOpenCategoryId: legacyOpenCategory?.id ?? null,
  };
}

export async function runSupportForgeRepair(
  guild: Guild,
): Promise<{ supportCategoryId: string; recoveredTickets: number }> {
  const supportCategory = await ensureContainer(guild);
  await getOrCreateAuditChannel(guild, supportCategory.id);
  await ensureTranscriptChannel(guild, supportCategory.id);
  await ensurePanelChannel(guild, supportCategory.id);
  await ensureOpenCategory(guild);
  await ensureClosedCategory(guild);
  await ensureArchiveCategory(guild);
  const advancedSettings = await getAdvancedSettings(guild.id);
  if (advancedSettings.statusCategories.claimedCategoryId) {
    await ensureOptionalStatusCategory(guild, 'claimed');
  }
  if (advancedSettings.statusCategories.pendingCategoryId) {
    await ensureOptionalStatusCategory(guild, 'pending');
  }
  await ensureSettingsChannel(guild, supportCategory.id);
  await ensureAllDepartmentCategories(guild);
  await ensureSupportForgeCategoryPurposeMessages(guild, supportCategory.id);

  const currentConfig = await getGuildConfig(guild.id);
  const hasDeveloperAuditSignal =
    Boolean(currentConfig.auditDevChannelId || currentConfig.auditDeveloperRoleId) ||
    guild.roles.cache.some((role) => !role.managed && role.name === 'developer-mode audit-log') ||
    guild.channels.cache.some((channel) =>
      channel.type === ChannelType.GuildText && channel.topic?.startsWith('supportforge:audit-dev'),
    );
  if (hasDeveloperAuditSignal) {
    await ensureAuditDeveloperInfrastructure(guild, supportCategory.id);
  }

  const recoveredTickets = await recoverMissingTicketRecords(guild);
  await syncPanel(guild);
  await refreshSettingsChannel(guild);
  await logSystemEvent(
    guild,
    supportCategory.id,
    'SYSTEM_REPAIR_COMPLETED',
    'Normal Repair completed; recovered ' + recoveredTickets + ' missing durable ticket record(s).',
  );
  return { supportCategoryId: supportCategory.id, recoveredTickets };
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content:
        '❌ This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  const guild = interaction.guild;

  const subcommand =
    interaction.options.getSubcommand();

  const group =
    interaction.options.getSubcommandGroup(false);

  // Settings buttons require Manage Server or Administrator. Enforce the
  // same gate on slash commands; the Staff Manual is the sole exception and
  // remains available to configured department staff as in the button UI.
  if ((group === 'settings' || group === 'settings-reports') && !isAdminLike(interaction)) {
    let allowedDepartmentStaff = false;
    if (subcommand === 'manual') {
      const config = await getGuildConfig(guild.id);
      const staffRoleIds = new Set(
        Object.values(config.departments)
          .map((department) => department.staffRoleId)
          .filter((id): id is string => Boolean(id)),
      );
      const member = interaction.member;
      if (member) {
        const memberRoleIds = Array.isArray(member.roles)
          ? member.roles
          : member.roles.cache.map((role) => role.id);
        allowedDepartmentStaff = memberRoleIds.some((roleId) => staffRoleIds.has(roleId));
      }
    }
    if (!allowedDepartmentStaff) {
      await interaction.reply({
        content: '❌ You need **Manage Server** or **Administrator** to use ResolvX settings. The Staff Manual is also available to configured department staff.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // Administrative commands
  if (
    (!group &&
      (subcommand === 'setup' || subcommand === 'restore')) ||
    group === 'category' ||
    group === 'premium' ||
    group === 'form' ||
    group === 'panel'
  ) {
    if (!isAdminLike(interaction)) {
      await interaction.reply({
        content:
          '❌ You need **Manage Server** or **Administrator** for this command.',
        flags: MessageFlags.Ephemeral,
      });

      return;
    }
  }

  try {
    if (group === 'audit') {
      await handleAuditSlashCommand(interaction);
      return;
    }


    if (group === 'panel') {
      if (!isAdminLike(interaction)) {
        await interaction.reply({
          content: 'You need Manage Server or Administrator to manage custom support panels.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const action = interaction.options.getSubcommand();
      const guildConfig = await getGuildConfig(guild.id);
      const themeColor = getThemeColor(guildConfig.theme);
      const panelId = interaction.options.getString('panel-id');
      const writePanelAudit = (event: string, detail: string): void => {
        if (!guildConfig.supportCategoryId) return;
        void logSettingsEvent(guild, guildConfig.supportCategoryId, {
          action: event,
          actorId: interaction.user.id,
          actorName: interaction.user.tag,
          detail,
        }).catch((error) => console.warn('Custom panel audit logging failed:', error));
      };

      if (action === 'create') {
        const panel = await createCustomPanel(guild.id, {
          name: interaction.options.getString('name', true),
          title: interaction.options.getString('title', true),
          description: interaction.options.getString('description', true),
          buttons: interaction.options.getString('buttons-json') ?? [],
          footer: interaction.options.getString('footer') ?? undefined,
          color: interaction.options.getString('color') ?? undefined,
          iconUrl: interaction.options.getString('icon-url') ?? undefined,
          thumbnailUrl: interaction.options.getString('thumbnail-url') ?? undefined,
          bannerUrl: interaction.options.getString('banner-url') ?? undefined,
        });
        writePanelAudit('CUSTOM_PANEL_CREATED', 'Created panel "' + panel.name + '" (' + panel.id + ') with ' + panel.buttons.length + ' ordered ticket button(s).');
        await interaction.editReply(
          '**Panel draft created**\n\nName: **' + panel.name + '**\nPanel ID: `' + panel.id + '`\nButtons: **' + panel.buttons.length + '**\n\nUse `/supportforge panel preview` to inspect it privately, then `/supportforge panel publish` to put it in a channel. The draft is stored in Neon and is not public until published.',
        );
        return;
      }

      if (action === 'list') {
        const panels = await listCustomPanels(guild.id);
        const description = panels.length
          ? panels.slice(0, 25).map((panel) =>
              '**' + panel.name + '** · `' + panel.id + '` · ' +
              (panel.publishedMessageId ? 'Published in <#' + panel.publishedChannelId + '>' : 'Draft') +
              ' · ' + panel.buttons.length + ' button(s)',
            ).join('\n')
          : 'No custom panels have been created. Use `/supportforge panel create` to build the first one.';
        const embed = new EmbedBuilder().setColor(themeColor).setTitle('ResolvX • Custom Panels').setDescription(description.slice(0, 4096)).setFooter({ text: panels.length + ' saved panel(s) • ordered buttons persist in Neon' });
        if (panels.length > 25) embed.addFields({ name: 'More panels', value: 'Showing the first 25 of ' + panels.length + ' panels. Use Show with a panel ID to inspect an individual panel.' });
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (!panelId) throw new Error('A panel ID is required for this action.');
      let panel = await getCustomPanel(guild.id, panelId);
      if (!panel) throw new Error('No custom panel was found with ID "' + panelId + '". Use /supportforge panel list to check the ID.');

      if (action === 'show') {
        const buttonLines = panel.buttons.map((item, index) =>
          (index + 1) + '. ' + (item.emoji ? item.emoji + ' ' : '') + '**' + item.label + '** → ' +
          (item.targetType === 'form' ? 'Form `' + (item.formId ?? 'missing') + '`' : guildConfig.departments[item.departmentId]?.name + ' (`' + item.departmentId + '`)') +
          (item.tagId ? ' · tag `' + item.tagId + '`' : '') + ' · ' + item.style +
          (item.allowedRoleIds?.length ? ' · role-restricted' : '') +
          (item.confirmationMessage ? ' · confirmation enabled' : ''),
        );
        const embed = buildCustomPanelEmbed(panel, guild.name, themeColor, true)
          .setTitle(panel.name + ' · ' + panel.title)
          .addFields({ name: 'Panel ID', value: '`' + panel.id + '`', inline: true }, { name: 'Status', value: panel.publishedMessageId ? 'Published' : 'Draft', inline: true }, { name: 'Ordered ticket buttons', value: buttonLines.join('\n').slice(0, 1024) });
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (action === 'update') {
        const noneAsNull = (value: string | null): string | null | undefined => {
          if (value === null) return undefined;
          return value.trim().toLowerCase() === 'none' ? null : value;
        };
        const noneAsEmpty = (value: string | null): string | undefined => {
          if (value === null) return undefined;
          return value.trim().toLowerCase() === 'none' ? '' : value;
        };
        const buttonsJson = interaction.options.getString('buttons-json');
        const updated = await updateCustomPanel(guild.id, panel.id, {
          name: interaction.options.getString('name') ?? undefined,
          title: interaction.options.getString('title') ?? undefined,
          description: interaction.options.getString('description') ?? undefined,
          footer: noneAsEmpty(interaction.options.getString('footer')),
          color: noneAsNull(interaction.options.getString('color')),
          iconUrl: noneAsNull(interaction.options.getString('icon-url')),
          thumbnailUrl: noneAsNull(interaction.options.getString('thumbnail-url')),
          bannerUrl: noneAsNull(interaction.options.getString('banner-url')),
          buttons: buttonsJson ?? undefined,
        });
        writePanelAudit('CUSTOM_PANEL_UPDATED', 'Updated panel "' + updated.name + '" (' + updated.id + '); existing tickets were not changed.');
        await interaction.editReply('**Panel draft updated**\n\nPanel: **' + updated.name + '** · `' + updated.id + '`\nButtons: **' + updated.buttons.length + '**\n\nPreview the updated draft before publishing it. The existing published message stays unchanged until you publish again.');
        return;
      }

      if (action === 'preview') {
        const embed = buildCustomPanelEmbed(panel, guild.name, themeColor, true);
        await interaction.editReply({ embeds: [embed], components: buildCustomPanelComponents(panel, true) });
        return;
      }

      if (action === 'publish') {
        const channel = interaction.options.getChannel('channel', true);
        if (channel.type !== ChannelType.GuildText) throw new Error('Publish target must be a standard server text channel.');
        const targetChannel = channel as TextChannel;
        const oldChannelId = panel.publishedChannelId;
        const oldMessageId = panel.publishedMessageId;
        const payload = { embeds: [buildCustomPanelEmbed(panel, guild.name, themeColor)], components: buildCustomPanelComponents(panel, false) };
        // Preserve the last known-good public panel until the new publication
        // has a durable Neon snapshot and channel/message pointer.
        const message = await targetChannel.send(payload);
        try {
          panel = await markCustomPanelPublished(guild.id, panel.id, targetChannel.id, message.id);
        } catch (error) {
          await restoreCustomPanelPublication(guild.id, panel.id, panel).catch((restoreError) => {
            console.error('Failed to restore the last published panel pointer after a publish error:', restoreError);
          });
          await message.delete().catch(() => undefined);
          throw error;
        }
        let previousMessageRemoved = true;
        if (oldChannelId && oldMessageId && (oldChannelId !== targetChannel.id || oldMessageId !== message.id)) {
          try {
            const oldChannel = await guild.channels.fetch(oldChannelId);
            if (oldChannel?.type === ChannelType.GuildText) {
              const oldMessage = await oldChannel.messages.fetch(oldMessageId).catch((error) => {
                const code = (error as { code?: number }).code;
                if (code === 10008) return null;
                throw error;
              });
              if (oldMessage) await oldMessage.delete();
            }
          } catch (error) {
            previousMessageRemoved = false;
            console.warn('Custom panel was published, but its previous message could not be removed:', error);
          }
        }
        writePanelAudit('CUSTOM_PANEL_PUBLISHED', 'Published panel "' + panel.name + '" (' + panel.id + ') in channel ' + targetChannel.id + '.');
        await interaction.editReply('**Panel published**\n\n**' + panel.name + '** is live in <#' + targetChannel.id + '>.\nPanel ID: `' + panel.id + '`\nTicket buttons use the same validated ticket-creation flow as the default support panel.' + (previousMessageRemoved ? '' : '\n\n⚠️ The previous panel message could not be removed. Please delete that old message manually to avoid duplicate entry points.'));
        return;
      }

      if (action === 'delete') {
        if (interaction.options.getBoolean('confirm', true) !== true) {
          await interaction.editReply('No changes made. Set confirm to true to delete the panel definition and its published message.');
          return;
        }

        // Delete the durable definition first. If Neon rejects the write, the
        // existing public panel is left working. A later Discord cleanup error
        // may leave a stale message, but its buttons fail closed because the
        // definition is gone.
        const deleted = await deleteCustomPanelDefinition(guild.id, panel.id);
        let cleanupWarning = '';
        if (deleted.publishedChannelId && deleted.publishedMessageId) {
          try {
            const publishedChannel = await guild.channels.fetch(deleted.publishedChannelId).catch((error) => {
              const code = (error as { code?: number }).code;
              if (code === 10003) return null;
              throw error;
            });
            if (publishedChannel?.type === ChannelType.GuildText) {
              const publishedMessage = await publishedChannel.messages.fetch(deleted.publishedMessageId).catch((error) => {
                const code = (error as { code?: number }).code;
                if (code === 10008) return null;
                throw error;
              });
              if (publishedMessage) await publishedMessage.delete();
            }
          } catch (error) {
            cleanupWarning = '\\n\\n⚠️ The panel definition is deleted and its buttons are no longer functional, but the old Discord message could not be removed. Delete that message manually.';
            console.warn('Custom panel definition deleted but Discord message cleanup failed:', error);
          }
        }
        writePanelAudit('CUSTOM_PANEL_DELETED', 'Deleted panel "' + deleted.name + '" (' + deleted.id + '); tickets created from it were preserved.' + (cleanupWarning ? ' Discord message cleanup needs manual review.' : ''));
        await interaction.editReply('**Panel deleted**\\n\\nThe saved panel definition has been removed. Tickets previously created through its buttons remain untouched.' + cleanupWarning);
        return;
      }

      throw new Error('Unknown custom panel action.');
    }

    if (group === 'settings' || group === 'settings-reports') {
      await handleSettingsSlashCommand(interaction, {
        syncPanel,
        repair: async (targetGuild, mode) => {
          if (mode === 'storage') {
            await ensureClosedCategory(targetGuild);
            await ensureArchiveCategory(targetGuild);
            await refreshSettingsChannel(targetGuild);
            return 'Storage repair complete. Closed and Archive categories are ready.';
          }
          const result = await runSupportForgeRepair(targetGuild);
          return 'Normal infrastructure repair complete. Core channels and department categories have been checked. Recovered ' + result.recoveredTickets + ' missing durable ticket record(s).';
        },
        refresh: async (targetGuild) => {
          const supportCategory = await ensureContainer(targetGuild);
          await ensureSettingsChannel(targetGuild, supportCategory.id);
          await syncPanel(targetGuild);
          await refreshSettingsChannel(targetGuild);
        },
      });
      return;
    }

    // ─────────────────────────────────────────────
    // SETUP
    // ─────────────────────────────────────────────

    if (!group && (subcommand === 'setup' || subcommand === 'restore')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const restoreMode = subcommand === 'restore';
      const result = await runSupportForgeSetup(guild, restoreMode);
      let repairSummary = '';
      let deploymentSummary = '';
      if (restoreMode) {
        const repair = await runSupportForgeRepair(guild);
        repairSummary = '\n🧾 Missing ticket records recovered: **' + repair.recoveredTickets + '**.';
        const deployment = await requestGitHubDeployment().catch((error) => ({
          requested: false,
          reason: error instanceof Error ? error.message : 'GitHub deployment request failed.',
        }));
        deploymentSummary = '\n\n' + (deployment.requested
          ? '🚀 **Code deployment queued.** ' + deployment.reason
          : '⚠️ **Discord restore completed; code deployment was not queued.** ' + deployment.reason);
      }
      await interaction.editReply(
        (restoreMode ? '✅ **ResolvX restored successfully.**' : '✅ **ResolvX setup complete.**') +
        '\n\n📁 Container: <#' + result.supportCategoryId + '>\n' +
        '📂 Department categories: **' + result.departmentCount + '**\n' +
        (result.legacyOpenCategoryId ? '🟢 Legacy Open bucket: <#' + result.legacyOpenCategoryId + '>\n' : '') +
        '📋 Departments: **' + result.departmentCount + '**\n' +
        '🎫 Panel has been created/repaired and is ready.' + repairSummary + deploymentSummary
      );
      return;
    }

        // ─────────────────────────────────────────────
    // CATEGORY ADD
    // ─────────────────────────────────────────────

    if (
      group === 'category' &&
      subcommand === 'add'
    ) {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      const name =
        interaction.options
          .getString('name', true)
          .trim()
          .replace(/\s+/g, ' ');

      const role =
        interaction.options.getRole(
          'staff-role',
        );

      if (!name) {
        await interaction.editReply(
          '❌ Department name cannot be empty.',
        );

        return;
      }

      const config =
        await getGuildConfig(
          guild.id,
        );

      if (
        Object.values(
          config.departments,
        ).some(
          (department) =>
            department.name.toLowerCase() ===
            name.toLowerCase(),
        )
      ) {
        await interaction.editReply(
          '❌ A department with that name already exists.',
        );

        return;
      }

      if (
        role &&
        (role.managed ||
          role.id ===
            guild.roles.everyone.id)
      ) {
        await interaction.editReply(
          '❌ Choose a normal server role, not @everyone or a managed integration role.',
        );

        return;
      }

      const id =
        newDepartmentId();

      await updateGuildConfig(
        guild.id,
        (current) => {
          const now = new Date().toISOString();
          const tagId = newTagId();
          current.departments[id] = {
            id,
            name,
            staffRoleId:
              role?.id ?? null,
            categoryId: null,
            tags: {
              [tagId]: {
                id: tagId,
                name: 'General',
                createdAt: now,
              },
            },
            createdAt: now,
          };
        },
      );

      const supportCategory =
        await ensureContainer(
          guild,
        );

      await ensurePanelChannel(
        guild,
        supportCategory.id,
      );

      await syncPanel(guild);

      await interaction.editReply(
        `✅ Department **${name}** created${
          role
            ? ` for ${role}`
            : ''
        }. Its Discord category will be created when the first ticket is opened in this department.`,
      );

      void logSettingsEvent(
        guild,
        supportCategory.id,
        {
          action: 'DEPARTMENT_ADDED',
          actorId: interaction.user.id,
          actorName: interaction.user.tag,
          detail: 'Added department ' + name + '. Its Discord category will be provisioned when the first ticket is created.',
        },
      ).catch((error) => console.warn('⚠️ Category command audit failed:', error));
      return;
    }

    // ─────────────────────────────────────────────
    // CATEGORY LIST
    // ─────────────────────────────────────────────

    if (
      group === 'category' &&
      subcommand === 'list'
    ) {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      const config = await getGuildConfig(guild.id);
      const departments = Object.values(config.departments).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const lines = departments.flatMap((department) => {
        const header = '• **' + department.name + '** · ID: ' + department.id +
          ' · staff: ' + (department.staffRoleId ? '<@&' + department.staffRoleId + '>' : 'Administrators only');
        const tags = Object.values(department.tags ?? {}).map((tag) => tag.name);
        const tagLines: string[] = [];
        for (let index = 0; index < tags.length; index += 12) {
          tagLines.push('  Tags: ' + tags.slice(index, index + 12).join(', '));
        }
        return [header, ...(tagLines.length ? tagLines : ['  Tags: none'])];
      });
      const pages: string[] = [];
      let currentPage = '';
      for (const line of lines) {
        const candidate = currentPage ? currentPage + '\n' + line : line;
        if (currentPage && candidate.length > 1650) {
          pages.push(currentPage);
          currentPage = line;
        } else {
          currentPage = candidate;
        }
      }
      if (currentPage) pages.push(currentPage);
      if (!pages.length) pages.push('No departments configured.');
      const requestedPage = interaction.options.getInteger('page') ?? 1;
      if (requestedPage > pages.length) {
        await interaction.editReply(
          '❌ Page ' + requestedPage + ' does not exist. This server has ' + pages.length +
          ' department page(s). Use /supportforge category list page:1 to start.',
        );
        return;
      }
      await interaction.editReply(
        '**ResolvX Departments · Page ' + requestedPage + ' / ' + pages.length + '**\n\n' +
        pages[requestedPage - 1],
      );
      return;
    }

    // CATEGORY REMOVE
    // ─────────────────────────────────────────────

    if (
      group === 'category' &&
      subcommand === 'remove'
    ) {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      const name =
        interaction.options
          .getString('name', true)
          .trim()
          .toLowerCase();

      const config =
        await getGuildConfig(
          guild.id,
        );

      const department =
        Object.values(
          config.departments,
        ).find(
          (item) =>
            item.name.toLowerCase() ===
            name,
        );

      if (!department) {
        await interaction.editReply(
          '❌ Department not found.',
        );

        return;
      }

      const activeTickets: TextChannel[] = [];

      for (const channel of guild.channels.cache.values()) {
        if (
          channel.type !== ChannelType.GuildText ||
          !channel.topic?.startsWith(TICKET_PREFIX) ||
          getField(channel.topic, 'department') !== department.id
        ) {
          continue;
        }

        const status =
          (await getPersistedTicketStatus(channel.id)) ??
          getTicketStatus(channel.topic);

        if (isActiveTicketStatus(status)) {
          activeTickets.push(channel);
        }
      }

      if (
        activeTickets.length > 0
      ) {
        await interaction.editReply(
          `❌ Cannot remove **${department.name}** while it has **${activeTickets.length}** active ticket(s).`,
        );

        return;
      }

      await updateGuildConfig(
        guild.id,
        (current) => {
          const currentDepartment = current.departments[department.id];

          if (currentDepartment?.categoryId) {
            current.retiredCategoryIds = Array.from(new Set([
              ...(current.retiredCategoryIds ?? []),
              currentDepartment.categoryId,
            ]));
          }

          delete current.departments[
            department.id
          ];
        },
      );

      await syncPanel(guild);

      await interaction.editReply(
        `✅ Department **${department.name}** removed. Its Discord category was retained.`,
      );

      if (config.supportCategoryId) {
        void logSettingsEvent(
          guild,
          config.supportCategoryId,
          {
            action: 'DEPARTMENT_REMOVED',
            actorId: interaction.user.id,
            actorName: interaction.user.tag,
            detail: 'Removed department ' + department.name + '. Its Discord category was retained.',
          },
        ).catch((error) => console.warn('⚠️ Category removal audit failed:', error));
      }

      return;
    }

    // ─────────────────────────────────────────────
    // PREMIUM STATUS
    // ─────────────────────────────────────────────

    if (
      group === 'premium' &&
      subcommand === 'status'
    ) {
      const tier =
        await getTier(guild.id);

      await interaction.reply({
        content:
          `📦 **Current tier:** ${tierLabel(
            tier,
          )}\n\n` +
          `Premium/Pro are currently demo entitlements persisted locally, not real billing.`,
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    // ─────────────────────────────────────────────
    // PREMIUM DEMO TOGGLE
    // ─────────────────────────────────────────────

    if (
      group === 'premium' &&
      subcommand === 'toggle-demo'
    ) {
      const current =
        await getTier(guild.id);

      const next: SupportForgeTier =
        current === 'free'
          ? 'premium-demo'
          : current ===
              'premium-demo'
            ? 'pro-demo'
            : 'free';

      await setTier(
        guild.id,
        next,
      );

      await interaction.reply({
        content:
          `🔁 Tier changed: **${tierLabel(
            current,
          )}** → **${tierLabel(
            next,
          )}**.`,
        flags: MessageFlags.Ephemeral,
      });

      const premiumConfig = await getGuildConfig(guild.id);
      if (premiumConfig.supportCategoryId) {
        void logSettingsEvent(
          guild,
          premiumConfig.supportCategoryId,
          {
            action: 'TIER_CHANGED',
            actorId: interaction.user.id,
            actorName: interaction.user.tag,
            detail:
              'Tier changed from ' +
              tierLabel(current) +
              ' to ' +
              tierLabel(next) +
              '.',
          },
        ).catch(() => undefined);
      }

      return;
    }

    // ─────────────────────────────────────────────
    // VERSIONED TICKET FORMS
    // ─────────────────────────────────────────────

    if (group === 'form') {
      const canManageForms = Boolean(
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
      );
      if (!canManageForms) {
        await interaction.reply({
          content: 'Only server administrators or members with Manage Server can manage ticket forms and templates.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const action = interaction.options.getSubcommand();
      const actorId = interaction.user.id;
      const config = await getGuildConfig(guild.id);

      const writeFormAudit = (event: string, detail: string): void => {
        if (!config.supportCategoryId) return;
        void logSettingsEvent(guild, config.supportCategoryId, {
          action: event,
          actorId,
          actorName: interaction.user.tag,
          detail,
        }).catch((error) => console.warn('Ticket form audit logging failed:', error));
      };

      if (action === 'list') {
        const forms = await listTicketForms(guild.id);
        const formLines = forms.map((form) =>
          '• **' + form.name + '** · ID `' + form.id + '` · v' + form.version +
          ' · ' + (form.active ? 'ACTIVE' : 'inactive') +
          ' · department `' + form.departmentId + '` · tag `' + (form.tagId ?? '*') +
          '` · ' + form.fields.length + ' field(s)',
        );
        const mappingLines = Object.values(config.departments).flatMap((department) => [
          '**' + department.name + '** · department ID `' + department.id + '`',
          ...Object.values(department.tags ?? {}).map((tag) =>
            '  • ' + tag.name + ' · tag ID `' + tag.id + '`',
          ),
        ]);

        // Paginate at line boundaries so department and tag identifiers are
        // never silently truncated from a Discord response.
        const allLines: string[] = ['**Ticket Forms**'];
        allLines.push(...(formLines.length ? formLines : ['No forms configured yet.']));
        allLines.push('', '**Available routing IDs**');
        allLines.push(...(mappingLines.length ? mappingLines : ['No departments are configured. Create a department first.']));

        const pages: string[] = [];
        let currentPage = '';
        for (const line of allLines) {
          const next = currentPage ? currentPage + '\n' + line : line;
          if (next.length > 1_650 && currentPage) {
            pages.push(currentPage);
            currentPage = line;
          } else {
            currentPage = next;
          }
        }
        if (currentPage) pages.push(currentPage);

        const requestedPage = interaction.options.getInteger('page') ?? 1;
        if (requestedPage > pages.length) {
          await interaction.editReply('❌ Page ' + requestedPage + ' does not exist. This list has ' + pages.length + ' page(s). Use `/supportforge form list page:1` to start.');
          return;
        }
        await interaction.editReply('**Ticket Form List • Page ' + requestedPage + ' / ' + pages.length + '**\n\n' + pages[requestedPage - 1]);
        return;
      }

      if (action === 'guide') {
        await interaction.editReply(
          '**Ticket Form Field Schema Guide**\n\n' +
          'Every field needs a unique lowercase id, a label, a supported type, and required set to true or false. Each step can contain at most three custom fields.\n\n' +
          'JSON example:\n{\n  "fields": [\n    {\n      "id": "order_id",\n      "label": "Order ID",\n      "type": "short_text",\n      "required": true,\n      "placeholder": "Enter your order ID"\n    }\n  ]\n}\n\n' +
          '**Supported types:** short_text, long_text, number, decimal, url, email, date, dropdown, multi_select, checkbox, discord_user, discord_role, attachment.\n\n' +
          'Choice-based fields can include a choices string array. The service validates field IDs, types, choices, limits, conditions, and routing mappings before saving.'
        );
        return;
      }

      if (action === 'show') {
        const formId = interaction.options.getString('id', true).trim();
        const form = (await listTicketForms(guild.id)).find((item) => item.id === formId);
        if (!form) {
          await interaction.editReply('Ticket form not found in this server. Use /supportforge form list to find its ID.');
          return;
        }
        const fields = form.fields.slice(0, 12).map((field, index) =>
          (index + 1) + '. **' + field.label + '** · ' + field.id + ' · ' + field.type + ' · ' +
          (field.required ? 'required' : 'optional') + ' · step ' + field.step
        );
        if (form.fields.length > 12) fields.push('…and ' + (form.fields.length - 12) + ' more field(s).');
        await interaction.editReply(
          '**' + form.name + '**\n' +
          'ID: ' + form.id + '\nVersion: **' + form.version + '** · Status: **' + (form.active ? 'ACTIVE' : 'Inactive') + '**\n' +
          'Department ID: ' + form.departmentId + ' · Tag ID: ' + (form.tagId ?? '*') + '\n\n' +
          '**Current fields (' + form.fields.length + '):**\n' + (fields.length ? fields.join('\n') : 'No fields configured.') +
          '\n\nUse /supportforge form schema to inspect the complete JSON schema.'
        );
        return;
      }

      if (action === 'schema') {
        const formId = interaction.options.getString('id', true).trim();
        const form = (await listTicketForms(guild.id)).find((item) => item.id === formId);
        if (!form) {
          await interaction.editReply('Ticket form not found in this server. Use /supportforge form list to find its ID.');
          return;
        }
        const schema = JSON.stringify({ fields: form.fields }, null, 2);
        const pageLength = 1450;
        const pageCount = Math.max(1, Math.ceil(schema.length / pageLength));
        const requestedPage = interaction.options.getInteger('page') ?? 1;
        if (requestedPage > pageCount) {
          await interaction.editReply('Schema page ' + requestedPage + ' does not exist. This schema has ' + pageCount + ' page(s). Use /supportforge form schema id:' + formId + ' page:1 to start.');
          return;
        }
        const chunk = schema.slice((requestedPage - 1) * pageLength, requestedPage * pageLength);
        await interaction.editReply(
          '**Schema for ' + form.name + ' · Page ' + requestedPage + ' / ' + pageCount + '**\n' +
          'Form ID: ' + form.id + ' · Version: **' + form.version + '** · Status: **' + (form.active ? 'ACTIVE' : 'Inactive') + '**\n' +
          'Copy the JSON chunks from each page in order to reconstruct the complete schema.\n\n' + chunk
        );
        return;
      }

      if (action === 'template-show') {
        const templateId = interaction.options.getString('template-id', true).trim();
        const template = (await listTicketFormTemplates(guild.id)).find((item) => item.id === templateId);
        if (!template) {
          await interaction.editReply('Template not found in this server. Use /supportforge form template-list to find its ID.');
          return;
        }
        const fields = template.fields.slice(0, 12).map((field, index) =>
          (index + 1) + '. **' + field.label + '** · ' + field.id + ' · ' + field.type
        );
        if (template.fields.length > 12) fields.push('…and ' + (template.fields.length - 12) + ' more field(s).');
        await interaction.editReply(
          '**Template: ' + template.name + '**\nID: ' + template.id + '\nFields: **' + template.fields.length + '**\n\n' +
          (fields.length ? fields.join('\n') : 'No fields in this template.') +
          '\n\nUse /supportforge form template-apply to create a form from this template. Deleting the template will not alter forms already created.'
        );
        return;
      }

      if (action === 'quick-create') {
        const name = interaction.options.getString('name', true).trim();
        const departmentId = interaction.options.getString('department-id', true).trim();
        const suppliedTagId = interaction.options.getString('tag-id', true).trim();
        const tagId = suppliedTagId === '*' ? null : suppliedTagId;
        const questions = [
          interaction.options.getString('question-one', true),
          interaction.options.getString('question-two') ?? '',
        ];
        const form = await createTicketForm({
          guildId: guild.id,
          name,
          departmentId,
          tagId,
          fields: buildQuickTicketFormFields(questions),
          actorId,
        });
        await interaction.editReply(
          '✅ Created inactive guided form **' + form.name + '** with ' + form.fields.length +
          ' question(s). ID: `' + form.id + '`, version ' + form.version +
          '. Activate it when the department/tag mapping is ready. Use the advanced builder for dropdowns, attachments, conditions, and custom validation.',
        );
        writeFormAudit('TICKET_FORM_CREATED', 'Created guided form ' + form.id + ' version 1 for department ' + departmentId + ' and tag ' + (tagId ?? '*') + '.');
        return;
      }

      if (action === 'create') {
        const name = interaction.options.getString('name', true);
        const departmentId = interaction.options.getString('department-id', true);
        const suppliedTagId = interaction.options.getString('tag-id', true).trim();
        const tagId = suppliedTagId === '*' ? null : suppliedTagId;
        const fields = parseTicketFormFields(interaction.options.getString('fields-json', true));
        const form = await createTicketForm({
          guildId: guild.id,
          name,
          departmentId,
          tagId,
          fields,
          actorId,
        });
        await interaction.editReply(
          '✅ Created inactive form **' + form.name + '**. ID: `' + form.id +
          '`, version 1. Activate it with `/supportforge form activate id:' + form.id + '`. ' +
          'The form applies only to the selected existing department/tag mapping.',
        );
        writeFormAudit('TICKET_FORM_CREATED', 'Created form ' + form.id + ' version 1 for department ' + departmentId + ' and tag ' + (tagId ?? '*') + '.');
        return;
      }

      if (action === 'template-save') {
        const template = await createTicketFormTemplate({
          guildId: guild.id,
          name: interaction.options.getString('name', true),
          fields: parseTicketFormFields(interaction.options.getString('fields-json', true)),
          actorId,
        });
        await interaction.editReply(
          '✅ Saved template **' + template.name + '**. ID: `' + template.id +
          '`, with ' + template.fields.length + ' custom field(s). Use `/supportforge form template-apply` to create a form from it.',
        );
        writeFormAudit('TICKET_FORM_TEMPLATE_SAVED', 'Saved template ' + template.id + ' with ' + template.fields.length + ' field(s).');
        return;
      }

      if (action === 'template-list') {
        const templates = await listTicketFormTemplates(guild.id);
        const lines = templates.map((template) =>
          '• **' + template.name + '** · ID `' + template.id + '` · ' + template.fields.length + ' field(s)',
        );
        const pages: string[] = [];
        let pageText = '';
        for (const line of (lines.length ? lines : ['No form templates saved yet.'])) {
          const next = pageText ? pageText + '\n' + line : line;
          if (next.length > 1_650 && pageText) {
            pages.push(pageText);
            pageText = line;
          } else {
            pageText = next;
          }
        }
        if (pageText) pages.push(pageText);
        const requestedPage = interaction.options.getInteger('page') ?? 1;
        if (requestedPage > pages.length) {
          await interaction.editReply('❌ Page ' + requestedPage + ' does not exist. This template list has ' + pages.length + ' page(s).');
          return;
        }
        await interaction.editReply(
          '**Form Templates • Page ' + requestedPage + ' / ' + pages.length + '**\n\n' + pages[requestedPage - 1],
        );
        return;
      }

      if (action === 'template-apply') {
        const templateId = interaction.options.getString('template-id', true).trim();
        const name = interaction.options.getString('name', true);
        const departmentId = interaction.options.getString('department-id', true);
        const suppliedTagId = interaction.options.getString('tag-id', true).trim();
        const tagId = suppliedTagId === '*' ? null : suppliedTagId;
        const form = await applyTicketFormTemplate({
          guildId: guild.id,
          templateId,
          name,
          departmentId,
          tagId,
          actorId,
        });
        await interaction.editReply(
          '✅ Created inactive form **' + form.name + '** from template `' + templateId +
          '`. New form ID: `' + form.id + '`, version ' + form.version +
          '. Activate it when its routing is ready.',
        );
        writeFormAudit('TICKET_FORM_TEMPLATE_APPLIED', 'Applied template ' + templateId + ' to form ' + form.id + '.');
        return;
      }

      if (action === 'template-delete') {
        const templateId = interaction.options.getString('template-id', true).trim();
        await deleteTicketFormTemplate(guild.id, templateId);
        await interaction.editReply('✅ Deleted template `' + templateId + '`. Existing forms and historical submissions are unchanged.');
        writeFormAudit('TICKET_FORM_TEMPLATE_DELETED', 'Deleted template ' + templateId + '.');
        return;
      }

      const formId = interaction.options.getString('id', true).trim();
      if (action === 'update') {
        const fields = parseTicketFormFields(interaction.options.getString('fields-json', true));
        const form = await updateTicketFormFields({
          guildId: guild.id,
          formId,
          fields,
          actorId,
        });
        await interaction.editReply(
          '✅ Updated **' + form.name + '** to version ' + form.version +
          '. Earlier versions and submissions remain retained unchanged.',
        );
        writeFormAudit('TICKET_FORM_VERSION_CREATED', 'Created version ' + form.version + ' of form ' + form.id + '.');
        return;
      }

      if (action === 'activate' || action === 'deactivate') {
        const active = action === 'activate';
        const form = await setTicketFormActive({ guildId: guild.id, formId, active });
        await interaction.editReply(
          (active ? '✅ Activated ' : '✅ Deactivated ') + '**' + form.name +
          '** (' + form.id + ', version ' + form.currentVersion + '). ' +
          (active ? 'New tickets routed to its mapping will use this form.' : 'Existing submissions and versions were preserved.'),
        );
        writeFormAudit(active ? 'TICKET_FORM_ACTIVATED' : 'TICKET_FORM_DEACTIVATED', (active ? 'Activated' : 'Deactivated') + ' form ' + form.id + ' version ' + form.currentVersion + '.');
        return;
      }

      await interaction.editReply('❌ Unsupported form action.');
      return;
    }

    // ─────────────────────────────────────────────
    // TICKET COMMANDS
    // ─────────────────────────────────────────────

    if (group === 'ticket') {
      await executeTicketCommand(
        interaction,
      );

      return;
    }

    await interaction.reply({
      content:
        '❌ Unsupported ResolvX command.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error(
      '❌ ResolvX command failed:',
      error,
    );

    if (
      interaction.deferred &&
      !interaction.replied
    ) {
      await interaction.editReply(
        '❌ Something went wrong while processing that command. Check the bot console for details.',
      );
    } else if (
      !interaction.replied
    ) {
      await interaction.reply({
        content:
          '❌ Something went wrong while processing that command.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

export {
  SUPPORT_CATEGORY_NAME,
  TRANSCRIPT_TOPIC,
  TICKET_PREFIX,
  ensureContainer,
  ensureTranscriptChannel,
};
