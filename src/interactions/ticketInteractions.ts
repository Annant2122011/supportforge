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
 * Extract the subject from the ticket topic.
 *
 * Subject may contain spaces, so it is handled separately.
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
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
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
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
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

/**
 * Handle all SupportForge ticket interactions.
 */
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

    try {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });
    } catch (error: any) {
      if (error?.code === 10062) {
        console.warn(
          '⚠️ Ticket creation interaction expired or was already acknowledged.',
        );

        return;
      }

      throw error;
    }

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
     * Ignore:
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
          `❌ You already have an open ticket in this category: ${existingTicket}`,
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
        await interaction.guild.channels.create({
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
        });
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
       * This allows the close handler to edit the
       * exact original ticket message later.
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
    interaction.customId === 'ticket:close'
  ) {
    // ==========================================================
    // ACKNOWLEDGE IMMEDIATELY
    // ==========================================================

    try {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });
    } catch (error: any) {
      /**
       * Discord error 10062 means the interaction token
       * has expired or the interaction was already acknowledged.
       *
       * Do not attempt another reply in this situation.
       */
      if (error?.code === 10062) {
        console.warn(
          '⚠️ Close-ticket interaction expired or was already acknowledged.',
        );

        return;
      }

      throw error;
    }

    // ==========================================================
    // CHANNEL CHECK
    // ==========================================================

    const channel =
      interaction.channel;

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

    if (ticketStatus === 'closed') {
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
    // AUTHORIZATION
    // ==========================================================

    const isAdministrator =
      member.permissions.has(
        PermissionFlagsBits.Administrator,
      );

    const isStaff =
      staffRoleId
        ? member.roles.cache.has(
            staffRoleId,
          )
        : false;

    const isOwner =
      ownerId === interaction.user.id;

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
    // RECORD CLOSE TIME
    // ==========================================================

    const openedAt =
      channel.createdAt;

    const closedAt =
      new Date();

    // ==========================================================
    // UPDATE STATUS FIRST
    // ==========================================================

    const closedTopic =
      topic.replace(
        'status=open',
        'status=closed',
      );

    try {
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
          '❌ The ticket could not be closed because its status could not be updated.',
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
            ViewChannel: true,
            SendMessages: false,
            AddReactions: false,
            AttachFiles: false,
            EmbedLinks: false,
          },
        );
      } catch (error) {
        console.error(
          '❌ Failed to lock ticket owner:',
          error,
        );
      }
    }

    // ==========================================================
    // LOCK STAFF ROLE
    // ==========================================================

    if (staffRoleId) {
      try {
        await channel.permissionOverwrites.edit(
          staffRoleId,
          {
            ViewChannel: true,
            SendMessages: false,
            AddReactions: false,
            AttachFiles: false,
            EmbedLinks: false,
          },
        );
      } catch (error) {
        console.error(
          '❌ Failed to lock staff role:',
          error,
        );
      }
    }

    // ==========================================================
    // LOCK @EVERYONE
    // ==========================================================

    try {
      await channel.permissionOverwrites.edit(
        channel.guild.roles.everyone,
        {
          ViewChannel: false,
          SendMessages: false,
          AddReactions: false,
          AttachFiles: false,
          EmbedLinks: false,
        },
      );
    } catch (error) {
      console.error(
        '❌ Failed to lock @everyone permissions:',
        error,
      );
    }

    // ==========================================================
    // RENAME CHANNEL
    // ==========================================================

    const closedChannelName =
      channel.name.endsWith('-closed')
        ? channel.name
        : `${channel.name}-closed`;

    try {
      await channel.setName(
        closedChannelName,
      );
    } catch (error) {
      console.error(
        '❌ Failed to rename closed ticket:',
        error,
      );
    }

    // ==========================================================
    // DISABLE ORIGINAL CLOSE BUTTON
    // ==========================================================

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
    // IMMEDIATE USER RESPONSE
    // ==========================================================

    /**
     * The ticket is now officially closed.
     *
     * Transcript generation happens AFTER this response,
     * so a large ticket history cannot make the user wait
     * for the ticket to become closed.
     */
    await interaction.editReply({
      content:
        `✅ Ticket #${ticketNumber} is now closed.\n` +
        `🔒 The channel has been locked.`,
    });

    // ==========================================================
    // TRANSCRIPT WORK
    // ==========================================================
    // Everything below this point happens AFTER closure.

        // ==========================================================
    // CLOSE TICKET IMMEDIATELY
    // ==========================================================

    await interaction.editReply({
      content:
        `✅ Ticket #${ticketNumber} closed successfully.\n` +
        `📄 Transcript generation started in the background.`,
    });

    // ==========================================================
    // SEND CLOSED MESSAGE
    // ==========================================================

    try {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x747f8d)
            .setTitle('🔒 Ticket Closed')
            .setDescription(
              `This ticket was closed by ${interaction.user}.`,
            )
            .addFields({
              name: '🎫 Ticket',
              value: `#${ticketNumber}`,
            })
            .addFields({
              name: '📄 Transcript',
              value:
                '⏳ Transcript is being generated...',
            })
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
    // GENERATE + UPLOAD TRANSCRIPT IN BACKGROUND
    // ==========================================================

    void (async () => {
      try {
        // ------------------------------------------------------
        // GET OWNER NAME
        // ------------------------------------------------------

        let ownerName = 'Unknown User';

        if (ownerId) {
          try {
            const owner =
              await interaction.guild!.members.fetch(
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

            ownerName = ownerId;
          }
        }

        // ------------------------------------------------------
        // GET TRANSCRIPT CHANNEL
        // ------------------------------------------------------

        const transcriptChannel =
          await getTranscriptChannel(
            interaction,
          );

        if (!transcriptChannel) {
          await channel.send({
            content:
              '⚠️ Ticket closed, but the transcript channel could not be found.',
          });

          return;
        }

        // ------------------------------------------------------
        // GENERATE TRANSCRIPT
        // ------------------------------------------------------

        console.log(
          `📄 Generating transcript for ticket #${ticketNumber}...`,
        );

        const transcript =
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

        console.log(
          `✅ Transcript generated for ticket #${ticketNumber}.`,
        );

        // ------------------------------------------------------
        // UPLOAD TRANSCRIPT
        // ------------------------------------------------------

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

        console.log(
          `✅ Transcript uploaded for ticket #${ticketNumber}.`,
        );

        // ------------------------------------------------------
        // TRANSCRIPT COMPLETE MESSAGE
        // ------------------------------------------------------

        await channel.send({
          content:
            `📄 Transcript for ticket #${ticketNumber} has been saved in ${transcriptChannel}.`,
        });
      } catch (error) {
        console.error(
          `❌ Background transcript processing failed for ticket #${ticketNumber}:`,
          error,
        );

        try {
          await channel.send({
            content:
              `⚠️ Ticket #${ticketNumber} was closed successfully, but the transcript could not be generated or uploaded.`,
          });
        } catch (sendError) {
          console.error(
            '❌ Failed to send transcript failure message:',
            sendError,
          );
        }
      }
    })();

    return;

    }  }
