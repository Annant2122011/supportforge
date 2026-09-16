import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';
import { execute } from './commands/supportforge';
import { handleTicketInteraction } from './interactions/ticketInteractions';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is missing from .env');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', (readyClient) => {
  console.log(`✅ SupportForge online as ${readyClient.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'supportforge') {
      await execute(interaction);
      return;
    }

    if (interaction.isButton() || interaction.isModalSubmit()) {
      await handleTicketInteraction(interaction);
    }
  } catch (error: any) {
    console.error('❌ Interaction error:', error);

    if (!interaction.isRepliable() || interaction.replied || interaction.deferred) return;

    try {
      await interaction.reply({
        content: '❌ SupportForge encountered an unexpected error.',
        flags: MessageFlags.Ephemeral,
      });
    } catch (replyError) {
      console.error('❌ Failed to send error response:', replyError);
    }
  }
});

void client.login(token);
