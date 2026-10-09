import 'dotenv/config';

import {
  AuditLogEvent,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  RESTEvents,
} from 'discord.js';

import { execute } from './commands/supportforge';
import {
  handleTicketInteraction,
} from './interactions/ticketInteractions';
import {
  getTicketStatus,
  getField,
  isTicketTopic,
} from './services/ticketStateService';

import {
  getPersistedTicketStatus,
  markPersistedTicketDeleted,
} from './services/ticketPersistenceService';

import { getGuildConfig } from './services/configService';

import {
  clearPanelActivity,
  recordTicketMessageForPanel,
} from './services/panelActivityService';
import { ensureDefaultChannelPurpose, invalidateChannelPurposeCache } from './services/channelPurposeService';


import { startTicketRetentionScheduler } from './services/ticketRetentionService';
import { clearTicketRenameState } from './services/ticketPanelService';
import { clearVoiceTopicRetryState } from './services/voiceModeService';
import { removeLegacyCustomCommands } from './services/advancedSettingsService';
import {
  handleAuditInteraction,
  ensureAuditDeveloperInfrastructure,
  invalidateAuditChannelPanel,
  isSupportForgeManagedChannel,
  isSupportForgeManagedRole,
  logDiscordMutation,
  permissionOverwriteSignature,
  startAuditDailySummaryScheduler,
} from './services/auditLogService';
import { handleSettingsInteraction } from './interactions/settingsInteractions';
import { ensureSettingsChannel } from './services/settingsChannelService';
import { isFactoryResetInProgress } from './services/factoryResetService';
import { startSupportForgeUpdateMonitor } from './services/updateService';
import type { GuildBasedChannel, TextChannel } from 'discord.js';
import { initializePersistence } from './core/persistence/provider';
import { configureDiscordChannelRest } from './services/discordChannelService';

const token = process.env.DISCORD_TOKEN;

if (!token) {
  throw new Error(
    'DISCORD_TOKEN is missing from .env',
  );
}

/*
 * Initialize durable persistence before the Discord client connects. This
 * forces schema migrations and legacy-data validation to happen before the
 * bot can accept any ticket interactions.
 */
async function initializeAndLogin(): Promise<void> {
  try {
    await initializePersistence();
  } catch (error) {
    throw new Error(
      'SupportForge durable database initialization failed. The bot will not start with unverified persistence.',
      { cause: error },
    );
  }

  await client.login(token);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  rest: {
    timeout: 15_000,
    retries: 3,
    // Keep safely below Discord's documented default global ceiling.
    globalRequestsPerSecond: 40,
    invalidRequestWarningInterval: 100,
  },
});

configureDiscordChannelRest(client.rest, (data) => {
  if (!data || typeof data !== 'object') return;
  const payload = data as { guild_id?: unknown; id?: unknown };
  if (typeof payload.guild_id !== 'string' || typeof payload.id !== 'string') return;
  const guild = client.guilds.cache.get(payload.guild_id);
  if (!guild) return;
  const manager = guild.channels as unknown as { _add?: (data: unknown, guild?: unknown) => unknown };
  manager._add?.(data, guild);
});
client.rest.on(RESTEvents.RateLimited, (rateLimit) => {
  console.warn(
    '⚠️ Discord REST rate limit: ' +
    'method=' + rateLimit.method +
    ' route=' + rateLimit.route +
    ' scope=' + rateLimit.scope +
    ' retry_after=' + rateLimit.retryAfter + 'ms' +
    ' global=' + rateLimit.global +
    ' major=' + rateLimit.majorParameter +
    (rateLimit.sublimitTimeout ? ' sublimit=' + rateLimit.sublimitTimeout + 'ms' : ''),
  );
});

client.once('clientReady', (readyClient) => {
  console.log(
    `✅ SupportForge online as ${readyClient.user.tag}`,
  );
  startTicketRetentionScheduler(client);
  startAuditDailySummaryScheduler(client);
  startSupportForgeUpdateMonitor(client);
  /*
   * Run startup repairs sequentially across guilds. Parallel channel/role
   * repairs create avoidable REST bursts on larger bot installations.
   */
  void (async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        await removeLegacyCustomCommands(guild);
      } catch (error) {
        console.warn('⚠️ Legacy settings command cleanup failed for guild ' + guild.id + ':', error);
      }
    }
  })();

  /*
   * Repair existing Developer Audit infrastructure, including stale config
   * IDs and channels whose category was deleted or recreated. Do not silently
   * skip a repair just because the configured category is missing from cache.
   */
  void (async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const config = await getGuildConfig(guild.id);
        const hasDeveloperSignal =
          Boolean(config.auditDevChannelId || config.auditDeveloperRoleId) ||
          guild.roles.cache.some((role) =>
            !role.managed && role.name === 'developer-mode audit-log',
          );
        if (!hasDeveloperSignal) continue;

        let developerChannel: GuildBasedChannel | null | undefined =
          config.auditDevChannelId
            ? guild.channels.cache.get(config.auditDevChannelId)
            : undefined;
        if (!developerChannel && config.auditDevChannelId) {
          developerChannel = await guild.channels.fetch(config.auditDevChannelId).catch(() => null);
        }

        if (developerChannel?.type !== ChannelType.GuildText) {
          developerChannel = guild.channels.cache.find(
            (candidate) =>
              candidate.type === ChannelType.GuildText &&
              candidate.topic?.startsWith('supportforge:audit-dev'),
          );
        }

        let parent = config.supportCategoryId
          ? guild.channels.cache.get(config.supportCategoryId)
          : undefined;
        if (!parent && config.supportCategoryId) {
          parent = (await guild.channels.fetch(config.supportCategoryId).catch(() => null)) ?? undefined;
        }

        if (parent?.type !== ChannelType.GuildCategory) {
          const existingParentId =
            developerChannel?.type === ChannelType.GuildText
              ? developerChannel.parentId
              : null;
          if (existingParentId) {
            parent = guild.channels.cache.get(existingParentId) ??
              (await guild.channels.fetch(existingParentId).catch(() => null)) ??
              undefined;
          }
        }

        if (parent?.type !== ChannelType.GuildCategory) {
          let generalAudit: GuildBasedChannel | null | undefined =
            config.auditChannelId
              ? guild.channels.cache.get(config.auditChannelId)
              : undefined;
          if (!generalAudit && config.auditChannelId) {
            generalAudit = await guild.channels.fetch(config.auditChannelId).catch(() => null);
          }
          if (generalAudit?.type !== ChannelType.GuildText) {
            generalAudit = guild.channels.cache.find(
              (candidate) =>
                candidate.type === ChannelType.GuildText &&
                candidate.topic?.startsWith('supportforge:audit guild='),
            );
          }
          if (generalAudit?.type === ChannelType.GuildText && generalAudit.parentId) {
            parent = guild.channels.cache.get(generalAudit.parentId) ??
              (await guild.channels.fetch(generalAudit.parentId).catch(() => null)) ??
              undefined;
          }
        }

        if (parent?.type === ChannelType.GuildCategory) {
          await ensureAuditDeveloperInfrastructure(guild, parent.id);
        } else {
          console.warn(
            '⚠️ Developer Audit repair skipped for guild ' + guild.id +
            ': no valid SupportForge parent category was found. Run /supportforge setup to recreate it.',
          );
        }
      } catch (error) {
        console.warn('⚠️ Developer Audit startup repair failed for guild ' + guild.id + ':', error);
      }
    }
  })();
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

  const createdTicketChannel =
    guildChannel.type === ChannelType.GuildText &&
    isTicketTopic(guildChannel.topic ?? '');

  void logDiscordMutation(
    guildChannel.guild,
    guildChannel,
    guildChannel.type === ChannelType.GuildCategory
      ? 'CATEGORY_CREATED'
      : 'CHANNEL_CREATED',
    guildChannel.type === ChannelType.GuildCategory
      ? `Created SupportForge category ${guildChannel.name} (${guildChannel.id}).`
      : `Created SupportForge-managed channel ${guildChannel.name} (${guildChannel.id}). Ticket channel: ${createdTicketChannel ? 'yes' : 'no'}.`,
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

  const topicChanged = changes.some((change) =>
    change.startsWith('topic/'),
  );
  const visibleChanges = changes.filter(
    (change) => !change.startsWith('topic/'),
  );

  /*
   * Topic metadata is useful to SupportForge but not useful to users. Store
   * it as an internal audit event while keeping it out of visible reports.
   */
  if (topicChanged) {
    void logDiscordMutation(
      newGuildChannel.guild,
      newGuildChannel,
      'CHANNEL_TOPIC_CHANGED',
      'SupportForge internal channel metadata changed.',
      AuditLogEvent.ChannelUpdate,
    );
  }

  if (!visibleChanges.length) return;

  const event =
    visibleChanges.some((change) => change.startsWith('name:'))
      ? 'CHANNEL_RENAMED'
      : visibleChanges.some((change) => change.startsWith('parent:'))
        ? 'CHANNEL_MOVED'
        : visibleChanges.some((change) => change.startsWith('position:'))
          ? 'CHANNEL_REORDERED'
          : visibleChanges.some((change) => change.startsWith('permission'))
            ? 'CHANNEL_PERMISSIONS_CHANGED'
            : 'CHANNEL_SETTINGS_CHANGED';

  void logDiscordMutation(
    newGuildChannel.guild,
    newGuildChannel,
    event,
    visibleChanges.join(' • '),
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

  const deletedTicketTopic =
    guildChannel.type === ChannelType.GuildText
      ? guildChannel.topic ?? ''
      : '';

  if (isTicketTopic(deletedTicketTopic)) {
    clearPanelActivity(guildChannel.id);
    clearTicketRenameState(guildChannel.id);
    clearVoiceTopicRetryState(guildChannel.id);

    /*
     * Manual ticket deletion must update durable lifecycle storage and remove
     * any temporary voice room owned by the deleted ticket.
     */
    await markPersistedTicketDeleted(
      guildChannel.id,
      'SupportForge ticket channel deleted',
    ).catch((error) => {
      console.warn(
        `⚠️ Could not mark deleted ticket ${guildChannel.id} in persistent storage:`,
        error,
      );
    });

    const voiceChannelId = getField(
      deletedTicketTopic,
      'voice_channel_id',
    );

    if (voiceChannelId) {
      const voiceChannel = guildChannel.guild.channels.cache.get(voiceChannelId);

      if (voiceChannel) {
        await voiceChannel.delete(
          'SupportForge cleanup after ticket deletion',
        ).catch((error) => {
          console.warn(
            `⚠️ Could not delete orphaned ticket voice channel ${voiceChannelId}:`,
            error,
          );
        });
      }
    }
  }

  const deletedWasSettings =
    guildChannel.type === ChannelType.GuildText &&
    guildChannel.topic?.startsWith('supportforge:settings');

  void logDiscordMutation(
    guildChannel.guild,
    guildChannel,
    guildChannel.type === ChannelType.GuildCategory
      ? 'CATEGORY_DELETED'
      : 'CHANNEL_DELETED',
    guildChannel.type === ChannelType.GuildCategory
      ? `Deleted SupportForge category ${guildChannel.name} (${guildChannel.id}).`
      : `Deleted SupportForge-managed channel ${guildChannel.name} (${guildChannel.id}). Ticket channel: ${
          guildChannel.type === ChannelType.GuildText &&
          isTicketTopic(guildChannel.topic ?? '')
            ? 'yes'
            : 'no'
        }.`,
    AuditLogEvent.ChannelDelete,
  );

  /*
   * Settings is the recovery hub. If somebody deletes it manually while the
   * main Support Forge category still exists, recreate it immediately.
   * If the entire SupportForge structure was deleted, /supportforge setup
   * remains the explicit recovery path.
   */
  if (deletedWasSettings && !isFactoryResetInProgress(guildChannel.guild.id)) {
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


function formatExactMessageContent(content: string): string {
  const backtick = String.fromCharCode(96);
  const runs = content.match(new RegExp(backtick + '+', 'g')) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = backtick.repeat(Math.max(3, longestRun + 1));
  return fence + '\n' + content + '\n' + fence;
}

client.on('messageDelete', (message) => {
  if (message.channel.type !== ChannelType.GuildText || message.author?.id !== client.user?.id) return;

  const purposeWasDeleted = message.embeds.some((embed) =>
    embed.title === '📝 SupportForge Channel Purpose' &&
    embed.footer?.text === 'SupportForge • Channel Purpose',
  );
  if (purposeWasDeleted) invalidateChannelPurposeCache(message.channel.id);

  const auditPanelWasDeleted = message.components.some((row) => {
    // Discord.js top-level components can include components without children
    // (for example files/media). Only inspect action-row-like containers.
    if (!('components' in row) || !Array.isArray(row.components)) return false;

    return row.components.some((component) =>
      'customId' in component &&
      typeof component.customId === 'string' &&
      component.customId.startsWith('sf:audit:'),
    );
  });
  if (auditPanelWasDeleted) invalidateAuditChannelPanel(message.channel.id);
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
        const exactContent = message.content;
        const description = exactContent
          ? 'This ticket is **' + status + '**, so your message was removed. The exact text you attempted to send is preserved below, word-for-word. You do not need to retype it.\\n\\n' + formatExactMessageContent(exactContent)
          : 'This ticket is **' + status + '**, so your message was removed. The attempted message contained no text content.';
        await message.channel.send({
          allowedMentions: { parse: [] },
          embeds: [
            new EmbedBuilder()
              .setTitle('🤖 SupportForge • Message Preserved')
              .setDescription(description)
              .setFooter({ text: 'Read-only reproduction of the exact text you attempted to send.' })
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

        if (
          interaction.isButton() ||
          interaction.isStringSelectMenu() ||
          interaction.isModalSubmit()
        ) {
          await handleTicketInteraction(interaction);
        }
      }
    } catch (error) {
      console.error(
        '❌ Interaction error:',
        error,
      );

      /*
       * Every interaction path should leave the user with a visible
       * failure state. A previously deferred component can still be edited,
       * which is preferable to silently leaving an old/stale panel on screen.
       */
      if (!interaction.isRepliable()) {
        return;
      }

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({
            content: '❌ SupportForge encountered an unexpected error while processing this action.',
          });
        } else {
          await interaction.reply({
            content: '❌ SupportForge encountered an unexpected error while processing this action.',
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
  },
);

void initializeAndLogin().catch((error) => {
  console.error('❌ SupportForge startup failed:', error);
  process.exitCode = 1;
});