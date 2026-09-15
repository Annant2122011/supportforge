import 'dotenv/config';

import {
  Client,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';

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

client.on(
  'interactionCreate',
  async (interaction) => {
    try {
      // ========================================================
      // SLASH COMMANDS
      // ========================================================

      if (
        interaction.isChatInputCommand()
      ) {
        if (
          interaction.commandName ===
          'supportforge'
        ) {
          await executeSupportForge(
            interaction,
          );

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
        await handleTicketInteraction(
          interaction,
        );

        return;
      }
    } catch (error: any) {
      console.error(
        '❌ Interaction error:',
        error,
      );

      // Discord error 10062 means the interaction
      // token is no longer valid. DO NOT attempt
      // another reply.
      if (
        error?.code === 10062
      ) {
        console.warn(
          '⚠️ Discord rejected the interaction because it expired or was already acknowledged.',
        );

        return;
      }

      if (
        !interaction.isRepliable()
      ) {
        return;
      }

      try {
        if (
          interaction.deferred &&
          !interaction.replied
        ) {
          await interaction.editReply({
            content:
              '❌ Something went wrong while processing this interaction.',
          });
        } else if (
          !interaction.replied &&
          !interaction.deferred
        ) {
          await interaction.reply({
            content:
              '❌ Something went wrong while processing this interaction.',
            flags:
              MessageFlags.Ephemeral,
          });
        }
      } catch (replyError: any) {
        if (
          replyError?.code === 10062
        ) {
          console.warn(
            '⚠️ Unable to send interaction error response because the interaction is no longer valid.',
          );

          return;
        }

        console.error(
          '❌ Failed to send interaction error response:',
          replyError,
        );
      }
    }
  },
);
client.login(token);