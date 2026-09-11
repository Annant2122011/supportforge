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
} from 'discord.js';

import { generateTranscript } from '../services/transcriptService';

const TRANSCRIPT_CHANNEL_NAME = 'support-transcripts';

/**
 * Extract a value from the SupportForge ticket topic.
 *
 * Example:
 * owner=123456789
 * category=987654321
 * staff=456789123
 * number=4821
 */
function getTopicValue(
  topic: string,
  key: string,
): string | undefined {
  const match = topic.match(
    new RegExp(`${key}=([^\\s]+)`),
  );

  return match?.[1];
}

/**
 * Extract the subject.
 *
 * Subject can contain spaces, so it is handled separately.
 *
 * Example:
 * subject=Payment problem number=1234
 */
function getSubjectFromTopic(
  topic: string,
): string {
  const match = topic.match(
    /subject=(.*?)\s+number=/,
  );

  return match?.[1] ?? 'Unknown Subject';
}

/**
 * Find the SupportForge transcript channel.
 */
function findTranscriptChannel(
  interaction: ButtonInteraction | ModalSubmitInteraction,
) {
  return interaction.guild?.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.name === TRANSCRIPT_CHANNEL_NAME,
  );
}

/**
 * Find or create the transcript channel.
 */
async function getTranscriptChannel(
  interaction: ButtonInteraction | ModalSubmitInteraction,
) {
  if (!interaction.guild) {
    return null;
  }

  const existing =
    findTranscriptChannel(interaction);

  if (
    existing &&
    existing.type === ChannelType.GuildText
  ) {
    return existing;
  }

  const botMember =
    interaction.guild.members.me;

  if (!botMember) {
    throw new Error(
      'Could not find SupportForge bot member.',
    );
  }

  return interaction.guild.channels.create({
    name: TRANSCRIPT_CHANNEL_NAME,
    type: ChannelType.GuildText,

    topic:
      'SupportForge ticket transcripts. ' +
      'Do not delete this channel.',

    permissionOverwrites: [
      {
        id:
          interaction.guild.roles.everyone.id,
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

export async function handleTicketInteraction(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
) {
  // ============================================================
  // SERVER CHECK
  // ============================================================

  if (!interaction.guild) {
    await interaction.reply({
      content:
        '❌ This can only be used inside a server.',
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  // ============================================================
  // CREATE TICKET BUTTON
  // ============================================================

  if (
    interaction.isButton() &&
    interaction.customId.startsWith(
      'ticket:create:',
    )
  ) {
    const categoryId =
      interaction.customId.split(':')[2];

    if (!categoryId) {
      await interaction.reply({
        content:
          '❌ Ticket category could not be found.',
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    const category =
      interaction.guild.channels.cache.get(
        categoryId,
      );

    if (
      !category ||
      category.type !== ChannelType.GuildCategory
    ) {
      await interaction.reply({
        content:
          '❌ This ticket category no longer exists.',
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    // ==========================================================
    // CREATE TICKET MODAL
    // ==========================================================

    const modal =
      new ModalBuilder()
        .setCustomId(
          `ticket:modal:${categoryId}`,
        )
        .setTitle('Create Support Ticket');

    const subjectInput =
      new TextInputBuilder()
        .setCustomId('subject')
        .setLabel('Subject')
        .setPlaceholder(
          'What do you need help with?',
        )
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

    const descriptionInput =
      new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Describe your issue')
        .setPlaceholder(
          'Please provide as much detail as possible.',
        )
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

    const subjectRow =
      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(subjectInput);

    const descriptionRow =
      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(descriptionInput);

    modal.addComponents(
      subjectRow,
      descriptionRow,
    );

    await interaction.showModal(modal);

    return;
  }

  // ============================================================
  // MODAL SUBMISSION
  // ============================================================

  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith(
      'ticket:modal:',
    )
  ) {
    const categoryId =
      interaction.customId.split(':')[2];

    if (!categoryId) {
      await interaction.reply({
        content:
          '❌ Ticket category could not be found.',
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    // ==========================================================
    // GET CATEGORY
    // ==========================================================

    const category =
      interaction.guild.channels.cache.get(
        categoryId,
      );

    if (
      !category ||
      category.type !== ChannelType.GuildCategory
    ) {
      await interaction.reply({
        content:
          '❌ The SupportForge ticket category no longer exists.',
        flags: MessageFlags.Ephemeral,
      });

      return;
    }

    // ==========================================================
    // ACKNOWLEDGE MODAL
    // ==========================================================

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    const subject =
      interaction.fields
        .getTextInputValue('subject')
        .trim();

    const description =
      interaction.fields
        .getTextInputValue('description')
        .trim();

    if (!subject || !description) {
      await interaction.editReply({
        content:
          '❌ Subject and description cannot be empty.',
      });

      return;
    }

    // ==========================================================
    // FIND STAFF ROLE
    // ==========================================================

    /**
     * The setup command gives the category a staff-role
     * permission overwrite.
     *
     * We deliberately ignore:
     * - @everyone
     * - the bot
     */
    const staffRoleOverwrite =
      category.permissionOverwrites.cache.find(
        (overwrite) =>
          overwrite.type === 0 &&
          overwrite.id !==
            interaction.guild!.roles.everyone.id &&
          overwrite.id !==
            interaction.client.user.id &&
          overwrite.allow.has(
            PermissionFlagsBits.ViewChannel,
          ),
      );

    const staffRoleId =
      staffRoleOverwrite?.id;

    // ==========================================================
    // PREVENT MULTIPLE OPEN TICKETS
    // ==========================================================

    const existingTicket =
      interaction.guild.channels.cache.find(
        (channel) =>
          channel.parentId === categoryId &&
          channel.type === ChannelType.GuildText &&
          channel.topic?.includes(
            'supportforge:ticket',
          ) &&
          channel.topic?.includes(
            'status=open',
          ) &&
          channel.topic?.includes(
            `owner=${interaction.user.id}`,
          ),
      );

    if (existingTicket) {
      await interaction.editReply({
        content:
          `❌ You already have an open ticket: ${existingTicket}`,
      });

      return;
    }

    // ==========================================================
    // GENERATE UNIQUE TICKET NUMBER
    // ==========================================================

    let ticketNumber: number;
    let ticketName: string;

    do {
      ticketNumber =
        Math.floor(
          1000 +
            Math.random() * 9000,
        );

      ticketName =
        `ticket-${ticketNumber}`;
    } while (
      interaction.guild.channels.cache.some(
        (channel) =>
          channel.name === ticketName,
      )
    );

    // ==========================================================
    // CREATE PERMISSIONS
    // ==========================================================

    const permissionOverwrites = [
      {
        id:
          interaction.guild.roles.everyone.id,
        deny: [
          PermissionFlagsBits.ViewChannel,
        ],
      },

      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },

      {
        id: interaction.client.user.id,
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

    // ==========================================================
    // ADD STAFF PERMISSIONS
    // ==========================================================

    if (staffRoleId) {
      permissionOverwrites.push({
        id: staffRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      });
    }

    // ==========================================================
    // CREATE TICKET CHANNEL
    // ==========================================================

    let ticketChannel;

    try {
      ticketChannel =
        await interaction.guild.channels.create(
          {
            name: ticketName,
            type: ChannelType.GuildText,
            parent: categoryId,

            topic:
              `supportforge:ticket ` +
              `status=open ` +
              `owner=${interaction.user.id} ` +
              `category=${categoryId} ` +
              `staff=${staffRoleId ?? 'none'} ` +
              `subject=${subject} ` +
              `number=${ticketNumber}`,

            permissionOverwrites,
          },
        );
    } catch (error) {
      console.error(
        '❌ Failed to create ticket channel:',
        error,
      );

      await interaction.editReply({
        content:
          '❌ The ticket could not be created. Please try again.',
      });

      return;
    }

    // ==========================================================
    // CREATE TICKET EMBED
    // ==========================================================

    const ticketEmbed =
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎫 Support Ticket')
        .setDescription(description)
        .addFields(
          {
            name: '👤 Ticket Owner',
            value:
              `${interaction.user}`,
          },
          {
            name: '📌 Subject',
            value: subject,
          },
          {
            name: '📂 Category',
            value: category.name,
          },
        )
        .setFooter({
          text:
            `Ticket #${ticketNumber} • ` +
            `Created by ${interaction.user.tag}`,
        })
        .setTimestamp();

    // ==========================================================
    // CLOSE BUTTON
    // ==========================================================

    const closeButton =
      new ButtonBuilder()
        .setCustomId(
          'ticket:close',
        )
        .setLabel('Close Ticket')
        .setEmoji('🔒')
        .setStyle(
          ButtonStyle.Danger,
        );

    const row =
      new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          closeButton,
        );

    // ==========================================================
    // STAFF MENTION
    // ==========================================================

    const staffMention =
      staffRoleId
        ? `<@&${staffRoleId}>`
        : '';

    // ==========================================================
    // SEND INITIAL TICKET MESSAGE
    // ==========================================================

    try {
      const ticketMessage =
        await ticketChannel.send({
          content:
            `${interaction.user} ${staffMention}`.trim(),

          embeds: [
            ticketEmbed,
          ],

          components: [
            row,
          ],
        });

      /**
       * Store the exact message ID in the ticket topic.
       *
       * This allows us to disable the exact button later.
       */
      await ticketChannel.setTopic(
        `${ticketChannel.topic ?? ''} ` +
          `message=${ticketMessage.id}`,
      );
    } catch (error) {
      console.error(
        '❌ Failed to send ticket message:',
        error,
      );

      try {
        await ticketChannel.delete(
          'SupportForge cleanup after ticket creation failure',
        );
      } catch (deleteError) {
        console.error(
          '❌ Failed to clean up ticket channel:',
          deleteError,
        );
      }

      await interaction.editReply({
        content:
          '❌ The ticket could not be initialized. Please try again.',
      });

      return;
    }

    // ==========================================================
    // FINAL CREATION RESPONSE
    // ==========================================================

    await interaction.editReply({
      content:
        `✅ Your ticket has been created: ${ticketChannel}`,
    });

    return;
  }

  // ============================================================
  // CLOSE TICKET BUTTON
  // ============================================================

  if (
    interaction.isButton() &&
    interaction.customId ===
      'ticket:close'
  ) {
    // ==========================================================
    // ACKNOWLEDGE IMMEDIATELY
    // ==========================================================

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    const channel =
      interaction.channel;

    // ==========================================================
    // CHANNEL CHECK
    // ==========================================================

    if (
      !channel ||
      channel.type !== ChannelType.GuildText
    ) {
      await interaction.editReply({
        content:
          '❌ This button can only be used inside a ticket channel.',
      });

      return;
    }

    // ==========================================================
    // VERIFY SUPPORTFORGE TICKET
    // ==========================================================

    const topic =
      channel.topic ?? '';

    if (
      !topic.startsWith(
        'supportforge:ticket',
      )
    ) {
      await interaction.editReply({
        content:
          '❌ This channel is not a SupportForge ticket.',
      });

      return;
    }

    // ==========================================================
    // CHECK TICKET STATUS
    // ==========================================================

    const ticketStatus =
      getTopicValue(
        topic,
        'status',
      ) ?? 'open';

    if (
      ticketStatus === 'closed'
    ) {
      await interaction.editReply({
        content:
          'ℹ️ This ticket is already closed.',
      });

      return;
    }

    // ==========================================================
    // GET TICKET INFORMATION
    // ==========================================================

    const ownerId =
      getTopicValue(
        topic,
        'owner',
      );

    const categoryId =
      getTopicValue(
        topic,
        'category',
      );

    const staffRoleIdRaw =
      getTopicValue(
        topic,
        'staff',
      );

    const staffRoleId =
      staffRoleIdRaw &&
      staffRoleIdRaw !== 'none'
        ? staffRoleIdRaw
        : undefined;

    const ticketNumber =
      getTopicValue(
        topic,
        'number',
      ) ?? 'Unknown';

    const messageId =
      getTopicValue(
        topic,
        'message',
      );

    const subject =
      getSubjectFromTopic(
        topic,
      );

    // ==========================================================
    // GET CLOSING MEMBER
    // ==========================================================

    const member =
      await interaction.guild.members.fetch(
        interaction.user.id,
      );

    // ==========================================================
    // CHECK ADMINISTRATOR
    // ==========================================================

    const isAdministrator =
      member.permissions.has(
        PermissionFlagsBits.Administrator,
      );

    // ==========================================================
    // CHECK STAFF
    // ==========================================================

    const isStaff =
      staffRoleId
        ? member.roles.cache.has(
            staffRoleId,
          )
        : false;

    // ==========================================================
    // CHECK OWNER
    // ==========================================================

    const isOwner =
      ownerId ===
      interaction.user.id;

    // ==========================================================
    // AUTHORIZATION
    // ==========================================================

    if (
      !isOwner &&
      !isStaff &&
      !isAdministrator
    ) {
      await interaction.editReply({
        content:
          '❌ You do not have permission to close this ticket.',
      });

      return;
    }

    // ==========================================================
    // TICKET TIMES
    // ==========================================================

    const openedAt =
      channel.createdAt;

    const closedAt =
      new Date();

    // ==========================================================
    // GET OWNER NAME
    // ==========================================================

    let ownerName =
      'Unknown User';

    if (ownerId) {
      try {
        const owner =
          await interaction.guild.members.fetch(
            ownerId,
          );

        ownerName =
          owner.displayName ||
          owner.user.username;
      } catch (error) {
        console.warn(
          '⚠️ Could not fetch ticket owner:',
          error,
        );

        ownerName =
          ownerId;
      }
    }

    // ==========================================================
    // FIND / CREATE TRANSCRIPT CHANNEL
    // ==========================================================

    let transcriptChannel;

    try {
      transcriptChannel =
        await getTranscriptChannel(
          interaction,
        );
    } catch (error) {
      console.error(
        '❌ Failed to create transcript channel:',
        error,
      );

      await interaction.editReply({
        content:
          '❌ The ticket could not be closed because the transcript channel could not be created.',
      });

      return;
    }

    if (!transcriptChannel) {
      await interaction.editReply({
        content:
          '❌ Transcript channel could not be found.',
      });

      return;
    }

    // ==========================================================
    // GENERATE TRANSCRIPT
    // ==========================================================

    let transcript;

    try {
      transcript =
        await generateTranscript({
          channel,
          ticketNumber,
          subject,
          ownerId:
            ownerId ?? 'Unknown',
          ownerName,
          closedBy:
            interaction.user.tag,
          openedAt,
          closedAt,
        });
    } catch (error) {
      console.error(
        '❌ Failed to generate transcript:',
        error,
      );

      await interaction.editReply({
        content:
          '❌ The ticket could not be closed because the transcript could not be generated.',
      });

      return;
    }

    // ==========================================================
    // UPLOAD TRANSCRIPT
    // ==========================================================

    try {
      await transcriptChannel.send({
        content:
          `📄 **Ticket #${ticketNumber} Transcript**\n` +
          `**Subject:** ${subject}\n` +
          `**Ticket Owner:** <@${ownerId ?? '0'}>\n` +
          `**Closed by:** ${interaction.user}`,

        files: [
          transcript,
        ],
      });
    } catch (error) {
      console.error(
        '❌ Failed to send transcript:',
        error,
      );

      await interaction.editReply({
        content:
          '❌ The transcript was generated but could not be uploaded. The ticket has not been closed.',
      });

      return;
    }

    // ==========================================================
    // MARK TICKET AS CLOSED
    // ==========================================================

    try {
      const closedTopic =
        topic.replace(
          'status=open',
          'status=closed',
        );

      await channel.setTopic(
        closedTopic,
      );
    } catch (error) {
      console.error(
        '❌ Failed to update ticket status:',
        error,
      );

      await interaction.editReply({
        content:
          '❌ The transcript was saved, but the ticket status could not be updated. The ticket has not been locked.',
      });

      return;
    }

    // ==========================================================
    // LOCK TICKET OWNER
    // ==========================================================

    if (ownerId) {
      try {
        await channel.permissionOverwrites.edit(
          ownerId,
          {
            SendMessages: false,
          },
        );
      } catch (error) {
        console.error(
          '❌ Failed to lock ticket owner:',
          error,
        );
      }
    }

    try {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
    ViewChannel: false,
    SendMessages: false,
  });
} catch (error) {
  console.error('Failed to lock @everyone permissions:', error);
}
try {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
    ViewChannel: false,
    SendMessages: false,
  });
} catch (error) {
  console.error('Failed to lock @everyone permissions:', error);
}
// ==========================================================
    // CHANNEL RENAMING AFTER CLOSING OF TICKET
    // ==========================================================

const closedChannelName = channel.name.endsWith('-closed')
  ? channel.name
  : `${channel.name}-closed`;

try {
  await channel.setName(closedChannelName);
} catch (error) {
  console.error('Failed to rename closed ticket:', error);
}

    // ==========================================================
    // DISABLED CLOSED BUTTON
    // ==========================================================

    const closedButton =
      new ButtonBuilder()
        .setCustomId(
          'ticket:closed',
        )
        .setLabel('Ticket Closed')
        .setEmoji('🔒')
        .setStyle(
          ButtonStyle.Secondary,
        )
        .setDisabled(true);

    const closedRow =
      new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          closedButton,
        );

    // ============================================================
// DISABLE EXACT ORIGINAL BUTTON
// ============================================================

if (messageId) {
  try {
    const originalTicketMessage =
      await channel.messages.fetch(
        messageId,
      );

    const closedButton =
      new ButtonBuilder()
        .setCustomId(
          'ticket:closed',
        )
        .setLabel(
          'Ticket Closed',
        )
        .setEmoji('🔒')
        .setStyle(
          ButtonStyle.Secondary,
        )
        .setDisabled(true);

    const closedRow =
      new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          closedButton,
        );

    await originalTicketMessage.edit({
      components: [
        closedRow,
      ],
    });
  } catch (error) {
    console.error(
      '❌ Failed to disable original ticket button:',
      error,
    );
  }
} else {
  console.warn(
    '⚠️ No original ticket message ID was stored for this ticket.',
  );
}

    // ==========================================================
    // SEND CLOSED MESSAGE
    // ==========================================================

    try {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x747f8d)
            .setTitle(
              '🔒 Ticket Closed',
            )
            .setDescription(
              `This ticket was closed by ${interaction.user}.`,
            )
            .addFields(
              {
                name: '📄 Transcript',
                value:
                  `Saved in ${transcriptChannel}`,
              },
              {
                name: '🎫 Ticket',
                value:
                  `#${ticketNumber}`,
              },
            )
            .setTimestamp(),
        ],
      });
    } catch (error) {
      console.error(
        '❌ Failed to send closed message:',
        error,
      );
    }

    // ==========================================================
    // FINAL RESPONSE
    // ==========================================================

    await interaction.editReply({
      content:
        `✅ Ticket #${ticketNumber} closed successfully.\n` +
        `📄 Transcript saved in ${transcriptChannel}.`,
    });
  }
}