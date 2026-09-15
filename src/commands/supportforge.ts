import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type Guild,
  type Role,
} from 'discord.js';

import {
  getGuildTier,
  isPremiumOrHigher,
  isProTier,
  premiumRequiredMessage,
  setGuildTier,
  tierLabel,
} from '../services/tierService';

import { logTicketEvent } from '../services/auditLogService';

const SUPPORT_FORGE_CATEGORY_NAME = 'Support Forge';
const TRANSCRIPT_CHANNEL_NAME = '📄 support-transcripts';
const PANEL_CHANNEL_NAME = 'support-panel';
const PANEL_TOPIC_PREFIX = 'supportforge:panel';
const TICKET_TOPIC_PREFIX = 'supportforge:ticket';

const TICKET_PRIORITIES = [
  'low',
  'normal',
  'high',
  'urgent',
  'critical',
] as const;

type TicketPriority = (typeof TICKET_PRIORITIES)[number];

const PRIORITY_EMOJI: Record<TicketPriority, string> = {
  low: '🟢',
  normal: '⚪',
  high: '🟠',
  urgent: '🔴',
  critical: '🟣',
};

function getTopicField(
  topic: string,
  key: string,
): string | undefined {
  const match = topic.match(
    new RegExp(`(?:^|\\s)${key}=([^\\s]+)`),
  );

  return match?.[1];
}

function setTopicField(
  topic: string,
  key: string,
  value: string,
): string {
  const pattern = new RegExp(`(?:^|\\s)${key}=[^\\s]+`);

  return pattern.test(topic)
    ? topic.replace(pattern, ` ${key}=${value}`)
    : `${topic} ${key}=${value}`;
}

function cleanCategoryName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 90);
}

function findSupportForgeCategory(
  guild: Guild,
): CategoryChannel | undefined {
  return guild.channels.cache.find(
    (channel): channel is CategoryChannel =>
      channel.type === ChannelType.GuildCategory &&
      channel.name.toLowerCase() ===
        SUPPORT_FORGE_CATEGORY_NAME.toLowerCase(),
  );
}

/**
 * A "logical" category is a department (General Support, Billing,
 * etc.) — distinct from the physical "Support Forge" container that
 * every ticket channel actually lives under. The logical category
 * carries the department's staff-role permission overwrite; the
 * physical container just keeps all ticket channels grouped together
 * in the channel list.
 */
function findLogicalCategory(
  guild: Guild,
  name: string,
): CategoryChannel | undefined {
  return guild.channels.cache.find(
    (channel): channel is CategoryChannel =>
      channel.type === ChannelType.GuildCategory &&
      channel.name.toLowerCase() === name.toLowerCase(),
  );
}

const DEFAULT_DEPARTMENT_NAME = 'General Support';

/**
 * Ensures a default logical department exists so the main panel's
 * ticket button has somewhere to look up a staff role from, distinct
 * from the physical Support Forge container.
 */
async function ensureDefaultLogicalCategory(
  guild: Guild,
): Promise<CategoryChannel> {
  const existing = findLogicalCategory(
    guild,
    DEFAULT_DEPARTMENT_NAME,
  );

  if (existing) {
    return existing;
  }

  const botMember = guild.members.me;

  if (!botMember) {
    throw new Error(
      'Could not find SupportForge bot member.',
    );
  }

  return guild.channels.create({
    name: DEFAULT_DEPARTMENT_NAME,
    type: ChannelType.GuildCategory,

    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ],
  });
}

function findTranscriptChannel(guild: Guild) {
  return guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.name === TRANSCRIPT_CHANNEL_NAME,
  );
}

function findPanelChannel(guild: Guild) {
  return guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      (
        channel.topic?.startsWith(PANEL_TOPIC_PREFIX) ||
        channel.name === PANEL_CHANNEL_NAME
      ),
  );
}

function createTicketButton(
  parentCategoryId: string,
) {
  return new ButtonBuilder()
    .setCustomId(
      `ticket:create:${parentCategoryId}`,
    )
    .setLabel('Create Ticket')
    .setEmoji('🎫')
    .setStyle(ButtonStyle.Primary);
}

function createCategoryButton(
  categoryId: string,
  label: string,
) {
  return new ButtonBuilder()
    .setCustomId(
      `ticket:create:${categoryId}`,
    )
    .setLabel(label.slice(0, 80))
    .setEmoji('🎫')
    .setStyle(ButtonStyle.Primary);
}

function createPanelEmbed(
  categoryName: string,
  staffRole?: Role | null,
) {
  const staffText = staffRole
    ? `\n\n👥 **Support team:** ${staffRole}`
    : '';

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎫 SupportForge')
    .setDescription(
      `Need help? Create a private support ticket below.\n\n` +
        `📂 **Ticket type:** ${categoryName}\n` +
        `🔒 Your ticket will only be visible to you and the support team.` +
        staffText,
    )
    .setFooter({
      text:
        'SupportForge • Support Ticket System',
    })
    .setTimestamp();
}

/**
 * Creates or fixes the main Support Forge category.
 *
 * The category itself is public because the panel lives inside it.
 * Individual private channels override this permission.
 */
async function ensureSupportForgeCategory(
  guild: Guild,
): Promise<CategoryChannel> {
  let category =
    findSupportForgeCategory(guild);

  const botMember =
    guild.members.me;

  if (!botMember) {
    throw new Error(
      'Could not find SupportForge bot member.',
    );
  }

  if (!category) {
    category =
      await guild.channels.create({
        name:
          SUPPORT_FORGE_CATEGORY_NAME,

        type:
          ChannelType.GuildCategory,

        permissionOverwrites: [
          {
            id:
              guild.roles.everyone.id,

            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
            ],

            deny: [
              PermissionFlagsBits.SendMessages,
            ],
          },

          {
            id:
              botMember.id,

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

    return category;
  }

  /*
   * Make the main category public.
   *
   * Private ticket/transcript channels have their own
   * permission overwrites and therefore remain private.
   */
  await category.permissionOverwrites.edit(
    guild.roles.everyone.id,
    {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
    },
  );

  await category.permissionOverwrites.edit(
    botMember.id,
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

  return category;
}

/**
 * Creates or moves the transcript channel into Support Forge.
 *
 * The transcript channel remains private even though the parent
 * category is public.
 */
async function ensureTranscriptChannel(
  guild: Guild,
  parentCategoryId: string,
) {
  const existing =
    findTranscriptChannel(guild);

  const botMember =
    guild.members.me;

  if (!botMember) {
    throw new Error(
      'Could not find SupportForge bot member.',
    );
  }

  if (
    existing &&
    existing.type === ChannelType.GuildText
  ) {
    if (
      existing.parentId !==
      parentCategoryId
    ) {
      await existing.setParent(
        parentCategoryId,
        {
          lockPermissions: false,
        },
      );
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
      botMember.id,
      {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
      },
    );

    return existing;
  }

  return guild.channels.create({
    name:
      TRANSCRIPT_CHANNEL_NAME,

    type:
      ChannelType.GuildText,

    parent:
      parentCategoryId,

    topic:
      'SupportForge ticket transcripts. ' +
      'Do not delete this channel.',

    permissionOverwrites: [
      {
        id:
          guild.roles.everyone.id,

        deny: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },

      {
        id:
          botMember.id,

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
}

/**
 * Creates or moves the public support panel into Support Forge.
 */
async function ensurePanelChannel(
  guild: Guild,
  parentCategoryId: string,
) {
  const existing =
    findPanelChannel(guild);

  const botMember =
    guild.members.me;

  if (!botMember) {
    throw new Error(
      'Could not find SupportForge bot member.',
    );
  }

  if (
    existing &&
    existing.type === ChannelType.GuildText
  ) {
    if (
      existing.parentId !==
      parentCategoryId
    ) {
      await existing.setParent(
        parentCategoryId,
        {
          lockPermissions: false,
        },
      );
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
      botMember.id,
      {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        EmbedLinks: true,
      },
    );

    await existing.setTopic(
      `${PANEL_TOPIC_PREFIX} ` +
      `parent=${parentCategoryId}`,
    );

    return existing;
  }

  return guild.channels.create({
    name:
      PANEL_CHANNEL_NAME,

    type:
      ChannelType.GuildText,

    parent:
      parentCategoryId,

    topic:
      `${PANEL_TOPIC_PREFIX} ` +
      `parent=${parentCategoryId}`,

    permissionOverwrites: [
      {
        id:
          guild.roles.everyone.id,

        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
        ],

        deny: [
          PermissionFlagsBits.SendMessages,
        ],
      },

      {
        id:
          botMember.id,

        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
    ],
  });
}

/**
 * Fixes old SupportForge ticket channels by moving them
 * into the new Support Forge category.
 */
async function migrateExistingTickets(
  guild: Guild,
  parentCategoryId: string,
) {
  const tickets =
    guild.channels.cache.filter(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        channel.topic?.startsWith(
          TICKET_TOPIC_PREFIX,
        ) &&
        channel.id !== parentCategoryId,
    );

  for (const channel of tickets.values()) {
    if (
      channel.parentId ===
      parentCategoryId
    ) {
      continue;
    }

    try {
      if (
  channel.type === ChannelType.GuildText ||
  channel.type === ChannelType.GuildAnnouncement ||
  channel.type === ChannelType.GuildVoice ||
  channel.type === ChannelType.GuildStageVoice
) {
  await channel.setParent(
    parentCategoryId,
    {
      /*
       * Keep the ticket's existing private
       * permission overwrites.
       */
      lockPermissions: false,
    },
  );
}

      console.log(
        `✅ Migrated ticket channel ${channel.name} into ${SUPPORT_FORGE_CATEGORY_NAME}.`,
      );
    } catch (error) {
      console.error(
        `❌ Failed to migrate ticket ${channel.name}:`,
        error,
      );
    }
  }
}

async function findExistingPanelMessage(
  panelChannel: Extract<
    ReturnType<typeof findPanelChannel>,
    any
  >,
) {
  if (
    !panelChannel ||
    panelChannel.type !== ChannelType.GuildText
  ) {
    return undefined;
  }

  const messages = await panelChannel.messages.fetch({
    limit: 50,
  });

  return messages.find(
    (message) =>
      message.author.id ===
        panelChannel.client.user.id &&
      (message.embeds.some(
        (embed) => embed.title === '🎫 SupportForge',
      ) ||
        message.content.includes('SupportForge')),
  );
}

async function ensurePanelMessage(
  panelChannel: Extract<
    ReturnType<typeof findPanelChannel>,
    any
  >,
  category: CategoryChannel,
) {
  if (
    !panelChannel ||
    panelChannel.type !== ChannelType.GuildText
  ) {
    return;
  }

  const existingPanelMessage =
    await findExistingPanelMessage(panelChannel);

  const panelEmbed = createPanelEmbed(category.name);
  const panelButton = createTicketButton(category.id);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    panelButton,
  );

  if (existingPanelMessage) {
    await existingPanelMessage.edit({
      embeds: [panelEmbed],
      components: [row],
    });

    return;
  }

  await panelChannel.send({
    embeds: [panelEmbed],
    components: [row],
  });
}

/**
 * Posts a dedicated panel message for one department into the
 * shared panel channel, alongside the main panel message.
 */
async function sendCategoryPanel(
  panelChannel: Extract<
    ReturnType<typeof findPanelChannel>,
    any
  >,
  category: CategoryChannel,
  staffRole?: Role | null,
) {
  if (
    !panelChannel ||
    panelChannel.type !== ChannelType.GuildText
  ) {
    return;
  }

  const embed = createPanelEmbed(category.name, staffRole);
  const button = createCategoryButton(category.id, category.name);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button,
  );

  await panelChannel.send({
    embeds: [embed],
    components: [row],
  });
}

export const data =
  new SlashCommandBuilder()
    .setName('supportforge')
    .setDescription(
      'Manage the SupportForge ticket system',
    )
    .setDMPermission(false)
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild.toString(),
    )

    // ========================================================
    // /supportforge setup
    // ========================================================

    .addSubcommand(
      (subcommand) =>
        subcommand
          .setName('setup')
          .setDescription(
            'Set up the SupportForge ticket system',
          ),
    )

    // ========================================================
    // Existing category command retained.
    // ========================================================

    .addSubcommandGroup(
      (group) =>
        group
          .setName('category')
          .setDescription(
            'Manage SupportForge ticket categories',
          )

          .addSubcommand(
            (subcommand) =>
              subcommand
                .setName('add')
                .setDescription(
                  'Create a new ticket category',
                )

                .addStringOption(
                  (option) =>
                    option
                      .setName('name')
                      .setDescription(
                        'Name of the ticket category',
                      )
                      .setRequired(true)
                      .setMaxLength(90),
                )

                .addRoleOption(
                  (option) =>
                    option
                      .setName('staff-role')
                      .setDescription(
                        'Role that should handle tickets in this category',
                      )
                      .setRequired(false),
                ),
          ),
    )

    // ========================================================
    // /supportforge premium (demo tier switch)
    // ========================================================

    .addSubcommandGroup(
      (group) =>
        group
          .setName('premium')
          .setDescription(
            'Preview SupportForge Premium/Pro features (demo — no billing)',
          )

          .addSubcommand(
            (subcommand) =>
              subcommand
                .setName('status')
                .setDescription(
                  "Show this server's current SupportForge tier",
                ),
          )

          .addSubcommand(
            (subcommand) =>
              subcommand
                .setName('toggle-demo')
                .setDescription(
                  'Cycle this server between Free / Premium (Demo) / Pro (Demo)',
                ),
          ),
    )

    // ========================================================
    // /supportforge ticket (used inside a ticket channel)
    // ========================================================

    .addSubcommandGroup(
      (group) =>
        group
          .setName('ticket')
          .setDescription(
            'Ticket tools — run inside a ticket channel',
          )

          .addSubcommand(
            (subcommand) =>
              subcommand
                .setName('priority')
                .setDescription(
                  'Set this ticket\'s priority (Premium)',
                )

                .addStringOption(
                  (option) =>
                    option
                      .setName('level')
                      .setDescription(
                        'Priority level',
                      )
                      .setRequired(true)
                      .addChoices(
                        ...TICKET_PRIORITIES.map(
                          (level) => ({
                            name: level,
                            value: level,
                          }),
                        ),
                      ),
                ),
          )

          .addSubcommand(
            (subcommand) =>
              subcommand
                .setName('tag')
                .setDescription(
                  'Add a tag to this ticket (Premium)',
                )

                .addStringOption(
                  (option) =>
                    option
                      .setName('name')
                      .setDescription('Tag name')
                      .setRequired(true)
                      .setMaxLength(30),
                ),
          )

          .addSubcommand(
            (subcommand) =>
              subcommand
                .setName('note')
                .setDescription(
                  'Add an internal staff-only note to this ticket (Premium)',
                )

                .addStringOption(
                  (option) =>
                    option
                      .setName('text')
                      .setDescription('Note content')
                      .setRequired(true)
                      .setMaxLength(500),
                ),
          )

          .addSubcommand(
            (subcommand) =>
              subcommand
                .setName('add-user')
                .setDescription(
                  'Give another user access to this ticket',
                )

                .addUserOption(
                  (option) =>
                    option
                      .setName('user')
                      .setDescription('User to add')
                      .setRequired(true),
                ),
          )

          .addSubcommand(
            (subcommand) =>
              subcommand
                .setName('remove-user')
                .setDescription(
                  'Remove a previously added user from this ticket',
                )

                .addUserOption(
                  (option) =>
                    option
                      .setName('user')
                      .setDescription('User to remove')
                      .setRequired(true),
                ),
          ),
    );

export async function execute(
  interaction: ChatInputCommandInteraction,
) {
  // ==========================================================
  // SERVER CHECK
  // ==========================================================

  if (!interaction.guild) {
    await interaction.reply({
      content:
        '❌ This command can only be used inside a server.',
      ephemeral: true,
    });

    return;
  }

  const guild =
    interaction.guild;

  // ==========================================================
  // USER PERMISSIONS
  // ==========================================================

  const member =
    await guild.members.fetch(
      interaction.user.id,
    );

  const isAdministrator =
    member.permissions.has(
      PermissionFlagsBits.Administrator,
    );

  const canManageGuild =
    member.permissions.has(
      PermissionFlagsBits.ManageGuild,
    );

  if (
    !isAdministrator &&
    !canManageGuild
  ) {
    await interaction.reply({
      content:
        '❌ You need the **Manage Server** permission to use SupportForge setup commands.',
      ephemeral: true,
    });

    return;
  }

  // ==========================================================
  // BOT PERMISSIONS
  // ==========================================================

  const botMember =
    guild.members.me;

  if (!botMember) {
    await interaction.reply({
      content:
        '❌ I could not verify my server permissions.',
      ephemeral: true,
    });

    return;
  }

  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ];

  const missingPermissions =
    requiredPermissions.filter(
      (permission) =>
        !botMember.permissions.has(
          permission,
        ),
    );

  if (
    missingPermissions.length > 0
  ) {
    await interaction.reply({
      content:
        '❌ I am missing required permissions.\n\n' +
        'Please make sure SupportForge has:\n' +
        '• View Channels\n' +
        '• Send Messages\n' +
        '• Read Message History\n' +
        '• Manage Channels\n' +
        '• Manage Messages\n' +
        '• Embed Links\n' +
        '• Attach Files',

      ephemeral: true,
    });

    return;
  }

  const subcommand =
    interaction.options.getSubcommand();

  const subcommandGroup =
    interaction.options.getSubcommandGroup(
      false,
    );

  // ==========================================================
  // /supportforge setup
  // ==========================================================

  if (
    !subcommandGroup &&
    subcommand === 'setup'
  ) {
    await interaction.deferReply({
      ephemeral: true,
    });

    try {
      // --------------------------------------------------------
      // MAIN SUPPORT FORGE CATEGORY
      // --------------------------------------------------------

      const supportForgeCategory =
        await ensureSupportForgeCategory(
          guild,
        );

      // --------------------------------------------------------
      // PRIVATE TRANSCRIPT CHANNEL
      // --------------------------------------------------------

      const transcriptChannel =
        await ensureTranscriptChannel(
          guild,
          supportForgeCategory.id,
        );

      // --------------------------------------------------------
      // PUBLIC SUPPORT PANEL
      // --------------------------------------------------------

      const panelChannel =
        await ensurePanelChannel(
          guild,
          supportForgeCategory.id,
        );

      // --------------------------------------------------------
      // DEFAULT DEPARTMENT
      // --------------------------------------------------------

      const defaultCategory =
        await ensureDefaultLogicalCategory(
          guild,
        );

      // --------------------------------------------------------
      // MOVE EXISTING TICKETS
      // --------------------------------------------------------

      await migrateExistingTickets(
        guild,
        supportForgeCategory.id,
      );

      // --------------------------------------------------------
      // CREATE / UPDATE PANEL MESSAGE
      // --------------------------------------------------------

      await ensurePanelMessage(
        panelChannel,
        defaultCategory,
      );

      // --------------------------------------------------------
      // FINAL RESPONSE
      // --------------------------------------------------------

      await interaction.editReply({
        content:
          '✅ **SupportForge setup completed!**\n\n' +

          `📁 **Main category:** ${supportForgeCategory}\n` +

          `🌐 **Public panel:** ${panelChannel}\n` +

          `🔒 **Private transcript channel:** ${transcriptChannel}\n\n` +

          `📂 **Default department:** ${defaultCategory}\n\n` +

          '🎫 All SupportForge ticket channels are now placed inside **Support Forge**.\n' +

          '🔐 Tickets and transcripts remain private through their own permission overwrites.\n\n' +

          'Use `/supportforge category add` to create more departments — each gets its own panel button and can have its own staff role.',
      });

      return;
    } catch (error) {
      console.error(
        '❌ SupportForge setup failed:',
        error,
      );

      await interaction.editReply({
        content:
          '❌ SupportForge setup failed.\n\n' +
          'Check the bot permissions and console for the exact error.',
      });

      return;
    }
  }

  // ==========================================================
  // /supportforge category add
  // ==========================================================

  if (
    subcommandGroup === 'category' &&
    subcommand === 'add'
  ) {
    await interaction.deferReply({
      ephemeral: true,
    });

    const rawName =
      interaction.options.getString(
        'name',
        true,
      );

    const categoryName =
      cleanCategoryName(
        rawName,
      );

    if (!categoryName) {
      await interaction.editReply({
        content:
          '❌ Category name cannot be empty.',
      });

      return;
    }

    if (
      categoryName.toLowerCase() ===
      SUPPORT_FORGE_CATEGORY_NAME.toLowerCase()
    ) {
      await interaction.editReply({
        content:
          '❌ That name is reserved for the main SupportForge container.',
      });

      return;
    }

    const staffRoleOption =
      interaction.options.getRole(
        'staff-role',
      );

    const staffRole =
      staffRoleOption
        ? guild.roles.cache.get(
            staffRoleOption.id,
          ) ?? null
        : null;

    if (
      staffRole &&
      (
        staffRole.id ===
          guild.roles.everyone.id ||
        staffRole.managed
      )
    ) {
      await interaction.editReply({
        content:
          '❌ Please select a normal server role for the staff role.',
      });

      return;
    }

    try {
      /*
       * The main/default SupportForge container is always
       * "Support Forge"; this creates (or reuses) a separate
       * logical department category and posts its ticket button
       * into the shared panel channel.
       */
      let category =
        findLogicalCategory(
          guild,
          categoryName,
        );

      if (!category) {
        category =
          await guild.channels.create({
            name: categoryName,
            type:
              ChannelType.GuildCategory,

            permissionOverwrites: [
              {
                id:
                  guild.roles.everyone.id,

                deny: [
                  PermissionFlagsBits.ViewChannel,
                ],
              },

              {
                id:
                  guild.members.me!.id,

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

              ...(staffRole
                ? [
                    {
                      id:
                        staffRole.id,

                      allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                      ],
                    },
                  ]
                : []),
            ],
          });
      } else if (staffRole) {
        await category.permissionOverwrites.edit(
          staffRole.id,
          {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          },
        );
      }

      const supportForgeCategory =
        await ensureSupportForgeCategory(
          guild,
        );

      const panelChannel =
        await ensurePanelChannel(
          guild,
          supportForgeCategory.id,
        );

      await sendCategoryPanel(
        panelChannel,
        category,
        staffRole,
      );

      await interaction.editReply({
        content:
          `✅ Ticket department **${category.name}** is ready.\n\n` +
          `📁 The main SupportForge container remains ${supportForgeCategory}.\n` +
          `🌐 A ticket panel button for this department has been posted in ${panelChannel}.` +
          (
            staffRole
              ? `\n👥 Staff role: ${staffRole}`
              : ''
          ),
      });

      return;
    } catch (error) {
      console.error(
        '❌ Failed to create SupportForge category:',
        error,
      );

      await interaction.editReply({
        content:
          '❌ The ticket category could not be created.\n\n' +
          'Make sure the bot has **Manage Channels** permission.',
      });

      return;
    }
  }

  // ==========================================================
  // /supportforge premium status
  // ==========================================================

  if (
    subcommandGroup === 'premium' &&
    subcommand === 'status'
  ) {
    await interaction.deferReply({
      ephemeral: true,
    });

    const tier = getGuildTier(guild.id);

    await interaction.editReply({
      content:
        `📦 **Current tier:** ${tierLabel(tier)}\n\n` +
        (tier === 'free'
          ? 'Premium unlocks ticket priority levels, tags, ' +
            'internal staff notes, and the audit log channel.\n' +
            'Pro additionally unlocks everything Premium has ' +
            '(the demo does not currently differentiate Pro-only features ' +
            'beyond Premium — this is a placeholder tier for future work).\n\n' +
            'Run `/supportforge premium toggle-demo` to preview them ' +
            '— this is a demo switch, not a real purchase.'
          : '✅ Premium features are unlocked on this server (demo mode, no billing involved).'),
    });

    return;
  }

  // ==========================================================
  // /supportforge premium toggle-demo
  // ==========================================================

  if (
    subcommandGroup === 'premium' &&
    subcommand === 'toggle-demo'
  ) {
    await interaction.deferReply({
      ephemeral: true,
    });

    const currentTier = getGuildTier(guild.id);

    const nextTier =
      currentTier === 'free'
        ? 'premium-demo'
        : currentTier === 'premium-demo'
          ? 'pro-demo'
          : 'free';

    setGuildTier(guild.id, nextTier);

    await interaction.editReply({
      content:
        `🔁 Tier changed: **${tierLabel(currentTier)}** → **${tierLabel(nextTier)}**.\n\n` +
        '⚠️ This is a demo switch with no real billing behind it — ' +
        'it exists purely so you can preview what Premium/Pro would unlock.',
    });

    return;
  }

  // ==========================================================
  // /supportforge ticket ... (run inside a ticket channel)
  // ==========================================================

  if (subcommandGroup === 'ticket') {
    await interaction.deferReply({
      ephemeral: true,
    });

    const channel = interaction.channel;

    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply({
        content:
          '❌ This command can only be used inside a ticket channel.',
      });

      return;
    }

    const topic = channel.topic ?? '';

    if (!topic.startsWith(TICKET_TOPIC_PREFIX)) {
      await interaction.editReply({
        content: '❌ This channel is not a SupportForge ticket.',
      });

      return;
    }

    const ticketNumber =
      getTopicField(topic, 'number') ?? 'Unknown';
    const staffRoleId = getTopicField(topic, 'staff');
    const ownerId = getTopicField(topic, 'owner');

    const isTicketStaff =
      isAdministrator ||
      (!!staffRoleId &&
        member.roles.cache.has(staffRoleId));

    // ----------------------------------------------------------
    // /supportforge ticket add-user / remove-user (Free)
    // ----------------------------------------------------------

    if (
      subcommand === 'add-user' ||
      subcommand === 'remove-user'
    ) {
      if (!isTicketStaff) {
        await interaction.editReply({
          content:
            '❌ Only support staff or administrators can manage ticket access.',
        });

        return;
      }

      const targetUser = interaction.options.getUser(
        'user',
        true,
      );

      try {
        if (subcommand === 'add-user') {
          await channel.permissionOverwrites.edit(
            targetUser.id,
            {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true,
              AttachFiles: true,
            },
          );

          await channel.send({
            content: `➕ ${targetUser} was added to this ticket by ${interaction.user}.`,
          });

          await interaction.editReply({
            content: `✅ Added ${targetUser} to ticket #${ticketNumber}.`,
          });
        } else {
          if (targetUser.id === ownerId) {
            await interaction.editReply({
              content:
                '❌ You cannot remove the ticket owner from their own ticket.',
            });

            return;
          }

          await channel.permissionOverwrites.delete(
            targetUser.id,
          );

          await channel.send({
            content: `➖ ${targetUser} was removed from this ticket by ${interaction.user}.`,
          });

          await interaction.editReply({
            content: `✅ Removed ${targetUser} from ticket #${ticketNumber}.`,
          });
        }
      } catch (error) {
        console.error(
          `❌ Failed to update ticket access for ticket #${ticketNumber}:`,
          error,
        );

        await interaction.editReply({
          content: '❌ Could not update ticket access.',
        });
      }

      return;
    }

    // ----------------------------------------------------------
    // Everything below is Premium-gated
    // ----------------------------------------------------------

    if (!isPremiumOrHigher(guild.id)) {
      await interaction.editReply({
        content: premiumRequiredMessage('premium-demo'),
      });

      return;
    }

    if (!isTicketStaff) {
      await interaction.editReply({
        content:
          '❌ Only support staff or administrators can do that.',
      });

      return;
    }

    // ----------------------------------------------------------
    // /supportforge ticket priority
    // ----------------------------------------------------------

    if (subcommand === 'priority') {
      const level = interaction.options.getString(
        'level',
        true,
      ) as TicketPriority;

      try {
        const newTopic = setTopicField(
          topic,
          'priority',
          level,
        );

        await channel.setTopic(newTopic);

        const emoji = PRIORITY_EMOJI[level];
        const baseName = channel.name.replace(
          /^[🟢⚪🟠🔴🟣]\s*/u,
          '',
        );

        if (level === 'normal') {
          await channel.setName(baseName);
        } else {
          await channel.setName(`${emoji}${baseName}`);
        }

        await channel.send({
          content: `${emoji} Priority set to **${level}** by ${interaction.user}.`,
        });

        await interaction.editReply({
          content: `✅ Ticket #${ticketNumber} priority set to **${level}**.`,
        });

        void logTicketEvent(guild, {
          ticketNumber,
          event: `Priority → ${level} (by ${interaction.user})`,
        });
      } catch (error) {
        console.error(
          `❌ Failed to set priority for ticket #${ticketNumber}:`,
          error,
        );

        await interaction.editReply({
          content: '❌ Could not set the ticket priority.',
        });
      }

      return;
    }

    // ----------------------------------------------------------
    // /supportforge ticket tag
    // ----------------------------------------------------------

    if (subcommand === 'tag') {
      const rawTag = interaction.options
        .getString('name', true)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .slice(0, 30);

      if (!rawTag) {
        await interaction.editReply({
          content: '❌ Tag name cannot be empty.',
        });

        return;
      }

      try {
        const existingTags = (
          getTopicField(topic, 'tags') ?? ''
        )
          .split(',')
          .filter(Boolean);

        if (existingTags.includes(rawTag)) {
          await interaction.editReply({
            content: `ℹ️ Ticket #${ticketNumber} already has the tag \`${rawTag}\`.`,
          });

          return;
        }

        const newTags = [...existingTags, rawTag].join(',');
        const newTopic = setTopicField(
          topic,
          'tags',
          newTags,
        );

        await channel.setTopic(newTopic);

        await channel.send({
          content: `🏷️ Tag \`${rawTag}\` added by ${interaction.user}.`,
        });

        await interaction.editReply({
          content: `✅ Added tag \`${rawTag}\` to ticket #${ticketNumber}.`,
        });

        void logTicketEvent(guild, {
          ticketNumber,
          event: `Tag added: ${rawTag} (by ${interaction.user})`,
        });
      } catch (error) {
        console.error(
          `❌ Failed to add tag to ticket #${ticketNumber}:`,
          error,
        );

        await interaction.editReply({
          content: '❌ Could not add the tag.',
        });
      }

      return;
    }

    // ----------------------------------------------------------
    // /supportforge ticket note (internal — staff-only visibility)
    // ----------------------------------------------------------

    if (subcommand === 'note') {
      const text = interaction.options.getString(
        'text',
        true,
      );

      void logTicketEvent(guild, {
        ticketNumber,
        event: `🔒 Internal note by ${interaction.user}`,
        detail: text,
      });

      await interaction.editReply({
        content:
          `✅ Internal note recorded for ticket #${ticketNumber}.\n` +
          '🔒 This is only visible to staff in the audit log channel — the ticket owner cannot see it.',
      });

      return;
    }
  }
}