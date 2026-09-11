import 'dotenv/config';

import {
  Client,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';

import { setupCommand } from './commands/setup';
import { execute as executeSupportForge } from './commands/supportforge';
import { handleTicketInteraction } from './interactions/ticketInteractions';

const token = process.env.DISCORD_TOKEN;

if (!token) {
  throw new Error(
    'DISCORD_TOKEN is missing from environment variables.',
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('clientReady', (readyClient) => {
  console.log(
    `✅ SupportForge is online as ${readyClient.user.tag}`,
  );
});

client.on('interactionCreate', async (interaction) => {
  try {
    // ========================================================
    // SLASH COMMANDS
    // ========================================================

    if (interaction.isChatInputCommand()) {
      // ------------------------------------------------------
      // /setup
      // ------------------------------------------------------

      if (interaction.commandName === 'setup') {
        await setupCommand.execute(interaction);
        return;
      }

      // ------------------------------------------------------
      // /supportforge
      // ------------------------------------------------------

      if (
        interaction.commandName === 'supportforge'
      ) {
        await executeSupportForge(interaction);
        return;
      }

      return;
    }

    // ========================================================
    // BUTTONS + MODALS
    // ========================================================

    if (
      interaction.isButton() ||
      interaction.isModalSubmit()
    ) {
      await handleTicketInteraction(interaction);
      return;
    }
  } catch (error) {
    console.error(
      '❌ Interaction error:',
      error,
    );

    if (!interaction.isRepliable()) {
      return;
    }

    try {
      if (interaction.deferred) {
        await interaction.editReply({
          content:
            '❌ Something went wrong while processing this interaction.',
        });
      } else if (!interaction.replied) {
        await interaction.reply({
          content:
            '❌ Something went wrong while processing this interaction.',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyError) {
      console.error(
        '❌ Failed to send interaction error response:',
        replyError,
      );
    }
  }
});

client.login(token);