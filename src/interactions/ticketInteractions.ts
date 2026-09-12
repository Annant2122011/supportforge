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

const TRANSCRIPT_CHANNEL_NAME = '📄 support-transcripts';
const TICKET_TOPIC_PREFIX = 'supportforge:ticket';

function getTopicValue(topic: string, key: string): string | undefined {
  const match = topic.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
  return match?.[1];
}

function getSubjectFromTopic(topic: string): string {
  const match = topic.match(/(?:^|\s)subject=(.*?)\s+number=/);
  return match?.[1] ?? 'Unknown Subject';
}

function findTranscriptChannel(interaction: ButtonInteraction | ModalSubmitInteraction) {
  return interaction.guild?.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.name === TRANSCRIPT_CHANNEL_NAME,
  );
}

async function getTranscriptChannel(
  interaction: ButtonInteraction | ModalSubmitInteraction,
) {
  if (!interaction.guild) return null;

  const existing = findTranscriptChannel(interaction);
  if (existing?.type === ChannelType.GuildText) return existing;

  const botMember = interaction.guild.members.me;
  if (!botMember) {
    throw new Error('Could not find SupportForge bot member.');
  }

  try {
    return await interaction.guild.channels.create({
      name: TRANSCRIPT_CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: 'SupportForge ticket transcripts. Do not delete this channel.',
      permissionOverwrites: [
        {
          id: interaction.guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
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
    // Another close/setup operation may have created it between the cache
    // lookup and create call. Refresh the cache and use that channel.
    if (error?.code === 50013 || error?.code === 40060) throw error;

    const raced = findTranscriptChannel(interaction);
    if (raced?.type === ChannelType.GuildText) return raced;
    throw error;
  }
}

async function sendErrorReply(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  content: string,
) {
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content });
    } else if (!interaction.replied) {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (error: any) {
    if (error?.code !== 10062) console.error('❌ Failed to send error reply:', error);
  }
}

export async function handleTicketInteraction(
  interaction: ButtonInteraction | ModalSubmitInteraction,
) {
  if (!interaction.guild) {
    await sendErrorReply(interaction, '❌ This can only be used inside a server.');
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('ticket:create:')) {
    const categoryId = interaction.customId.split(':')[2];
    if (!categoryId) {
      await sendErrorReply(interaction, '❌ Ticket category could not be found.');
      return;
    }

    const category = interaction.guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      await sendErrorReply(interaction, '❌ This ticket category no longer exists.');
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`ticket:modal:${categoryId}`)
      .setTitle('Create Support Ticket');

    const subjectInput = new TextInputBuilder()
      .setCustomId('subject')
      .setLabel('Subject')
      .setPlaceholder('What do you need help with?')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const descriptionInput = new TextInputBuilder()
      .setCustomId('description')
      .setLabel('Describe your issue')
      .setPlaceholder('Please provide as much detail as possible.')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(subjectInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput),
    );

    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket:modal:')) {
    const categoryId = interaction.customId.split(':')[2];
    if (!categoryId) {
      await sendErrorReply(interaction, '❌ Ticket category could not be found.');
      return;
    }

    const category = interaction.guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      await sendErrorReply(interaction, '❌ The SupportForge ticket category no longer exists.');
      return;
    }

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error: any) {
      if (error?.code === 10062) return;
      throw error;
    }

    const subject = interaction.fields.getTextInputValue('subject').trim();
    const description = interaction.fields.getTextInputValue('description').trim();

    if (!subject || !description) {
      await interaction.editReply({ content: '❌ Subject and description cannot be empty.' });
      return;
    }

    const staffRoleOverwrite = category.permissionOverwrites.cache.find(
      (overwrite) =>
        overwrite.type === 0 &&
        overwrite.id !== interaction.guild!.roles.everyone.id &&
        overwrite.id !== interaction.client.user.id &&
        overwrite.allow.has(PermissionFlagsBits.ViewChannel),
    );
    const staffRoleId = staffRoleOverwrite?.id;

    const existingTicket = interaction.guild.channels.cache.find(
      (channel) =>
        channel.parentId === categoryId &&
        channel.type === ChannelType.GuildText &&
        channel.topic?.startsWith(TICKET_TOPIC_PREFIX) &&
        channel.topic?.includes('status=open') &&
        channel.topic?.includes(`owner=${interaction.user.id}`),
    );

    if (existingTicket) {
      await interaction.editReply({
        content: `❌ You already have an open ticket in this category: ${existingTicket}`,
      });
      return;
    }

    let ticketNumber = 0;
    let ticketName = '';
    do {
      ticketNumber = Math.floor(1000 + Math.random() * 9000);
      ticketName = `ticket-${ticketNumber}`;
    } while (interaction.guild.channels.cache.some((channel) => channel.name === ticketName));

    const permissionOverwrites = [
      {
        id: interaction.guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
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

    let ticketChannel;
    try {
      ticketChannel = await interaction.guild.channels.create({
        name: ticketName,
        type: ChannelType.GuildText,
        parent: categoryId,
        topic:
          `${TICKET_TOPIC_PREFIX} ` +
          `status=open ` +
          `owner=${interaction.user.id} ` +
          `category=${categoryId} ` +
          `staff=${staffRoleId ?? 'none'} ` +
          `subject=${subject.replace(/\s+/g, ' ')} ` +
          `number=${ticketNumber}`,
        permissionOverwrites,
      });
    } catch (error) {
      console.error('❌ Failed to create ticket channel:', error);
      await interaction.editReply({ content: '❌ The ticket could not be created. Please try again.' });
      return;
    }

    const ticketEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎫 Support Ticket')
      .setDescription(description)
      .addFields(
        { name: '👤 Ticket Owner', value: `${interaction.user}` },
        { name: '📌 Subject', value: subject },
        { name: '📂 Category', value: category.name },
      )
      .setFooter({ text: `Ticket #${ticketNumber} • Created by ${interaction.user.tag}` })
      .setTimestamp();

    const closeButton = new ButtonBuilder()
      .setCustomId('ticket:close')
      .setLabel('Close Ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger);

    try {
      const ticketMessage = await ticketChannel.send({
        content: `${interaction.user} ${staffRoleId ? `<@&${staffRoleId}>` : ''}`.trim(),
        embeds: [ticketEmbed],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton)],
      });

      await ticketChannel.setTopic(`${ticketChannel.topic ?? ''} message=${ticketMessage.id}`);
    } catch (error) {
      console.error('❌ Failed to initialize ticket:', error);
      try {
        await ticketChannel.delete('SupportForge cleanup after ticket creation failure');
      } catch (deleteError) {
        console.error('❌ Failed to clean up ticket channel:', deleteError);
      }
      await interaction.editReply({ content: '❌ The ticket could not be initialized. Please try again.' });
      return;
    }

    await interaction.editReply({ content: `✅ Your ticket has been created: ${ticketChannel}` });
    return;
  }

  if (interaction.isButton() && interaction.customId === 'ticket:close') {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error: any) {
      if (error?.code === 10062) return;
      throw error;
    }

    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply({ content: '❌ This button can only be used inside a ticket channel.' });
      return;
    }

    const topic = channel.topic ?? '';
    if (!topic.startsWith(TICKET_TOPIC_PREFIX)) {
      await interaction.editReply({ content: '❌ This channel is not a SupportForge ticket.' });
      return;
    }

    const ticketStatus = getTopicValue(topic, 'status') ?? 'open';
    if (ticketStatus === 'closed') {
      await interaction.editReply({ content: 'ℹ️ This ticket is already closed.' });
      return;
    }

    const ownerId = getTopicValue(topic, 'owner');
    const staffRoleIdRaw = getTopicValue(topic, 'staff');
    const staffRoleId = staffRoleIdRaw && staffRoleIdRaw !== 'none' ? staffRoleIdRaw : undefined;
    const ticketNumber = getTopicValue(topic, 'number') ?? 'Unknown';
    const messageId = getTopicValue(topic, 'message');
    const subject = getSubjectFromTopic(topic);

    // Do not fetch the closing member from the API just to check permissions.
    // The interaction already contains the guild member and its current roles.
    const member = interaction.member;
    const permissions = 'permissions' in member ? member.permissions : null;
    const roles = 'roles' in member && 'cache' in member.roles ? member.roles.cache : null;

    const isAdministrator = permissions?.has(PermissionFlagsBits.Administrator) ?? false;
    const isStaff = !!staffRoleId && !!roles?.has(staffRoleId);
    const isOwner = ownerId === interaction.user.id;

    if (!isOwner && !isStaff && !isAdministrator) {
      await interaction.editReply({ content: '❌ You do not have permission to close this ticket.' });
      return;
    }

    const openedAt = channel.createdAt;
    const closedAt = new Date();

    // This is the only operation that must succeed before we tell the user
    // the ticket is closed. Everything else is post-close housekeeping.
    try {
      await channel.setTopic(topic.replace('status=open', 'status=closed'));
    } catch (error) {
      console.error('❌ Failed to update ticket status:', error);
      await interaction.editReply({
        content: '❌ The ticket could not be closed because its status could not be updated.',
      });
      return;
    }

    // The ticket is now logically closed. Reply immediately instead of making
    // the user wait for permission edits, renaming, message fetching or a
    // transcript upload. Humans have already waited enough for computers.
    await interaction.editReply({
      content: `✅ Ticket #${ticketNumber} is now closed.\n🔒 The channel is being locked and the transcript is being generated in the background.`,
    });

    const closeTasks = [
      channel.permissionOverwrites.edit(
        ownerId ?? interaction.guild.roles.everyone.id,
        {
          ViewChannel: true,
          SendMessages: false,
          AddReactions: false,
          AttachFiles: false,
          EmbedLinks: false,
        },
      ).catch((error) => console.error('❌ Failed to lock ticket owner:', error)),

      staffRoleId
        ? channel.permissionOverwrites.edit(staffRoleId, {
            ViewChannel: true,
            SendMessages: false,
            AddReactions: false,
            AttachFiles: false,
            EmbedLinks: false,
          }).catch((error) => console.error('❌ Failed to lock staff role:', error))
        : Promise.resolve(),

      channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
        ViewChannel: false,
        SendMessages: false,
        AddReactions: false,
        AttachFiles: false,
        EmbedLinks: false,
      }).catch((error) => console.error('❌ Failed to lock @everyone permissions:', error)),

      channel.setName(channel.name.endsWith('-closed') ? channel.name : `${channel.name}-closed`)
        .catch((error) => console.error('❌ Failed to rename closed ticket:', error)),

      (async () => {
        if (!messageId) {
          console.warn(`⚠️ No original ticket message ID stored for ticket #${ticketNumber}.`);
          return;
        }

        try {
          const originalTicketMessage = await channel.messages.fetch(messageId);
          const closedButton = new ButtonBuilder()
            .setCustomId('ticket:closed')
            .setLabel('Ticket Closed')
            .setEmoji('🔒')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);

          await originalTicketMessage.edit({
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(closedButton)],
          });
        } catch (error) {
          console.error('❌ Failed to disable original ticket button:', error);
        }
      })(),

      (async () => {
        try {
          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x747f8d)
                .setTitle('🔒 Ticket Closed')
                .setDescription(`This ticket was closed by ${interaction.user}.`)
                .addFields({ name: '🎫 Ticket', value: `#${ticketNumber}` })
                .addFields({ name: '📄 Transcript', value: '⏳ Transcript is being generated...' })
                .setTimestamp(),
            ],
          });
        } catch (error) {
          console.error('❌ Failed to send closed message:', error);
        }
      })(),
    ];

    // Post-close housekeeping must never block the interaction lifecycle.
    void Promise.allSettled(closeTasks).then(() => {
      void generateAndUploadTranscript({
        interaction,
        channel,
        ticketNumber,
        subject,
        ownerId: ownerId ?? 'Unknown',
        openedAt,
        closedAt,
      });
    });

    return;
  }
}

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
  channel: Extract<typeof interaction.channel, { type: ChannelType.GuildText }>;
  ticketNumber: string;
  subject: string;
  ownerId: string;
  openedAt: Date;
  closedAt: Date;
}) {
  try {
    let ownerName = 'Unknown User';

    try {
      if (ownerId !== 'Unknown') {
        const owner = await interaction.guild.members.fetch(ownerId);
        ownerName = owner.displayName || owner.user.username;
      }
    } catch (error) {
      console.warn('⚠️ Could not fetch ticket owner:', error);
      ownerName = ownerId;
    }

    const transcriptChannel = await getTranscriptChannel(interaction);
    if (!transcriptChannel) {
      await channel.send({ content: '⚠️ Ticket closed, but the transcript channel could not be found.' }).catch(() => undefined);
      return;
    }

    console.log(`📄 Generating transcript for ticket #${ticketNumber}...`);

    const transcript = await generateTranscript({
      channel,
      ticketNumber,
      subject,
      ownerId,
      ownerName,
      closedBy: interaction.user.tag,
      openedAt,
      closedAt,
    });

    await transcriptChannel.send({
      content:
        `📄 **Ticket #${ticketNumber} Transcript**\n` +
        `**Subject:** ${subject}\n` +
        `**Ticket Owner:** <@${ownerId !== 'Unknown' ? ownerId : '0'}>\n` +
        `**Closed by:** ${interaction.user}`,
      files: [transcript],
    });

    await channel.send({
      content: `📄 Transcript for ticket #${ticketNumber} has been saved in ${transcriptChannel}.`,
    });

    console.log(`✅ Transcript uploaded for ticket #${ticketNumber}.`);
  } catch (error) {
    console.error(`❌ Background transcript processing failed for ticket #${ticketNumber}:`, error);

    try {
      await channel.send({
        content: `⚠️ Ticket #${ticketNumber} was closed successfully, but the transcript could not be generated or uploaded.`,
      });
    } catch (sendError) {
      console.error('❌ Failed to send transcript failure message:', sendError);
    }
  }
}
