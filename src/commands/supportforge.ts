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

const SUPPORT_FORGE_CATEGORY_NAME = 'Support Forge';
const TRANSCRIPT_CHANNEL_NAME = '📄 support-transcripts';
const PANEL_CHANNEL_NAME = 'support-panel';
const PANEL_TOPIC_PREFIX = 'supportforge:panel';
const TICKET_TOPIC_PREFIX = 'supportforge:ticket';

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

async function ensurePanelMessage(
  panelChannel: Extract<
    ReturnType<typeof findPanelChannel>,
    any
  >,
  supportForgeCategoryId: string,
) {
  if (
    !panelChannel ||
    panelChannel.type !==
      ChannelType.GuildText
  ) {
    return;
  }

  const messages =
    await panelChannel.messages.fetch({
      limit: 50,
    });

  const existingPanelMessage =
    messages.find(
      (message) =>
        message.author.id ===
          panelChannel.client.user.id &&
        (
          message.embeds.some(
            (embed) =>
              embed.title ===
              '🎫 SupportForge',
          ) ||
          message.content.includes(
            'SupportForge',
          )
        ),
    );

  const panelEmbed =
    createPanelEmbed(
      'General Support',
    );

  const panelButton =
    createTicketButton(
      supportForgeCategoryId,
    );

  const row =
    new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        panelButton,
      );

  if (existingPanelMessage) {
    await existingPanelMessage.edit({
      embeds: [
        panelEmbed,
      ],
      components: [
        row,
      ],
    });

    return;
  }

  await panelChannel.send({
    embeds: [
      panelEmbed,
    ],
    components: [
      row,
    ],
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
        supportForgeCategory.id,
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

          '🎫 All SupportForge ticket channels are now placed inside **Support Forge**.\n' +

          '🔐 Tickets and transcripts remain private through their own permission overwrites.',
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
       * This existing command is retained for compatibility.
       *
       * The main/default SupportForge system is now always
       * contained in "Support Forge".
       */
      let category =
        guild.channels.cache.find(
          (channel): channel is CategoryChannel =>
            channel.type ===
              ChannelType.GuildCategory &&
            channel.name.toLowerCase() ===
              categoryName.toLowerCase(),
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

      const commandChannel =
        interaction.channel;

      if (
        commandChannel &&
        commandChannel.type ===
          ChannelType.GuildText
      ) {
        const embed =
          createPanelEmbed(
            category.name,
            staffRole,
          );

        const button =
          createCategoryButton(
            supportForgeCategory.id,
            category.name,
          );

        const row =
          new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
              button,
            );

        await commandChannel.send({
          embeds: [
            embed,
          ],
          components: [
            row,
          ],
        });
      }

      await interaction.editReply({
        content:
          `✅ Ticket category **${category.name}** is ready.\n\n` +
          `📁 The main SupportForge container remains ${supportForgeCategory}.\n` +
          '🎫 A ticket panel has been posted using the Support Forge container.',
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
}