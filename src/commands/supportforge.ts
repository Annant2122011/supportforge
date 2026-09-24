
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type TextChannel,
} from 'discord.js';

import {
  getGuildConfig,
  getTier,
  newDepartmentId,
  setTier,
  tierLabel,
  updateGuildConfig,
  type DepartmentConfig,
  type SupportForgeTier,
} from '../services/configService';

import { executeTicketCommand } from '../interactions/ticketCommandTools';
import { getPersistedTicketStatus } from '../services/ticketPersistenceService';

import {
  getAdvancedSettings,
} from '../services/advancedSettingsService';

import {
  ensureArchiveCategory,
  ensureClosedCategory,
} from '../services/ticketStorageService';

import {
  ensureSettingsChannel,
  refreshSettingsChannel,
} from '../services/settingsChannelService';

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

async function buildPanelEmbed(
  guild: Guild,
  departments: DepartmentConfig[],
): Promise<EmbedBuilder> {
  const settings = await getAdvancedSettings(guild.id);
  const lines = departments.length
    ? departments.map((department) => `🎫 **${department.name}**`).join('\\n')
    : 'No ticket departments configured.';

  return new EmbedBuilder()
    .setTitle(settings.appearance.panelTitle)
    .setDescription(
      `Welcome to **${guild.name}** support.\\n\\n` +
        settings.appearance.panelDescription + '\\n\\n' +
        `${lines}\\n\\n` +
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
      'SupportForge bot member could not be resolved.',
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
      return channel;
    }
  }

  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildCategory &&
      channel.name.toLowerCase() ===
        SUPPORT_CATEGORY_NAME.toLowerCase(),
  );

  const category =
    existing?.type === ChannelType.GuildCategory
      ? existing
      : await guild.channels.create({
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

  await category.permissionOverwrites.edit(
    bot.id,
    {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: true,
      ManageMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
    },
  );

  await updateGuildConfig(
    guild.id,
    (config) => {
      config.supportCategoryId =
        category.id;
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
      'SupportForge bot member could not be resolved.',
    );
  }

  if (config.transcriptChannelId) {
    const saved = guild.channels.cache.get(
      config.transcriptChannelId,
    );

    if (
      saved?.type === ChannelType.GuildText
    ) {
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
    if (existing.parentId !== parentId) {
      await existing.setParent(parentId, {
        lockPermissions: false,
      });
    }

    await existing.permissionOverwrites.edit(
      guild.roles.everyone.id,
      {
        ViewChannel: false,
        SendMessages: false,
        ReadMessageHistory: false,
      },
    );

    await existing.permissionOverwrites.edit(
      bot.id,
      {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
      },
    );

    await updateGuildConfig(
      guild.id,
      (current) => {
        current.transcriptChannelId =
          existing.id;
      },
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
      ],
    });

  await updateGuildConfig(
    guild.id,
    (current) => {
      current.transcriptChannelId =
        channel.id;
    },
  );

  return channel;
}

async function ensurePanelChannel(
  guild: Guild,
  parentId: string,
): Promise<TextChannel> {
  const config =
    await getGuildConfig(guild.id);

  const bot = guild.members.me;

  if (!bot) {
    throw new Error(
      'SupportForge bot member could not be resolved.',
    );
  }

  if (config.panelChannelId) {
    const saved = guild.channels.cache.get(
      config.panelChannelId,
    );

    if (
      saved?.type === ChannelType.GuildText
    ) {
      return saved;
    }
  }

  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      (channel.topic?.startsWith(
        PANEL_TOPIC,
      ) ||
        channel.name === PANEL_CHANNEL_NAME),
  );

  if (
    existing?.type === ChannelType.GuildText
  ) {
    if (existing.parentId !== parentId) {
      await existing.setParent(parentId, {
        lockPermissions: false,
      });
    }

    await existing.permissionOverwrites.edit(
      guild.roles.everyone.id,
      {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: false,
      },
    );

    await existing.permissionOverwrites.edit(
      bot.id,
      {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        EmbedLinks: true,
      },
    );

    await existing.setTopic(
      `${PANEL_TOPIC} guild=${guild.id}`,
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

async function syncPanel(
  guild: Guild,
): Promise<void> {
  const config =
    await getGuildConfig(guild.id);

  const parent =
    await ensureContainer(guild);

  const panel =
    await ensurePanelChannel(
      guild,
      parent.id,
    );

  const departments = Object.values(
    config.departments,
  ).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const rows: ActionRowBuilder<ButtonBuilder>[] =
    [];

  for (
    let i = 0;
    i < departments.length;
    i += 5
  ) {
    const row =
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        departments
          .slice(i, i + 5)
          .map((department) =>
            categoryButton(
              department.id,
              department.name,
            ),
          ),
      );

    rows.push(row);
  }

  const embed = await buildPanelEmbed(
    guild,
    departments,
  );

  let message =
    config.panelMessageId
      ? await panel.messages
          .fetch(config.panelMessageId)
          .catch(() => null)
      : null;

  if (!message) {
    const existingBotMessage = (
      await panel.messages.fetch({
        limit: 50,
      })
    ).find(
      (candidate) =>
        candidate.author.id ===
          guild.client.user?.id &&
        candidate.embeds.some(
          (embed) =>
            embed.title ===
            '🎫 SupportForge Support Center',
        ),
    );

    message =
      existingBotMessage ?? null;
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

  await updateGuildConfig(
    guild.id,
    (current) => {
      current.panelChannelId =
        panel.id;
      current.panelMessageId =
        message.id;
    },
  );
}

export const data =
  new SlashCommandBuilder()
    .setName('supportforge')
    .setDescription(
      'Manage SupportForge and support tickets',
    )
    .setDMPermission(false)

    // ─────────────────────────────────────────────
    // SETUP
    // ─────────────────────────────────────────────

    .addSubcommand((subcommand) =>
      subcommand
        .setName('setup')
        .setDescription(
          'Create or repair the SupportForge system',
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
            .setDescription(
              'List configured ticket departments',
            ),
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
          'Tools for the current ticket',
        )

        // PRIORITY
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

        // TAG
        .addSubcommand((subcommand) =>
          subcommand
            .setName('tag')
            .setDescription(
              'Add a ticket tag',
            )
            .addStringOption((option) =>
              option
                .setName('name')
                .setDescription('Tag')
                .setRequired(true)
                .setMaxLength(30),
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
                .setMaxLength(500),
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
            .setDescription(
              'Move a pending ticket back to open',
            ),
        ),
    );

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

  // Administrative commands
  if (
    (!group && subcommand === 'setup') ||
    group === 'category' ||
    group === 'premium' ||
    group === 'settings'
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
    // ─────────────────────────────────────────────
    // SETUP
    // ─────────────────────────────────────────────

    if (
      !group &&
      subcommand === 'setup'
    ) {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      const supportCategory =
        await ensureContainer(guild);

      await ensureTranscriptChannel(
        guild,
        supportCategory.id,
      );

      await ensurePanelChannel(
        guild,
        supportCategory.id,
      );

      await ensureClosedCategory(guild);
      await ensureArchiveCategory(guild);
      await ensureSettingsChannel(guild, supportCategory.id);

      let config =
        await getGuildConfig(guild.id);

      if (
        Object.keys(
          config.departments,
        ).length === 0
      ) {
        const id =
          newDepartmentId();

        await updateGuildConfig(
          guild.id,
          (current) => {
            current.departments[id] = {
              id,
              name: 'General Support',
              staffRoleId: null,
              createdAt:
                new Date().toISOString(),
            };
          },
        );

        config =
          await getGuildConfig(
            guild.id,
          );
      }

      await syncPanel(guild);

      await interaction.editReply(
        `✅ **SupportForge setup complete.**\n\n` +
          `📁 Container: ${supportCategory}\n` +
          `📋 Departments: **${Object.keys(
            config.departments,
          ).length}**\n` +
          `🎫 Panel has been created/repaired and is ready.`,
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
          current.departments[id] = {
            id,
            name,
            staffRoleId:
              role?.id ?? null,
            createdAt:
              new Date().toISOString(),
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
        }.`,
      );

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

      const config =
        await getGuildConfig(
          guild.id,
        );

      const departments =
        Object.values(
          config.departments,
        ).sort((a, b) =>
          a.name.localeCompare(
            b.name,
          ),
        );

      const lines =
        departments.length
          ? departments
              .map(
                (department) =>
                  `• **${
                    department.name
                  }** — staff: ${
                    department.staffRoleId
                      ? `<@&${department.staffRoleId}>`
                      : 'Administrators only'
                  }`,
              )
              .join('\n')
          : 'No departments configured.';

      await interaction.editReply(
        `📂 **SupportForge departments**\n\n${lines}`,
      );

      return;
    }

    // ─────────────────────────────────────────────
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
          delete current.departments[
            department.id
          ];
        },
      );

      await syncPanel(guild);

      await interaction.editReply(
        `✅ Department **${department.name}** removed.`,
      );

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
        '❌ Unsupported SupportForge command.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error(
      '❌ SupportForge command failed:',
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
