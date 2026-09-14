
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

type TicketStatus =
  | 'open'
  | 'claimed'
  | 'pending'
  | 'closed'
  | 'reopened'
  | 'archived';

// A ticket counts as "still active" (blocks a new ticket from the same
// owner, in the same category) unless it has been closed or archived.
// Claimed / pending / reopened tickets are all still active.
function isActiveStatus(status: string): boolean {
  return status !== 'closed' && status !== 'archived';
}

function buildTicketActionRow(
  status: TicketStatus,
): ActionRowBuilder<ButtonBuilder> {
  const claimButton = new ButtonBuilder()
    .setCustomId('ticket:claim')
    .setLabel('Claim Ticket')
    .setEmoji('🙋')
    .setStyle(ButtonStyle.Success);

  const pendingButton = new ButtonBuilder()
    .setCustomId('ticket:pending')
    .setLabel('Mark Pending')
    .setEmoji('⏳')
    .setStyle(ButtonStyle.Secondary);

  const closeButton = new ButtonBuilder()
    .setCustomId('ticket:close')
    .setLabel('Close Ticket')
    .setEmoji('🔒')
    .setStyle(ButtonStyle.Danger);

  const reopenButton = new ButtonBuilder()
    .setCustomId('ticket:reopen')
    .setLabel('Reopen Ticket')
    .setEmoji('🔓')
    .setStyle(ButtonStyle.Success);

  const archiveButton = new ButtonBuilder()
    .setCustomId('ticket:archive')
    .setLabel('Archive Ticket')
    .setEmoji('🗄️')
    .setStyle(ButtonStyle.Secondary);

  const archivedButton = new ButtonBuilder()
    .setCustomId('ticket:archived')
    .setLabel('Archived')
    .setEmoji('🗄️')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);

  switch (status) {
    case 'open':
    case 'reopened':
      return new ActionRowBuilder<ButtonBuilder>().addComponents(
        claimButton,
        pendingButton,
        closeButton,
      );

    case 'claimed':
      return new ActionRowBuilder<ButtonBuilder>().addComponents(
        pendingButton,
        closeButton,
      );

    case 'pending':
      return new ActionRowBuilder<ButtonBuilder>().addComponents(
        closeButton,
      );

    case 'closed':
      return new ActionRowBuilder<ButtonBuilder>().addComponents(
        reopenButton,
        archiveButton,
      );

    case 'archived':
    default:
      return new ActionRowBuilder<ButtonBuilder>().addComponents(
        archivedButton,
      );
  }
}

// Updates the components on the original ticket message so its buttons
// always match the ticket's current status.
async function updateTicketMessageButtons(
  channel: {
    messages: { fetch: (id: string) => Promise<any> };
  },
  messageId: string | undefined,
  status: TicketStatus,
): Promise<void> {
  if (!messageId) {
    console.warn(
      '⚠️ No stored ticket message ID; cannot update ticket buttons.',
    );

    return;
  }

  try {
    const message = await channel.messages.fetch(messageId);

    await message.edit({
      components: [buildTicketActionRow(status)],
    });
  } catch (error) {
    console.error(
      '❌ Failed to update ticket message buttons:',
      error,
    );
  }
}

function getTopicValue(
  topic: string,
  key: string,
): string | undefined {
  const match = topic.match(
    new RegExp(`(?:^|\\s)${key}=([^\\s]+)`),
  );

  return match?.[1];
}

function getSubjectFromTopic(
  topic: string,
): string {
  const match = topic.match(
    /(?:^|\s)subject=(.*?)\s+number=/,
  );

  return match?.[1] ?? 'Unknown Subject';
}

function findSupportForgeCategory(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
) {
  return interaction.guild?.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildCategory &&
      channel.name.toLowerCase() ===
        SUPPORT_FORGE_CATEGORY_NAME.toLowerCase(),
  );
}

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

async function getTranscriptChannel(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction,
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

  const existing =
    findTranscriptChannel(interaction);

  const botMember =
    interaction.guild.members.me;

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
    return await interaction.guild.channels.create(
      {
        name: TRANSCRIPT_CHANNEL_NAME,

        type: ChannelType.GuildText,

        parent: supportForgeCategory.id,

        topic:
          'SupportForge ticket transcripts. Do not delete this channel.',

        permissionOverwrites: [
          {
            id:
              interaction.guild.roles
                .everyone.id,

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
      },
    );
  } catch (error: any) {
    if (
      error?.code === 50013 ||
      error?.code === 40060
    ) {
      throw error;
    }

    const raced =
      findTranscriptChannel(
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
        .addComponents(
          subjectInput,
        ),

      new ActionRowBuilder<TextInputBuilder>()
        .addComponents(
          descriptionInput,
        ),
    );

    await interaction.showModal(
      modal,
    );

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
        flags:
          MessageFlags.Ephemeral,
      });
    } catch (error: any) {
      if (error?.code === 10062) {
        return;
      }

      throw error;
    }

    const subject =
      interaction.fields
        .getTextInputValue(
          'subject',
        )
        .trim();

    const description =
      interaction.fields
        .getTextInputValue(
          'description',
        )
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

          const existingStatus =
            getTopicValue(
              topic,
              'status',
            ) ?? 'open';

          if (
            !isActiveStatus(
              existingStatus,
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
            buildTicketActionRow('open'),
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
    try {
      await interaction.deferReply({
        flags:
          MessageFlags.Ephemeral,
      });
    } catch (error: any) {
      if (error?.code === 10062) {
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
      ticketStatus === 'closed' ||
      ticketStatus === 'archived'
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
    // GENERATE + UPLOAD TRANSCRIPT FIRST
    // ==========================================================
    //
    // Per spec: a ticket is only considered fully closed once its
    // transcript has been generated AND successfully uploaded.
    // If either step fails, the ticket stays open/unlocked so the
    // close can be retried, and no data is lost.
    //

    let transcriptChannelMention: string;

    try {
      const transcriptChannel =
        await getTranscriptChannel(
          interaction,
        );

      if (!transcriptChannel) {
        await interaction.editReply({
          content:
            '❌ The ticket could not be closed because the transcript channel could not be found or created.',
        });

        return;
      }

      let ownerName = 'Unknown User';

      try {
        if (ownerId) {
          const owner =
            await interaction.guild.members.fetch(
              ownerId,
            );

          ownerName =
            owner.displayName ||
            owner.user.username;
        }
      } catch (error) {
        console.warn(
          '⚠️ Could not fetch ticket owner for transcript:',
          error,
        );

        ownerName = ownerId ?? 'Unknown User';
      }

      const transcript =
        await generateTranscript({
          channel,
          ticketNumber,
          subject,
          ownerId: ownerId ?? 'Unknown',
          ownerName,
          closedBy: interaction.user.tag,
          openedAt,
          closedAt,
        });

      await transcriptChannel.send({
        content:
          `📄 **Ticket #${ticketNumber} Transcript**\n` +
          `**Subject:** ${subject}\n` +
          `**Ticket Owner:** ${
            ownerId
              ? `<@${ownerId}>`
              : 'Unknown'
          }\n` +
          `**Closed by:** ${interaction.user}`,

        files: [transcript],
      });

      transcriptChannelMention = `${transcriptChannel}`;
    } catch (error) {
      console.error(
        `❌ Failed to generate or upload transcript for ticket #${ticketNumber}:`,
        error,
      );

      await interaction.editReply({
        content:
          '❌ The ticket could not be closed because the transcript could not be generated or uploaded. Please try again.',
      });

      return;
    }

    // ==========================================================
    // NOW LOCK THE TICKET AND MARK IT CLOSED
    // ==========================================================
    //
    // Only reached once the transcript above has been generated
    // and uploaded successfully.
    //

    try {
      // --------------------------------------------------------
      // LOCK OWNER
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
      // LOCK STAFF ROLE
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

      const closedTopic =
        topic.replace(
          `status=${ticketStatus}`,
          'status=closed',
        );

      await channel.setTopic(
        closedTopic,
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
    // CLOSE CONFIRMATION
    // ==========================================================

    await interaction.editReply({
      content:
        `✅ Ticket #${ticketNumber} is now closed and locked.\n` +
        `🔒 No further messages can be sent in this ticket.\n` +
        `📄 Transcript saved to ${transcriptChannelMention}.`,
    });

    // ==========================================================
    // BACKGROUND CLOSE TASKS (cosmetic — transcript is already
    // safely uploaded and the ticket is already marked closed)
    // ==========================================================

    void Promise.allSettled([
      // --------------------------------------------------------
      // RENAME TICKET
      // --------------------------------------------------------

      (channel.name.endsWith('-closed')
        ? Promise.resolve(channel.name)
        : channel.setName(
            `${channel.name}-closed`,
          )
      ).catch((error) => {
        console.error(
          '❌ Failed to rename closed ticket:',
          error,
        );
      }),

      // --------------------------------------------------------
      // UPDATE TICKET BUTTONS (Reopen / Archive)
      // --------------------------------------------------------

      updateTicketMessageButtons(
        channel,
        messageId,
        'closed',
      ),

      // --------------------------------------------------------
      // SEND CLOSED MESSAGE
      // --------------------------------------------------------

      (async () => {
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
                  value: `Saved to ${transcriptChannelMention}.`,
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
    ]);

    return;
  }

  // ============================================================
  // CLAIM TICKET BUTTON
  // ============================================================

  if (
    interaction.isButton() &&
    interaction.customId === 'ticket:claim'
  ) {
    await handleStatusChangeButton(interaction, {
      allowedFromStatuses: ['open', 'reopened'],
      alreadyInStateMessage:
        'ℹ️ This ticket has already been claimed.',
      requireStaffOrAdmin: true,
      newStatus: 'claimed',
      extraTopicFields: (userId) => ({
        claimedBy: userId,
      }),
      successMessage: (interaction, ticketNumber) =>
        `✅ Ticket #${ticketNumber} has been claimed.`,
      channelEmbed: (interaction, ticketNumber) =>
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('🙋 Ticket Claimed')
          .setDescription(
            `${interaction.user} has claimed ticket #${ticketNumber}.`,
          )
          .setTimestamp(),
    });

    return;
  }

  // ============================================================
  // MARK PENDING BUTTON
  // ============================================================

  if (
    interaction.isButton() &&
    interaction.customId === 'ticket:pending'
  ) {
    await handleStatusChangeButton(interaction, {
      allowedFromStatuses: ['open', 'claimed', 'reopened'],
      alreadyInStateMessage:
        'ℹ️ This ticket is already marked as pending.',
      requireStaffOrAdmin: true,
      newStatus: 'pending',
      successMessage: (interaction, ticketNumber) =>
        `✅ Ticket #${ticketNumber} marked as pending.`,
      channelEmbed: (interaction, ticketNumber) =>
        new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle('⏳ Ticket Pending')
          .setDescription(
            `${interaction.user} marked ticket #${ticketNumber} as pending.`,
          )
          .setTimestamp(),
    });

    return;
  }

  // ============================================================
  // REOPEN TICKET BUTTON
  // ============================================================

  if (
    interaction.isButton() &&
    interaction.customId === 'ticket:reopen'
  ) {
    await handleStatusChangeButton(interaction, {
      allowedFromStatuses: ['closed'],
      alreadyInStateMessage:
        'ℹ️ This ticket is not closed, so it cannot be reopened.',
      requireStaffOrAdmin: true,
      newStatus: 'reopened',
      restorePermissions: true,
      renameOnTransition: (name) =>
        name.endsWith('-closed')
          ? name.slice(0, -'-closed'.length)
          : name,
      successMessage: (interaction, ticketNumber) =>
        `✅ Ticket #${ticketNumber} has been reopened.`,
      channelEmbed: (interaction, ticketNumber) =>
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('🔓 Ticket Reopened')
          .setDescription(
            `${interaction.user} reopened ticket #${ticketNumber}.`,
          )
          .setTimestamp(),
    });

    return;
  }

  // ============================================================
  // ARCHIVE TICKET BUTTON
  // ============================================================

  if (
    interaction.isButton() &&
    interaction.customId === 'ticket:archive'
  ) {
    await handleStatusChangeButton(interaction, {
      allowedFromStatuses: ['closed'],
      alreadyInStateMessage:
        'ℹ️ Only closed tickets can be archived.',
      requireStaffOrAdmin: true,
      newStatus: 'archived',
      successMessage: (interaction, ticketNumber) =>
        `✅ Ticket #${ticketNumber} has been archived.`,
      channelEmbed: (interaction, ticketNumber) =>
        new EmbedBuilder()
          .setColor(0x747f8d)
          .setTitle('🗄️ Ticket Archived')
          .setDescription(
            `${interaction.user} archived ticket #${ticketNumber}.`,
          )
          .setTimestamp(),
    });

    return;
  }
}

// ============================================================
// SHARED STATUS-CHANGE HANDLER
// (Claim / Pending / Reopen / Archive all follow the same
// shape: verify the ticket + status + permission, flip the
// status field in the topic, refresh the button row, and post
// a small notice — this keeps that logic in one place instead
// of four near-identical copies.)
// ============================================================

async function handleStatusChangeButton(
  interaction: ButtonInteraction,
  options: {
    allowedFromStatuses: TicketStatus[];
    alreadyInStateMessage: string;
    requireStaffOrAdmin: boolean;
    newStatus: TicketStatus;
    extraTopicFields?: (
      userId: string,
    ) => Record<string, string>;
    restorePermissions?: boolean;
    renameOnTransition?: (name: string) => string;
    successMessage: (
      interaction: ButtonInteraction,
      ticketNumber: string,
    ) => string;
    channelEmbed: (
      interaction: ButtonInteraction,
      ticketNumber: string,
    ) => EmbedBuilder;
  },
) {
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

  const channel = interaction.channel;

  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.editReply({
      content:
        '❌ This button can only be used inside a ticket channel.',
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

  const ticketStatus =
    (getTopicValue(topic, 'status') as TicketStatus | undefined) ??
    'open';

  if (
    !options.allowedFromStatuses.includes(ticketStatus)
  ) {
    await interaction.editReply({
      content: options.alreadyInStateMessage,
    });

    return;
  }

  const ownerId = getTopicValue(topic, 'owner');
  const staffRoleIdRaw = getTopicValue(topic, 'staff');
  const staffRoleId =
    staffRoleIdRaw && staffRoleIdRaw !== 'none'
      ? staffRoleIdRaw
      : undefined;
  const ticketNumber =
    getTopicValue(topic, 'number') ?? 'Unknown';
  const messageId = getTopicValue(topic, 'message');

  const member = interaction.member;

  const isAdministrator =
    member !== null &&
    'permissions' in member &&
    typeof member.permissions !== 'string' &&
    member.permissions.has(
      PermissionFlagsBits.Administrator,
    );

  const isStaff =
    member !== null &&
    'roles' in member &&
    'cache' in member.roles &&
    !!staffRoleId &&
    member.roles.cache.has(staffRoleId);

  if (
    options.requireStaffOrAdmin &&
    !isStaff &&
    !isAdministrator
  ) {
    await interaction.editReply({
      content:
        '❌ Only support staff or administrators can do that.',
    });

    return;
  }

  // ==============================================================
  // UPDATE TOPIC METADATA
  // ==============================================================

  let newTopic = topic.replace(
    `status=${ticketStatus}`,
    `status=${options.newStatus}`,
  );

  if (options.extraTopicFields) {
    const extraFields = options.extraTopicFields(
      interaction.user.id,
    );

    for (const [key, value] of Object.entries(extraFields)) {
      const pattern = new RegExp(`(?:^|\\s)${key}=[^\\s]+`);

      newTopic = pattern.test(newTopic)
        ? newTopic.replace(pattern, ` ${key}=${value}`)
        : `${newTopic} ${key}=${value}`;
    }
  }

  try {
    await channel.setTopic(newTopic);
  } catch (error) {
    console.error(
      `❌ Failed to update ticket #${ticketNumber} status to ${options.newStatus}:`,
      error,
    );

    await interaction.editReply({
      content:
        '❌ The ticket status could not be updated. Please try again.',
    });

    return;
  }

  // ==============================================================
  // RESTORE PERMISSIONS (used when reopening a closed ticket)
  // ==============================================================

  if (options.restorePermissions) {
    try {
      if (ownerId) {
        await channel.permissionOverwrites.edit(ownerId, {
          ViewChannel: true,
          SendMessages: true,
          AddReactions: true,
          AttachFiles: true,
          EmbedLinks: true,
        });
      }

      if (staffRoleId) {
        await channel.permissionOverwrites.edit(staffRoleId, {
          ViewChannel: true,
          SendMessages: true,
          AddReactions: true,
          AttachFiles: true,
          EmbedLinks: true,
        });
      }
    } catch (error) {
      console.error(
        `❌ Failed to restore permissions for ticket #${ticketNumber}:`,
        error,
      );
    }
  }

  // ==============================================================
  // REPLY + BACKGROUND COSMETIC UPDATES
  // ==============================================================

  await interaction.editReply({
    content: options.successMessage(interaction, ticketNumber),
  });

  void Promise.allSettled([
    updateTicketMessageButtons(
      channel,
      messageId,
      options.newStatus,
    ),

    options.renameOnTransition
      ? channel
          .setName(options.renameOnTransition(channel.name))
          .catch((error) => {
            console.error(
              `❌ Failed to rename ticket #${ticketNumber}:`,
              error,
            );
          })
      : Promise.resolve(),

    channel
      .send({
        embeds: [
          options.channelEmbed(interaction, ticketNumber),
        ],
      })
      .catch((error) => {
        console.error(
          `❌ Failed to send status-change message for ticket #${ticketNumber}:`,
          error,
        );
      }),
  ]);
}

