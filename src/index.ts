import 'dotenv/config';

import {
  Client,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';

import { execute } from './commands/supportforge';
import { handleTicketInteraction } from './interactions/ticketInteractions';

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
});

client.once('ready', (readyClient) => {
  console.log(
    `✅ SupportForge online as ${readyClient.user.tag}`,
  );
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