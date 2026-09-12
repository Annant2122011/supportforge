
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

const SUPPORT_FORGE_CATEGORY_NAME = 'Support Forge';
const TRANSCRIPT_CHANNEL_NAME = '📄 support-transcripts';
const TICKET_TOPIC_PREFIX = 'supportforge:ticket';

function getTopicValue(
  topic: string,
  key: string,
): string | undefined {
  const match = topic.match(
    new RegExp(`(?:^|\\s)${key}=([^\\s]+)`),
  );

  return match?.[1];
}

function getSubjectFromTopic(topic: string): string {
  const match = topic.match(
    /(?:^|\s)subject=(.*?)\s+number=/,
  );

  return match?.[1] ?? 'Unknown Subject';
}

function findSupportForgeCategory(
  interaction: ButtonInteraction | ModalSubmitInteraction,
) {
  return interaction.guild?.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildCategory &&
      channel.name.toLowerCase() ===
        SUPPORT_FORGE_CATEGORY_NAME.toLowerCase(),
  );
}

function findTranscriptChannel(
  interaction: ButtonInteraction | ModalSubmitInteraction,
) {
  return interaction.guild?.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.name === TRANSCRIPT_CHANNEL_NAME,
  );
}

async function getTranscriptChannel(
  interaction: ButtonInteraction | ModalSubmitInteraction,
) {
  if (!interaction.guild) {
    return null;
  }

  const supportForgeCategory =
    findSupportForgeCategory(interaction);

  if (!supportForgeCategory) {
    throw new Error(
      'Support Forge category could not be found.',
    );
  }

  const existing = findTranscriptChannel(interaction);
  const botMember = interaction.guild.members.me;

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
      supportForgeCategory.id
    ) {
      try {
        await existing.setParent(
          supportForgeCategory.id,
          {
            lockPermissions: false,
          },
        );
      } catch (error) {
        console.error(
          '❌ Failed to move transcript channel into Support Forge:',
          error,
        );
      }
    }

    try {
      await existing.permissionOverwrites.edit(
        interaction.guild.roles.everyone.id,
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
    } catch (error) {
      console.error(
        '❌ Failed to repair transcript channel permissions:',
        error,
      );
    }

    return existing;
  }

  try {
    return await interaction.guild.channels.create({
      name: TRANSCRIPT_CHANNEL_NAME,

      type: ChannelType.GuildText,

      parent: supportForgeCategory.id,

      topic:
        'SupportForge ticket transcripts. Do not delete this channel.',

      permissionOverwrites: [
        {
          id: interaction.guild.roles.everyone.id,

          deny: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
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
  } catch (error: any) {
    if (
      error?.code === 50013 ||
      error?.code === 40060
    ) {
      throw error;
    }

    const raced = findTranscriptChannel(
      interaction,
    );

    if (
      raced &&
      raced.type === ChannelType.GuildText
    ) {
      return raced;
    }

    throw error;
  }
}

async function sendErrorReply(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
  content: string,
) {
  try {
    if (
      interaction.deferred &&
      !interaction.replied
    ) {
      await interaction.editReply({
        content,
      });

      return;
    }

    if (!interaction.replied) {
      await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error: any) {
    if (error?.code !== 10062) {
      console.error(
        '❌ Failed to send error reply:',
        error,
      );
    }
  }
}

export async function handleTicketInteraction(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
) {
  if (!interaction.guild) {
    await sendErrorReply(
      interaction,
      '❌ This can only be used inside a server.',
    );

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
      await sendErrorReply(
        interaction,
        '❌ Ticket category could not be found.',
      );

      return;
    }

    const category =
      interaction.guild.channels.cache.get(
        categoryId,
      );

    if (
      !category ||
      category.type !==
        ChannelType.GuildCategory
    ) {
      await sendErrorReply(
        interaction,
        '❌ This ticket category no longer exists.',
      );

      return;
    }

    const modal =
      new ModalBuilder()
        .setCustomId(
          `ticket:modal:${categoryId}`,
        )
        .setTitle(
          'Create Support Ticket',
        );

    const subjectInput =
      new TextInputBuilder()
        .setCustomId('subject')
        .setLabel('Subject')
        .setPlaceholder(
          'What do you need help with?',
        )
        .setStyle(
          TextInputStyle.Short,
        )
        .setRequired(true)
        .setMaxLength(100);

    const descriptionInput =
      new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Describe your issue')
        .setPlaceholder(
          'Please provide as much detail as possible.',
        )
        .setStyle(
          TextInputStyle.Paragraph,
        )
        .setRequired(true)
        .setMaxLength(1000);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(subjectInput),

      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(descriptionInput),
    );

    await interaction.showModal(modal);

    return;
  }

  // ============================================================
  // CREATE TICKET MODAL
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
      await sendErrorReply(
        interaction,
        '❌ Ticket category could not be found.',
      );

      return;
    }

    const category =
      interaction.guild.channels.cache.get(
        categoryId,
      );

    if (
      !category ||
      category.type !==
        ChannelType.GuildCategory
    ) {
      await sendErrorReply(
        interaction,
        '❌ The SupportForge ticket category no longer exists.',
      );

      return;
    }

    // ----------------------------------------------------------
    // THE DISCORD CATEGORY IS THE LOGICAL TICKET CATEGORY.
    // THE ACTUAL TICKET CHANNEL ALWAYS LIVES UNDER SUPPORT FORGE.
    // ----------------------------------------------------------

    const supportForgeCategory =
      findSupportForgeCategory(
        interaction,
      );

    if (!supportForgeCategory) {
      await sendErrorReply(
        interaction,
        '❌ The Support Forge category could not be found. Please run `/supportforge setup` first.',
      );

      return;
    }

    try {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });
    } catch (error: any) {
      if (error?.code === 10062) {
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

    if (
      !subject ||
      !description
    ) {
      await interaction.editReply({
        content:
          '❌ Subject and description cannot be empty.',
      });

      return;
    }

    // ==========================================================
    // GET STAFF ROLE FROM LOGICAL CATEGORY
    // ==========================================================

    const staffRoleOverwrite =
      category.permissionOverwrites.cache.find(
        (overwrite) =>
          overwrite.type === 0 &&
          overwrite.id !==
            interaction.guild!.roles
              .everyone.id &&
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
        (channel) => {
          if (
            channel.type !==
            ChannelType.GuildText
          ) {
            return false;
          }

          if (
            channel.parentId !==
            supportForgeCategory.id
          ) {
            return false;
          }

          const topic =
            channel.topic ?? '';

          if (
            !topic.startsWith(
              TICKET_TOPIC_PREFIX,
            )
          ) {
            return false;
          }

          if (
            !topic.includes(
              'status=open',
            )
          ) {
            return false;
          }

          if (
            !topic.includes(
              `owner=${interaction.user.id}`,
            )
          ) {
            return false;
          }

          if (
            !topic.includes(
              `category=${categoryId}`,
            )
          ) {
            return false;
          }

          return true;
        },
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

    let ticketNumber = 0;
    let ticketName = '';

    do {
      ticketNumber =
        Math.floor(
          1000 +
            Math.random() *
              9000,
        );

      ticketName =
        `ticket-${ticketNumber}`;
    } while (
      interaction.guild.channels.cache.some(
        (channel) =>
          channel.name ===
          ticketName,
      )
    );

    // ==========================================================
    // CREATE PERMISSIONS
    // ==========================================================

    const permissionOverwrites = [
      {
        id:
          interaction.guild.roles
            .everyone.id,

        deny: [
          PermissionFlagsBits.ViewChannel,
        ],
      },

      {
        id:
          interaction.user.id,

        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },

      {
        id:
          interaction.client.user.id,

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
            name:
              ticketName,

            type:
              ChannelType.GuildText,

            parent:
              supportForgeCategory.id,

            topic:
              `${TICKET_TOPIC_PREFIX} ` +
              `status=open ` +
              `owner=${interaction.user.id} ` +
              `category=${categoryId} ` +
              `staff=${staffRoleId ?? 'none'} ` +
              `subject=${subject.replace(
                /\s+/g,
                ' ',
              )} ` +
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
    // TICKET EMBED
    // ==========================================================

    const ticketEmbed =
      new EmbedBuilder()
        .setColor(0x5865f2)

        .setTitle(
          '🎫 Support Ticket',
        )

        .setDescription(
          description,
        )

        .addFields(
          {
            name:
              '👤 Ticket Owner',

            value:
              `${interaction.user}`,
          },

          {
            name:
              '📌 Subject',

            value:
              subject,
          },

          {
            name:
              '📂 Category',

            value:
              category.name,
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
        .setLabel(
          'Close Ticket',
        )
        .setEmoji('🔒')
        .setStyle(
          ButtonStyle.Danger,
        );

    // ==========================================================
    // SEND INITIAL TICKET MESSAGE
    // ==========================================================

    try {
      const ticketMessage =
        await ticketChannel.send({
          content:
            `${interaction.user} ` +
            `${
              staffRoleId
                ? `<@&${staffRoleId}>`
                : ''
            }`.trim(),

          embeds: [
            ticketEmbed,
          ],

          components: [
            new ActionRowBuilder<ButtonBuilder>()
              .addComponents(
                closeButton,
              ),
          ],
        });

      await ticketChannel.setTopic(
        `${ticketChannel.topic ?? ''} ` +
          `message=${ticketMessage.id}`,
      );
    } catch (error) {
      console.error(
        '❌ Failed to initialize ticket:',
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
    // ACKNOWLEDGE BUTTON INTERACTION
    // ==========================================================

    try {
      await interaction.deferReply({
        flags:
          MessageFlags.Ephemeral,
      });
    } catch (error: any) {
      if (
        error?.code ===
        10062
      ) {
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
      channel.type !==
        ChannelType.GuildText
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
        TICKET_TOPIC_PREFIX,
      )
    ) {
      await interaction.editReply({
        content:
          '❌ This channel is not a SupportForge ticket.',
      });

      return;
    }

    // ==========================================================
    // CHECK STATUS
    // ==========================================================

    const ticketStatus =
      getTopicValue(
        topic,
        'status',
      ) ?? 'open';

    if (
      ticketStatus ===
      'closed'
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

    const staffRoleIdRaw =
      getTopicValue(
        topic,
        'staff',
      );

    const staffRoleId =
      staffRoleIdRaw &&
      staffRoleIdRaw !==
        'none'
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
    // PERMISSION CHECK
    // ==========================================================

    const member =
      interaction.member;

    const isAdministrator =
      member !== null &&
      'permissions' in member &&
      typeof member.permissions !==
        'string' &&
      member.permissions.has(
        PermissionFlagsBits.Administrator,
      );

    const isStaff =
      member !== null &&
      'roles' in member &&
      'cache' in member.roles &&
      !!staffRoleId &&
      member.roles.cache.has(
        staffRoleId,
      );

    const isOwner =
      ownerId ===
      interaction.user.id;

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
    // CLOSE TIMES
    // ==========================================================

    const openedAt =
      channel.createdAt;

    const closedAt =
      new Date();

    // ==========================================================
    // IMMEDIATELY LOCK TICKET MESSAGING
    // ==========================================================
    //
    // This is intentionally BEFORE the success response and
    // BEFORE any background housekeeping.
    //

    try {
      // --------------------------------------------------------
      // LOCK TICKET OWNER
      // --------------------------------------------------------

      if (ownerId) {
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
      }

      // --------------------------------------------------------
      // LOCK STAFF
      // --------------------------------------------------------

      if (staffRoleId) {
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
      }

      // --------------------------------------------------------
      // LOCK @EVERYONE
      // --------------------------------------------------------

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

      // --------------------------------------------------------
      // MARK TICKET CLOSED
      // --------------------------------------------------------

      await channel.setTopic(
        topic.replace(
          'status=open',
          'status=closed',
        ),
      );
    } catch (error) {
      console.error(
        '❌ Failed to lock ticket:',
        error,
      );

      await interaction.editReply({
        content:
          '❌ The ticket could not be closed because its permissions could not be locked.',
      });

      return;
    }

    // ==========================================================
    // CONFIRM CLOSED + LOCKED
    // ==========================================================

    await interaction.editReply({
      content:
        `✅ Ticket #${ticketNumber} is now closed and locked.\n` +
        `🔒 No further messages can be sent in this ticket.`,
    });

    // ==========================================================
    // BACKGROUND CLOSE TASKS
    // ==========================================================
    //
    // Permission locking is NOT performed here.
    // It has already been completed above.
    //

    const closeTasks = [
      // --------------------------------------------------------
      // RENAME
      // --------------------------------------------------------

      (
        channel.name.endsWith(
          '-closed',
        )
          ? Promise.resolve(
              channel.name,
            )
          : channel.setName(
              `${channel.name}-closed`,
            )
      ).catch(
        (error) => {
          console.error(
            '❌ Failed to rename closed ticket:',
            error,
          );
        },
      ),

      // --------------------------------------------------------
      // DISABLE ORIGINAL CLOSE BUTTON
      // --------------------------------------------------------

      (async () => {
        if (!messageId) {
          console.warn(
            `⚠️ No original ticket message ID stored for ticket #${ticketNumber}.`,
          );

          return;
        }

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
              .setDisabled(
                true,
              );

          await originalTicketMessage.edit({
            components: [
              new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                  closedButton,
                ),
            ],
          });
        } catch (error) {
          console.error(
            '❌ Failed to disable original ticket button:',
            error,
          );
        }
      })(),

      // --------------------------------------------------------
      // SEND CLOSED MESSAGE
      // --------------------------------------------------------

      (async () => {
        try {
          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(
                  0x747f8d,
                )
                .setTitle(
                  '🔒 Ticket Closed',
                )
                .setDescription(
                  `This ticket was closed by ${interaction.user}.`,
                )
                .addFields({
                  name:
                    '🎫 Ticket',
                  value:
                    `#${ticketNumber}`,
                })
                .addFields({
                  name:
                    '📄 Transcript',
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
      })(),
    ];

    // ==========================================================
    // START BACKGROUND WORK
    // ==========================================================

    void Promise.allSettled(
      closeTasks,
    ).then(
      () => {
        void generateAndUploadTranscript({
          interaction,
          channel,
          ticketNumber,
          subject,
          ownerId:
            ownerId ??
            'Unknown',
          openedAt,
          closedAt,
        });
      },
    );

    return;
  }
}

// ============================================================
// BACKGROUND TRANSCRIPT PROCESSING
// ============================================================

async function generateAndUploadTranscript({
  interaction,
  channel,
  ticketNumber,
  subject,
  ownerId,
  openedAt,
  closedAt,
}: {
  interaction: ButtonInteraction;

  channel: Extract<
    typeof interaction.channel,
    {
      type: ChannelType.GuildText;
    }
  >;

  ticketNumber: string;

  subject: string;

  ownerId: string;

  openedAt: Date;

  closedAt: Date;
}) {
  try {
    // ========================================================
    // GUILD CHECK
    // ========================================================

    const guild =
      interaction.guild;

    if (!guild) {
      console.error(
        `❌ Cannot generate transcript for ticket #${ticketNumber}: guild is unavailable.`,
      );

      return;
    }

    // ========================================================
    // OWNER NAME
    // ========================================================

    let ownerName =
      'Unknown User';

    try {
      if (
        ownerId !==
        'Unknown'
      ) {
        const owner =
          await guild.members.fetch(
            ownerId,
          );

        ownerName =
          owner.displayName ||
          owner.user.username;
      }
    } catch (error) {
      console.warn(
        '⚠️ Could not fetch ticket owner:',
        error,
      );

      ownerName =
        ownerId;
    }

    // ========================================================
    // TRANSCRIPT CHANNEL
    // ========================================================

    const transcriptChannel =
      await getTranscriptChannel(
        interaction,
      );

    if (
      !transcriptChannel
    ) {
      await channel
        .send({
          content:
            '⚠️ Ticket closed, but the transcript channel could not be found.',
        })
        .catch(
          () =>
            undefined,
        );

      return;
    }

    // ========================================================
    // GENERATE TRANSCRIPT
    // ========================================================

    console.log(
      `📄 Generating transcript for ticket #${ticketNumber}...`,
    );

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

    console.log(
      `✅ Transcript generated for ticket #${ticketNumber}.`,
    );

    // ========================================================
    // UPLOAD TRANSCRIPT
    // ========================================================

    await transcriptChannel.send({
      content:
        `📄 **Ticket #${ticketNumber} Transcript**\n` +
        `**Subject:** ${subject}\n` +
        `**Ticket Owner:** ${
          ownerId !== 'Unknown'
            ? `<@${ownerId}>`
            : 'Unknown'
        }\n` +
        `**Closed by:** ${interaction.user}`,

      files: [
        transcript,
      ],
    });

    console.log(
      `✅ Transcript uploaded for ticket #${ticketNumber}.`,
    );

    // ========================================================
    // CONFIRMATION
    // ========================================================

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
}
