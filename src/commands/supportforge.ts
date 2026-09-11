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

const TRANSCRIPT_CHANNEL_NAME = '📄 support-transcripts';
const DEFAULT_TICKET_CATEGORY_NAME = 'General Support';

function cleanCategoryName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 90);
}

function findTicketCategory(
  guild: Guild,
  name: string,
) : CategoryChannel | undefined {
  return guild.channels.cache.find(
    (channel): channel is CategoryChannel =>
      channel.type === ChannelType.GuildCategory &&
      channel.name.toLowerCase() === name.toLowerCase(),
  );
}

function findTranscriptChannel(guild: Guild) {
  return guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.name === TRANSCRIPT_CHANNEL_NAME,
  );
}

function createTicketButton(categoryId: string) {
  return new ButtonBuilder()
    .setCustomId(`ticket:create:${categoryId}`)
    .setLabel('Create Ticket')
    .setEmoji('🎫')
    .setStyle(ButtonStyle.Primary);
}

function createCategoryButton(
  categoryId: string,
  label: string,
) {
  return new ButtonBuilder()
    .setCustomId(`ticket:create:${categoryId}`)
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
        `📂 **Category:** ${categoryName}\n` +
        `🔒 Only you and the support team will be able to see your ticket.` +
        staffText,
    )
    .setFooter({
      text: 'SupportForge • Support Ticket System',
    })
    .setTimestamp();
}

async function ensureTranscriptChannel(guild: Guild) {
  const existing = findTranscriptChannel(guild);

  if (
    existing &&
    existing.type === ChannelType.GuildText
  ) {
    return existing;
  }

  const botMember = guild.members.me;

  if (!botMember) {
    throw new Error(
      'Could not find SupportForge bot member.',
    );
  }

  return guild.channels.create({
    name: TRANSCRIPT_CHANNEL_NAME,
    type: ChannelType.GuildText,

    topic:
      'SupportForge ticket transcripts. ' +
      'Do not delete this channel.',

    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [
          PermissionFlagsBits.ViewChannel,
        ],
      },
      {
        id: botMember.id,
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

async function createTicketCategory(
  guild: Guild,
  categoryName: string,
  staffRole?: Role | null,
) {
  const existing = findTicketCategory(
    guild,
    categoryName,
  );

 if (
  existing &&
  existing.type === ChannelType.GuildCategory
) {
  /*
   * If the category already exists and a staff role was
   * supplied,
   * make sure that role has the correct access.
   */
  if (staffRole) {
    await existing.permissionOverwrites.edit(
      staffRole.id,
      {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
      },
    );
  }

  return {
    category: existing,
    created: false,
  };
}
  const botMember = guild.members.me;

  if (!botMember) {
    throw new Error(
      'Could not find SupportForge bot member.',
    );
  }

  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [
        PermissionFlagsBits.ViewChannel,
      ],
    },
    {
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];

  if (staffRole) {
    permissionOverwrites.push({
      id: staffRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
      ],
    });
  }

  const category = await guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
    permissionOverwrites,
  });

  return {
    category,
    created: true,
  };
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
    // /supportforge category add
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

  const guild = interaction.guild;

  // ==========================================================
  // USER PERMISSION CHECK
  // ==========================================================

  const member = await guild.members.fetch(
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
  // BOT PERMISSION CHECK
  // ==========================================================

  const botMember = guild.members.me;

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
    interaction.options.getSubcommandGroup(false);

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
      // TRANSCRIPT CHANNEL
      // --------------------------------------------------------

      const transcriptChannel =
        await ensureTranscriptChannel(guild);

      // --------------------------------------------------------
      // DEFAULT TICKET CATEGORY
      //
      // IMPORTANT:
      // We DO NOT create a parent "SupportForge Tickets"
      // category. Discord categories cannot contain categories.
      //
      // The default category itself is the ticket category.
      // --------------------------------------------------------

      const defaultCategoryResult =
        await createTicketCategory(
          guild,
          DEFAULT_TICKET_CATEGORY_NAME,
        );

      const defaultCategory =
        defaultCategoryResult.category;

      // --------------------------------------------------------
      // CREATE DEFAULT PANEL
      // --------------------------------------------------------

      const panelEmbed =
        createPanelEmbed(
          defaultCategory.name,
        );

      const panelButton =
        createTicketButton(
          defaultCategory.id,
        );

      const panelRow =
        new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            panelButton,
          );

      // --------------------------------------------------------
      // CHANNEL TYPE CHECK
      // --------------------------------------------------------

      const commandChannel =
        interaction.channel;

      if (
        !commandChannel ||
        commandChannel.type !==
          ChannelType.GuildText
      ) {
        await interaction.editReply({
          content:
            '❌ Please run `/supportforge setup` inside a normal text channel.',
        });

        return;
      }

      // --------------------------------------------------------
      // SEND DEFAULT PANEL
      // --------------------------------------------------------

      await commandChannel.send({
        embeds: [
          panelEmbed,
        ],
        components: [
          panelRow,
        ],
      });

      // --------------------------------------------------------
      // FINAL RESPONSE
      // --------------------------------------------------------

      await interaction.editReply({
        content:
          '✅ **SupportForge setup completed!**\n\n' +
          `${defaultCategoryResult.created ? '📂 Created' : '📂 Found'} ticket category: ${defaultCategory}\n` +
          `📄 ${transcriptChannel} is ready for transcripts.\n` +
          '🎫 **General Support** ticket panel has been posted in this channel.\n\n' +
          '💡 Use `/supportforge category add` to create additional ticket categories.',
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

    // --------------------------------------------------------
    // CATEGORY NAME
    // --------------------------------------------------------

    const rawName =
      interaction.options.getString(
        'name',
        true,
      );

    const categoryName =
      cleanCategoryName(rawName);

    if (!categoryName) {
      await interaction.editReply({
        content:
          '❌ Category name cannot be empty.',
      });

      return;
    }

    // --------------------------------------------------------
    // STAFF ROLE
    // --------------------------------------------------------

    const staffRoleOption =
      interaction.options.getRole(
        'staff-role',
      );

    /*
     * Discord.js may return API-level role data here.
     * Resolve it from the guild cache so the rest of the
     * code works with an actual discord.js Role object.
     */

    const staffRole =
      staffRoleOption
        ? guild.roles.cache.get(
            staffRoleOption.id,
          ) ?? null
        : null;

    // --------------------------------------------------------
    // VALIDATE STAFF ROLE
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // CREATE CATEGORY
    // --------------------------------------------------------

    try {
      const result =
        await createTicketCategory(
          guild,
          categoryName,
          staffRole,
        );

      const category =
        result.category;

      // ------------------------------------------------------
      // EXISTING CATEGORY
      // ------------------------------------------------------

      if (!result.created) {
        await interaction.editReply({
          content:
            `⚠️ A ticket category named **${categoryName}** already exists: ${category}\n\n` +
            'No duplicate category was created.',
        });

        return;
      }

      // ------------------------------------------------------
      // CREATE PANEL
      // ------------------------------------------------------

      const commandChannel =
        interaction.channel;

      if (
        !commandChannel ||
        commandChannel.type !==
          ChannelType.GuildText
      ) {
        await interaction.editReply({
          content:
            `✅ Category ${category} was created.\n\n` +
            '⚠️ However, I could not post its panel because this command was not run inside a normal text channel.',
        });

        return;
      }

      const embed =
        createPanelEmbed(
          category.name,
          staffRole,
        );

      const button =
        createCategoryButton(
          category.id,
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

      // ------------------------------------------------------
      // FINAL RESPONSE
      // ------------------------------------------------------

      await interaction.editReply({
        content:
          `✅ **Ticket category created successfully!**\n\n` +
          `📂 **Category:** ${category}\n` +
          `🆔 **Category ID:** \`${category.id}\`\n` +
          (
            staffRole
              ? `👥 **Staff role:** ${staffRole}\n`
              : '👥 **Staff role:** None\n'
          ) +
          '🎫 A ticket panel has also been posted here.',
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