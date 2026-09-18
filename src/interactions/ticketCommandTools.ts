import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';

import {
  getGuildConfig,
  getTier,
  isPremiumOrHigher,
} from '../services/configService';
import {
  getOrCreateAuditChannel,
  logTicketEvent,
} from '../services/auditLogService';
import {
  getField,
  getTicketStatus,
  removeField,
  setField,
} from '../services/ticketStateService';
import { queueTicketChannelRename, refreshTicketPanel } from '../services/ticketPanelService';

const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent', 'critical']);

async function getTicketContext(interaction: ChatInputCommandInteraction) {
  const channel = interaction.channel;

  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('This command must be used in a text ticket channel.');
  }

  const topic = channel.topic ?? '';
  if (!topic.startsWith('supportforge:ticket')) {
    throw new Error('This channel is not a SupportForge ticket.');
  }

  const guild = interaction.guild;
  if (!guild) throw new Error('This command can only be used inside a server.');

  const config = await getGuildConfig(guild.id);
  const member = await guild.members.fetch(interaction.user.id);
  const staffRoleId = getField(topic, 'staff');
  const isStaff = Boolean(
    staffRoleId &&
      staffRoleId !== 'none' &&
      member.roles.cache.has(staffRoleId),
  );

  return {
    guild,
    channel,
    topic,
    config,
    isStaff,
    isAdmin: Boolean(
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator),
    ),
    ticketNumber: getField(topic, 'number') ?? 'Unknown',
    ownerId: getField(topic, 'owner'),
    claimedBy: getField(topic, 'claimed_by'),
    status: getTicketStatus(topic),
  };
}

async function audit(
  interaction: ChatInputCommandInteraction,
  context: Awaited<ReturnType<typeof getTicketContext>>,
  event: string,
  detail?: string,
): Promise<void> {
  if (!context.config.supportCategoryId || !isPremiumOrHigher(context.config.tier)) return;

  await logTicketEvent(context.guild, context.config.supportCategoryId, {
    ticketNumber: context.ticketNumber,
    event,
    actor: interaction.user.tag,
    detail,
  });
}

async function saveTopic(
  context: Awaited<ReturnType<typeof getTicketContext>>,
  topic: string,
): Promise<void> {
  await context.channel.setTopic(topic);
  await refreshTicketPanel(context.channel, topic);
}

export async function executeTicketCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const context = await getTicketContext(interaction);
    const subcommand = interaction.options.getSubcommand();
    const tier = await getTier(context.guild.id);

    if (!context.isStaff && !context.isAdmin) {
      await interaction.editReply(
        '❌ Only the configured department staff or an administrator can use ticket management commands.',
      );
      return;
    }

    if (
      ['priority', 'tag', 'note', 'history'].includes(subcommand) &&
      !isPremiumOrHigher(tier)
    ) {
      await interaction.editReply(
        '🔒 This feature is available in Premium/Pro demo mode. Run `/supportforge premium toggle-demo` as an administrator to preview it.',
      );
      return;
    }

    if (subcommand === 'claim') {
      if (context.status === 'closed' || context.status === 'archived') {
        await interaction.editReply(
          `❌ Ticket #${context.ticketNumber} is **${context.status}** and cannot be claimed.`,
        );
        return;
      }

      if (context.status === 'pending') {
        await interaction.editReply(
          `⏳ Ticket #${context.ticketNumber} is currently **pending**. Resume it before claiming.`,
        );
        return;
      }

      if (context.status === 'claimed') {
        await interaction.editReply(
          context.claimedBy === interaction.user.id
            ? `ℹ️ You already have ticket #${context.ticketNumber} claimed.`
            : `❌ Ticket #${context.ticketNumber} is already claimed by <@${context.claimedBy ?? '0'}>.`,
        );
        return;
      }

      let topic = setField(context.topic, 'status', 'claimed');
      topic = setField(topic, 'claimed_by', interaction.user.id);
      topic = setField(topic, 'claimed_at', new Date().toISOString());
      topic = removeField(topic, 'pending_since');

      await saveTopic(context, topic);
      await context.channel.send(`🎯 ${interaction.user} claimed ticket #${context.ticketNumber}.`);
      await audit(interaction, context, `Ticket claimed by ${interaction.user.tag}`);
      await interaction.editReply(`✅ Ticket #${context.ticketNumber} is now **claimed by you**.`);
      return;
    }

    if (subcommand === 'unclaim') {
      if (context.status !== 'claimed') {
        await interaction.editReply(`ℹ️ Ticket #${context.ticketNumber} is not currently claimed.`);
        return;
      }

      if (context.claimedBy !== interaction.user.id && !context.isAdmin) {
        await interaction.editReply('❌ Only the current claimant or an administrator can unclaim this ticket.');
        return;
      }

      let topic = setField(context.topic, 'status', 'open');
      topic = removeField(topic, 'claimed_by');
      topic = removeField(topic, 'claimed_at');

      await saveTopic(context, topic);
      await context.channel.send(`↩️ Ticket #${context.ticketNumber} was unclaimed by ${interaction.user}.`);
      await audit(interaction, context, `Ticket unclaimed by ${interaction.user.tag}`);
      await interaction.editReply(`✅ Ticket #${context.ticketNumber} is now **open**.`);
      return;
    }

    if (subcommand === 'pending') {
      if (context.status === 'closed' || context.status === 'archived') {
        await interaction.editReply(
          `❌ Ticket #${context.ticketNumber} is **${context.status}** and cannot be marked pending.`,
        );
        return;
      }

      if (context.status === 'pending') {
        await interaction.editReply(`ℹ️ Ticket #${context.ticketNumber} is already pending.`);
        return;
      }

      let topic = setField(context.topic, 'status', 'pending');
      topic = setField(topic, 'pending_since', new Date().toISOString());
      topic = removeField(topic, 'claimed_by');
      topic = removeField(topic, 'claimed_at');

      await saveTopic(context, topic);
      await context.channel.send(`⏳ Ticket #${context.ticketNumber} has been marked **pending** by ${interaction.user}.`);
      await audit(interaction, context, `Ticket marked pending by ${interaction.user.tag}`);
      await interaction.editReply(`⏳ Ticket #${context.ticketNumber} is now **pending**.`);
      return;
    }

    if (subcommand === 'resume') {
      if (context.status !== 'pending') {
        await interaction.editReply(`ℹ️ Ticket #${context.ticketNumber} is not pending.`);
        return;
      }

      let topic = setField(context.topic, 'status', 'open');
      topic = removeField(topic, 'pending_since');

      await saveTopic(context, topic);
      await context.channel.send(`▶️ Ticket #${context.ticketNumber} has been resumed by ${interaction.user}.`);
      await audit(interaction, context, `Ticket resumed by ${interaction.user.tag}`);
      await interaction.editReply(`✅ Ticket #${context.ticketNumber} is now **open** again.`);
      return;
    }

    if (subcommand === 'add-user' || subcommand === 'remove-user') {
      const target = interaction.options.getUser('user', true);

      if (subcommand === 'remove-user' && target.id === context.ownerId) {
        await interaction.editReply('❌ You cannot remove the ticket owner.');
        return;
      }

      const users = new Set((getField(context.topic, 'users') ?? '').split(',').filter(Boolean));

      if (subcommand === 'add-user') {
        users.add(target.id);
        await context.channel.permissionOverwrites.edit(target.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
          EmbedLinks: true,
        });
        await context.channel.send(`➕ ${target} was added by ${interaction.user}.`);
      } else {
        users.delete(target.id);
        await context.channel.permissionOverwrites.delete(target.id);
        await context.channel.send(`➖ ${target} was removed by ${interaction.user}.`);
      }

      const topic = setField(context.topic, 'users', [...users].join(','));
      await saveTopic(context, topic);
      await audit(interaction, context, `${subcommand === 'add-user' ? 'User added' : 'User removed'}: ${target.tag}`);
      await interaction.editReply(
        subcommand === 'add-user'
          ? `✅ ${target} now has access to ticket #${context.ticketNumber}.`
          : `✅ ${target} was removed from ticket #${context.ticketNumber}.`,
      );
      return;
    }

    if (subcommand === 'priority') {
      const level = interaction.options.getString('level', true);
      if (!PRIORITIES.has(level)) {
        await interaction.editReply('❌ Invalid priority.');
        return;
      }

      const topic = setField(context.topic, 'priority', level);
      await saveTopic(context, topic);

      const emoji = ({ low: '🟢', normal: '', high: '🟠', urgent: '🔴', critical: '🟣' } as Record<string, string>)[level];
      const baseName = context.channel.name.replace(/^[🟢⚪🟠🔴🟣]\s*/u, '');
      await queueTicketChannelRename(context.channel, level === 'normal' ? baseName : `${emoji}${baseName}`, `SupportForge priority changed to ${level}`);

      await audit(interaction, context, `Priority changed to ${level}`);
      await interaction.editReply(`✅ Ticket #${context.ticketNumber} priority is now **${level}**.`);
      return;
    }

    if (subcommand === 'tag') {
      const value = interaction.options.getString('name', true).trim().toLowerCase().replace(/\s+/g, '-');
      if (!value) {
        await interaction.editReply('❌ Tag cannot be empty.');
        return;
      }

      const tags = new Set((getField(context.topic, 'tags') ?? '').split(',').filter(Boolean));
      if (tags.has(value)) {
        await interaction.editReply(`ℹ️ Tag \`${value}\` is already on this ticket.`);
        return;
      }

      tags.add(value);
      const topic = setField(context.topic, 'tags', [...tags].join(','));
      await saveTopic(context, topic);
      await context.channel.send(`🏷️ Tag \`${value}\` added by ${interaction.user}.`);
      await audit(interaction, context, `Tag added: ${value}`);
      await interaction.editReply(`✅ Added tag \`${value}\`.`);
      return;
    }

    if (subcommand === 'note') {
      const text = interaction.options.getString('text', true).trim();
      const auditChannel = await getOrCreateAuditChannel(
        context.guild,
        context.config.supportCategoryId!,
      );

      await auditChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🔒 Internal note • Ticket #${context.ticketNumber}`)
            .setDescription(text)
            .setFooter({ text: `Added by ${interaction.user.tag}` })
            .setTimestamp(),
        ],
      });

      await interaction.editReply('✅ Internal note recorded in the staff-only audit log.');
      return;
    }

    if (subcommand === 'history') {
      const auditId = context.config.auditChannelId;
      const auditChannel = auditId ? context.guild.channels.cache.get(auditId) : null;

      if (!auditChannel || auditChannel.type !== ChannelType.GuildText) {
        await interaction.editReply('ℹ️ No audit history exists for this ticket yet.');
        return;
      }

      const messages = await auditChannel.messages.fetch({ limit: 50 });
      const matching = messages
        .filter((message) => message.embeds.some((embed) => embed.description?.includes(`Ticket #${context.ticketNumber}`)))
        .first(10);

      const lines = matching.length
        ? matching.map((message) => `${message.createdAt.toLocaleString('en-IN')} • ${message.embeds[0]?.description ?? 'Event'}`).join('\n')
        : 'No recent audit events found.';

      await interaction.editReply(`📜 **Recent history for ticket #${context.ticketNumber}**\n\n${lines}`);
      return;
    }

    await interaction.editReply('❌ Unsupported ticket command.');
  } catch (error) {
    console.error('❌ Ticket command failed:', error);
    await interaction.editReply(
      `❌ ${error instanceof Error ? error.message : 'Ticket command failed.'}`,
    );
  }
}
