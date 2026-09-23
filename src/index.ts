import 'dotenv/config';

import {
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';

import { execute } from './commands/supportforge';
import { handleTicketInteraction } from './interactions/ticketInteractions';
import {
  getTicketStatus,
  isTicketTopic,
} from './services/ticketStateService';

import {
  getPersistedTicketStatus,
} from './services/ticketPersistenceService';

const token = process.env.DISCORD_TOKEN;

if (!token) {
  throw new Error(
    'DISCORD_TOKEN is missing from .env',
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  rest: {
    timeout: 15_000,
    retries: 3,
  },
});

client.once('clientReady', (readyClient) => {
  console.log(
    `✅ SupportForge online as ${readyClient.user.tag}`,
  );
});

client.on('messageCreate', async (message) => {
  /*
   * Closed/archived tickets remain interactive through their lifecycle
   * buttons, but human messages are not permitted. This deliberately
   * applies to administrators too, as requested.
   *
   * SupportForge's own bot messages are exempt so the ticket panel and
   * system announcements remain visible.
   */
  if (
    message.author.bot ||
    !message.guild ||
    message.channel.type !== ChannelType.GuildText
  ) {
    return;
  }

  const topic = message.channel.topic ?? '';

  if (!isTicketTopic(topic)) {
    return;
  }

  const topicStatus = getTicketStatus(topic);
  const persistedStatus = await getPersistedTicketStatus(message.channel.id);
  const status = persistedStatus ?? topicStatus;

  if (
    status !== 'closed' &&
    status !== 'archived'
  ) {
    return;
  }

  try {
    await message.delete();

    console.log(
      `🗑️ Deleted message from ${message.author.tag} in ${message.channel.id} because the ticket is ${status}.`,
    );

    try {
      await message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('🤖 SupportForge')
            .setDescription(
              'This is not an error. The ticket is closed, so you cannot send any messages.',
            )
            .setTimestamp(),
        ],
      });
    } catch (notificationError) {
      console.warn(
        `⚠️ Could not send closed-ticket notification in ${message.channel.id}:`,
        notificationError,
      );
    }
  } catch (error) {
    console.error(
      `⚠️ Failed to delete message in ${status} ticket ${message.channel.id}:`,
      error,
    );
  }
});

client.on(
  'interactionCreate',
  async (interaction) => {
    try {
      /*
       * Slash commands
       */
      if (
        interaction.isChatInputCommand() &&
        interaction.commandName ===
          'supportforge'
      ) {
        await execute(interaction);
        return;
      }

      /*
       * Ticket buttons and modals
       */
      if (
        interaction.isButton() ||
        interaction.isModalSubmit()
      ) {
        await handleTicketInteraction(
          interaction,
        );
      }
    } catch (error) {
      console.error(
        '❌ Interaction error:',
        error,
      );

      /*
       * If Discord has already invalidated the
       * interaction token, there is nothing useful
       * we can send back to that interaction.
       */
      if (
        !interaction.isRepliable() ||
        interaction.replied ||
        interaction.deferred
      ) {
        return;
      }

      try {
        await interaction.reply({
          content:
            '❌ SupportForge encountered an unexpected error.',
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyError) {
        console.error(
          '❌ Failed to send error response:',
          replyError,
        );
      }
    }
  },
);

void client.login(token);