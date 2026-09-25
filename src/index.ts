import 'dotenv/config';

import {
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';

import { execute } from './commands/supportforge';
import {
  handleTicketInteraction,
} from './interactions/ticketInteractions';
import {
  getTicketStatus,
  isTicketTopic,
} from './services/ticketStateService';

import {
  getPersistedTicketStatus,
} from './services/ticketPersistenceService';

import { getGuildConfig } from './services/configService';

import { recordTicketMessageForPanel } from './services/panelActivityService';


import { startTicketRetentionScheduler } from './services/ticketRetentionService';
import { removeLegacyCustomCommands } from './services/advancedSettingsService';
import {
  handleAuditInteraction,
  startAuditDailySummaryScheduler,
} from './services/auditLogService';
import { handleSettingsInteraction } from './interactions/settingsInteractions';

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
  startTicketRetentionScheduler(client);
  startAuditDailySummaryScheduler(client);
  void Promise.all(
    client.guilds.cache.map((guild) => removeLegacyCustomCommands(guild)),
  ).catch((error) => console.warn('⚠️ Legacy settings command cleanup failed:', error));
});

client.on('messageCreate', async (message) => {
  if (
    !message.guild ||
    message.channel.type !== ChannelType.GuildText
  ) {
    return;
  }

  const topic = message.channel.topic ?? '';
  const guildConfig = await getGuildConfig(message.guild.id);

  /*
   * The public ticket-panel channel is intentionally read-only.
   * Button interactions remain usable, while direct messages from users
   * and other bots are removed as a fallback against channel noise.
   */
  if (
    guildConfig.panelChannelId === message.channel.id ||
    topic.startsWith('supportforge:panel')
  ) {
    if (message.author.id !== client.user?.id) {
      await message.delete().catch((error) => {
        console.warn(
          `⚠️ Could not remove direct panel-channel message ${message.id}:`,
          error,
        );
      });
    }
    return;
  }

  /*
   * Closed/archived tickets remain interactive through their lifecycle
   * buttons, but direct human messages are not permitted.
   */
  if (message.author.bot) {
    return;
  }

  if (!isTicketTopic(topic)) {
    return;
  }

  const topicStatus = getTicketStatus(topic);
  const persistedStatus = await getPersistedTicketStatus(message.channel.id);
  const status = persistedStatus ?? topicStatus;

  if (
    status === 'closed' ||
    status === 'archived'
  ) {
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

    return;
  }

  void recordTicketMessageForPanel(message).catch((error) => {
    console.warn(
      `⚠️ Ticket panel activity tracking failed in ${message.channel.id}:`,
      error,
    );
  });
});

client.on(
  'interactionCreate',
  async (interaction) => {
    try {
      /*
       * Slash commands
       */
      if (interaction.isChatInputCommand()) {
        if (
          interaction.commandName ===
          'supportforge'
        ) {
          await execute(interaction);
          return;
        }

      }

      /*
       * Ticket buttons and modals
       */
      if (
        interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        interaction.isModalSubmit()
      ) {
        if (interaction.customId.startsWith('sf:audit:') && interaction.isButton()) {
          await handleAuditInteraction(interaction);
          return;
        }

        if (interaction.customId.startsWith('sf:settings:')) {
          await handleSettingsInteraction(interaction);
          return;
        }

        if (interaction.isButton() || interaction.isModalSubmit()) {
          await handleTicketInteraction(interaction);
        }
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