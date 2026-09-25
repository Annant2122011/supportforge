import 'dotenv/config';

import {
  AuditLogEvent,
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
import { ensureDefaultChannelPurpose } from './services/channelPurposeService';


import { startTicketRetentionScheduler } from './services/ticketRetentionService';
import { removeLegacyCustomCommands } from './services/advancedSettingsService';
import {
  handleAuditInteraction,
  isSupportForgeManagedChannel,
  isSupportForgeManagedRole,
  logDiscordMutation,
  permissionOverwriteSignature,
  startAuditDailySummaryScheduler,
} from './services/auditLogService';
import { handleSettingsInteraction } from './interactions/settingsInteractions';
import { ensureSettingsChannel } from './services/settingsChannelService';
import type { GuildBasedChannel, TextChannel } from 'discord.js';

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

client.on('channelCreate', async (channel) => {
  if (!('guild' in channel)) {
    return;
  }

  const guildChannel = channel as GuildBasedChannel;

  const managed = await isSupportForgeManagedChannel(
    guildChannel.guild,
    guildChannel,
  );

  if (!managed) {
    return;
  }

  /*
   * Only text channels receive purpose messages. Tickets and the public
   * panel remain explicit exceptions.
   */
  if (
    guildChannel.type === ChannelType.GuildText &&
    !guildChannel.topic?.startsWith('supportforge:panel') &&
    !guildChannel.topic?.startsWith('supportforge:ticket')
  ) {
    void ensureDefaultChannelPurpose(guildChannel).catch((error) => {
      console.warn(
        `⚠️ Could not add SupportForge purpose message to ${guildChannel.id}:`,
        error,
      );
    });
  }

  void logDiscordMutation(
    guildChannel.guild,
    guildChannel,
    guildChannel.type === ChannelType.GuildCategory
      ? 'CATEGORY_CREATED'
      : 'CHANNEL_CREATED',
    `Created SupportForge-managed ${guildChannel.type === ChannelType.GuildCategory ? 'category' : 'channel'} ${guildChannel.name} (${guildChannel.id}).`,
    AuditLogEvent.ChannelCreate,
  );
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (
    !('guild' in oldChannel) ||
    !('guild' in newChannel)
  ) {
    return;
  }

  const oldGuildChannel = oldChannel as GuildBasedChannel;
  const newGuildChannel = newChannel as GuildBasedChannel;

  const oldManaged = await isSupportForgeManagedChannel(
    newGuildChannel.guild,
    oldGuildChannel,
  );
  const newManaged = await isSupportForgeManagedChannel(
    newGuildChannel.guild,
    newGuildChannel,
  );

  if (!oldManaged && !newManaged) return;

  const changes: string[] = [];

  if (oldGuildChannel.name !== newGuildChannel.name) {
    changes.push(`name: ${oldGuildChannel.name} → ${newGuildChannel.name}`);
  }

  if (oldGuildChannel.parentId !== newGuildChannel.parentId) {
    changes.push(
      `parent: ${oldGuildChannel.parentId ?? 'none'} → ${newGuildChannel.parentId ?? 'none'}`,
    );
  }

  if (
    oldGuildChannel.type === ChannelType.GuildText &&
    newGuildChannel.type === ChannelType.GuildText &&
    oldGuildChannel.topic !== newGuildChannel.topic
  ) {
    changes.push('topic/metadata changed');
  }

  const oldPermissions = permissionOverwriteSignature(oldGuildChannel);
  const newPermissions = permissionOverwriteSignature(newGuildChannel);

  if (oldPermissions !== newPermissions) {
    changes.push('permission overwrites changed');
  }

  if (
    'position' in oldGuildChannel &&
    'position' in newGuildChannel &&
    oldGuildChannel.position !== newGuildChannel.position
  ) {
    changes.push(
      `position: ${oldGuildChannel.position} → ${newGuildChannel.position}`,
    );
  }

  if (
    oldGuildChannel.type === ChannelType.GuildText &&
    newGuildChannel.type === ChannelType.GuildText
  ) {
    if (oldGuildChannel.nsfw !== newGuildChannel.nsfw) {
      changes.push(`NSFW: ${oldGuildChannel.nsfw} → ${newGuildChannel.nsfw}`);
    }

    if (oldGuildChannel.rateLimitPerUser !== newGuildChannel.rateLimitPerUser) {
      changes.push(
        `slowmode: ${oldGuildChannel.rateLimitPerUser}s → ${newGuildChannel.rateLimitPerUser}s`,
      );
    }
  }

  if (!changes.length) return;

  const event =
    changes.some((change) => change.startsWith('name:'))
      ? 'CHANNEL_RENAMED'
      : changes.some((change) => change.startsWith('parent:'))
        ? 'CHANNEL_MOVED'
        : changes.some((change) => change.startsWith('position:'))
          ? 'CHANNEL_REORDERED'
          : changes.some((change) => change.startsWith('topic/'))
            ? 'CHANNEL_TOPIC_CHANGED'
            : changes.some((change) => change.startsWith('permission'))
              ? 'CHANNEL_PERMISSIONS_CHANGED'
              : 'CHANNEL_SETTINGS_CHANGED';

  void logDiscordMutation(
    newGuildChannel.guild,
    newGuildChannel,
    event,
    changes.join(' • '),
    AuditLogEvent.ChannelUpdate,
  );
});

client.on('channelDelete', async (channel) => {
  if (!('guild' in channel)) {
    return;
  }

  const guildChannel = channel as GuildBasedChannel;

  const managed = await isSupportForgeManagedChannel(
    guildChannel.guild,
    guildChannel,
  );

  if (!managed) return;

  const deletedWasSettings =
    guildChannel.type === ChannelType.GuildText &&
    guildChannel.topic?.startsWith('supportforge:settings');

  void logDiscordMutation(
    guildChannel.guild,
    guildChannel,
    guildChannel.type === ChannelType.GuildCategory
      ? 'CATEGORY_DELETED'
      : 'CHANNEL_DELETED',
    `Deleted SupportForge-managed ${guildChannel.type === ChannelType.GuildCategory ? 'category' : 'channel'} ${guildChannel.name} (${guildChannel.id}).`,
    AuditLogEvent.ChannelDelete,
  );

  /*
   * Settings is the recovery hub. If somebody deletes it manually while the
   * main Support Forge category still exists, recreate it immediately.
   * If the entire SupportForge structure was deleted, /supportforge setup
   * remains the explicit recovery path.
   */
  if (deletedWasSettings) {
    const config = await getGuildConfig(guildChannel.guild.id);
    if (config.supportCategoryId) {
      const parent = guildChannel.guild.channels.cache.get(
        config.supportCategoryId,
      );

      if (parent?.type === ChannelType.GuildCategory) {
        await ensureSettingsChannel(
          guildChannel.guild,
          parent.id,
        ).catch((error) => {
          console.warn(
            `⚠️ Automatic SupportForge Settings recovery failed for ${guildChannel.guild.id}:`,
            error,
          );
        });
      }
    }
  }
});

client.on('roleCreate', async (role) => {
  if (!role.guild) return;

  if (!(await isSupportForgeManagedRole(role.guild, role))) {
    return;
  }

  void logDiscordMutation(
    role.guild,
    role,
    'ROLE_CREATED',
    `Created SupportForge-managed role ${role.name} (${role.id}).`,
    AuditLogEvent.RoleCreate,
  );
});

client.on('roleUpdate', async (oldRole, newRole) => {
  if (
    !(await isSupportForgeManagedRole(newRole.guild, oldRole)) &&
    !(await isSupportForgeManagedRole(newRole.guild, newRole))
  ) {
    return;
  }

  const changes: string[] = [];

  if (oldRole.name !== newRole.name) {
    changes.push(`name: ${oldRole.name} → ${newRole.name}`);
  }

  if (oldRole.color !== newRole.color) {
    changes.push(`color: ${oldRole.color} → ${newRole.color}`);
  }

  if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
    changes.push('permissions changed');
  }

  if (oldRole.hoist !== newRole.hoist) {
    changes.push(`hoist: ${oldRole.hoist} → ${newRole.hoist}`);
  }

  if (oldRole.mentionable !== newRole.mentionable) {
    changes.push(`mentionable: ${oldRole.mentionable} → ${newRole.mentionable}`);
  }

  if (!changes.length) return;

  void logDiscordMutation(
    newRole.guild,
    newRole,
    'ROLE_UPDATED',
    changes.join(' • '),
    AuditLogEvent.RoleUpdate,
  );
});

client.on('roleDelete', async (role) => {
  if (!role.guild) return;

  if (!(await isSupportForgeManagedRole(role.guild, role))) {
    return;
  }

  void logDiscordMutation(
    role.guild,
    role,
    'ROLE_DELETED',
    `Deleted SupportForge-managed role ${role.name} (${role.id}).`,
    AuditLogEvent.RoleDelete,
  );
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