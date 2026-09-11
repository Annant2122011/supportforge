
import {
  ActionRowBuilder,
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
  CategoryChannel,
} from 'discord.js';

export const setupCommand = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Set up the SupportForge ticket system.')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator.toString(),
    )
    .addRoleOption((option) =>
      option
        .setName('staff_role')
        .setDescription('The role that can access support tickets.')
        .setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    // Make sure the command is being used inside a server.
    if (!interaction.guild) {
      await interaction.reply({
        content: '❌ This command can only be used inside a server.',
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    // Defer immediately because setup performs multiple Discord API calls.
    // Discord requires the interaction to be acknowledged within a few seconds.
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    const guild = interaction.guild;
    const staffRole = interaction.options.getRole('staff_role', true);

    // ============================================================
    // 1. FIND OR CREATE PRIVATE TICKET CATEGORY
    // ============================================================

    let category = guild.channels.cache.find(
      (channel): channel is CategoryChannel =>
        channel.type === ChannelType.GuildCategory &&
        channel.name === '🎫 SUPPORT TICKETS',
    );

    // Create the private ticket category if it doesn't exist.
    if (!category) {
      category = await guild.channels.create({
        name: '🎫 SUPPORT TICKETS',
        type: ChannelType.GuildCategory,

        permissionOverwrites: [
          // Everyone: cannot see tickets.
          {
            id: guild.roles.everyone.id,
            deny: [
              PermissionFlagsBits.ViewChannel,
            ],
          },

          // Support staff: can access tickets.
          {
            id: staffRole.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },

          // Bot: full ticket management access.
          {
            id: interaction.client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.ManageMessages,
            ],
          },
        ],
      });
    } else {
      // Make sure the category stays private.
      await category.permissionOverwrites.edit(
        guild.roles.everyone.id,
        {
          ViewChannel: false,
        },
      );

      // Give the selected staff role access.
      await category.permissionOverwrites.edit(
        staffRole.id,
        {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        },
      );

      // Make sure the bot has access.
      await category.permissionOverwrites.edit(
        interaction.client.user.id,
        {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          ManageChannels: true,
          ManageMessages: true,
        },
      );
    }

    // ============================================================
    // 2. FIND OR CREATE PUBLIC SUPPORT PANEL
    // ============================================================

    let panelChannel = guild.channels.cache.find(
      (channel): channel is TextChannel =>
        channel.type === ChannelType.GuildText &&
        !!channel.topic?.startsWith('supportforge:panel'),
    );

    // Create the public support panel if it doesn't exist.
    if (!panelChannel) {
      panelChannel = await guild.channels.create({
        name: 'support-panel',
        type: ChannelType.GuildText,

        topic:
          `supportforge:panel ` +
          `category=${category.id} ` +
          `staffRole=${staffRole.id}`,

        permissionOverwrites: [
          // Everyone can see the panel but cannot type.
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

          // Bot can manage the panel.
          {
            id: interaction.client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ],
      });
    } else {
      // Make the panel public and read-only.
      await panelChannel.permissionOverwrites.edit(
        guild.roles.everyone.id,
        {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: false,
        },
      );

      // Make sure the bot can send and manage the panel.
      await panelChannel.permissionOverwrites.edit(
        interaction.client.user.id,
        {
          ViewChannel: true,
          SendMessages: true,
          EmbedLinks: true,
          ReadMessageHistory: true,
        },
      );

      // Update the panel configuration marker.
      await panelChannel.setTopic(
        `supportforge:panel ` +
        `category=${category.id} ` +
        `staffRole=${staffRole.id}`,
      );
    }

    // ============================================================
    // 3. FIND EXISTING SUPPORTFORGE PANEL MESSAGE
    // ============================================================

    const messages = await panelChannel.messages.fetch({
      limit: 50,
    });

    const existingPanelMessage = messages.find((message) => {
      // Only inspect messages sent by SupportForge.
      if (message.author.id !== interaction.client.user.id) {
        return false;
      }

      // Detect our existing panel.
      return (
        message.content.includes('SupportForge') ||
        message.embeds.some(
          (embed) => embed.title === '🎫 Support Center',
        )
      );
    });

    // ============================================================
    // 4. CREATE SUPPORT PANEL MESSAGE IF NEEDED
    // ============================================================

    if (!existingPanelMessage) {
      const embed = new EmbedBuilder()
        .setTitle('🎫 Support Center')
        .setDescription(
          'Need help? Click the button below to open a private support ticket.',
        )
        .setFooter({
          text: 'SupportForge',
        });

      const button = new ButtonBuilder()
        .setCustomId(`ticket:create:${category.id}`)
        .setLabel('Create Ticket')
        .setEmoji('🎫')
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(button);

      await panelChannel.send({
        embeds: [embed],
        components: [row],
      });
    }

    // ============================================================
    // 5. FINAL RESPONSE
    // ============================================================

    await interaction.editReply({
      content:
        `✅ SupportForge has been set up successfully!\n\n` +
        `📌 Panel: ${panelChannel}\n` +
        `🎫 Ticket Category: **${category.name}**\n` +
        `👥 Staff Role: <@&${staffRole.id}>`,
    });
  },
};
