import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';

import { evaluateTicketToolsAuthorization, isStage4TicketToolsCustomId } from '../core/domain/stage4TicketTools';
import { getGuildConfig } from '../services/configService';
import { getPersistedTicket } from '../services/ticketPersistenceService';
import {
  getKnowledgeArticle,
  recordKnowledgeArticleShare,
  searchKnowledgeBase,
} from '../services/knowledgeBaseService';
import {
  getQuickReply,
  listQuickReplies,
  renderQuickReply,
} from '../services/quickReplyService';
import { listRelatedTickets } from '../services/relatedTicketService';
import { listWorkflowExecutionRunsForTicket } from '../services/workflowExecutionService';
import { logTicketEvent } from '../services/auditLogService';
import { getThemeColor } from '../services/uiThemeService';

type Stage4Component = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;
type TicketChannel = TextChannel | ThreadChannel;

interface TicketToolsContext {
  guild: NonNullable<Stage4Component['guild']>;
  ticket: NonNullable<Awaited<ReturnType<typeof getPersistedTicket>>>;
  channel: TicketChannel;
  config: Awaited<ReturnType<typeof getGuildConfig>>;
  isAdmin: boolean;
  isAnyDepartmentStaff: boolean;
  isCurrentDepartmentStaff: boolean;
  roleIds: string[];
  permissions: ReturnType<typeof evaluateTicketToolsAuthorization>;
}

function interactionRoleIds(interaction: Stage4Component): string[] {
  const member = interaction.member;
  if (!member) return [];
  return Array.isArray(member.roles)
    ? member.roles
    : member.roles.cache.map((role) => role.id);
}

function isAdmin(interaction: Stage4Component): boolean {
  return Boolean(
    interaction.memberPermissions?.has('Administrator') ||
    interaction.memberPermissions?.has('ManageGuild'),
  );
}

async function resolveTicketToolsContext(interaction: Stage4Component): Promise<TicketToolsContext> {
  const guild = interaction.guild;
  if (!guild) throw new Error('Support Tools can only be used inside a server ticket.');
  const channelId = interaction.channelId;
  if (!channelId) throw new Error('Discord did not provide the current ticket channel. Reopen Support Tools from the ticket panel.');
  const ticket = await getPersistedTicket(channelId);
  if (!ticket || ticket.guildId !== guild.id || ticket.deletedAt) {
    throw new Error('This channel is no longer an active managed ticket. Refresh the ticket panel.');
  }
  if (!['open', 'claimed', 'pending', 'reopened'].includes(ticket.status)) {
    throw new Error('Support Tools are available only while the ticket is active.');
  }

  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PrivateThread)) {
    throw new Error('The current channel is not a supported ticket text channel or private thread.');
  }

  const config = await getGuildConfig(guild.id);
  const roleIds = interactionRoleIds(interaction);
  const roles = new Set(roleIds);
  const admin = isAdmin(interaction);
  const departmentRoles = Object.values(config.departments)
    .map((department) => department.staffRoleId)
    .filter((roleId): roleId is string => Boolean(roleId));
  const department = ticket.departmentId ? config.departments[ticket.departmentId] : undefined;
  const anyDepartmentStaff = admin || departmentRoles.some((roleId) => roles.has(roleId));
  const currentDepartmentStaff = admin || Boolean(department?.staffRoleId && roles.has(department.staffRoleId));
  const permissions = evaluateTicketToolsAuthorization({
    isAdmin: admin,
    isAnyDepartmentStaff: anyDepartmentStaff,
    isCurrentDepartmentStaff: currentDepartmentStaff,
    ticketIsActive: ['open', 'claimed', 'pending', 'reopened'].includes(ticket.status),
    ticketIsDeleted: Boolean(ticket.deletedAt),
  });

  return {
    guild,
    ticket,
    channel: channel as TicketChannel,
    config,
    isAdmin: admin,
    isAnyDepartmentStaff: anyDepartmentStaff,
    isCurrentDepartmentStaff: currentDepartmentStaff,
    roleIds,
    permissions,
  };
}

function knowledgeAccess(context: TicketToolsContext) {
  return {
    isAdmin: context.isAdmin,
    isStaff: context.isAnyDepartmentStaff,
    roleIds: context.roleIds,
  };
}

function auditTicketAction(
  context: TicketToolsContext,
  interaction: Stage4Component,
  event: string,
  detail: string,
): void {
  if (!context.config.supportCategoryId) return;
  void logTicketEvent(context.guild, context.config.supportCategoryId, {
    event,
    actorId: interaction.user.id,
    actor: interaction.user.tag,
    actorName: interaction.user.tag,
    category: 'ticket',
    ticketNumber: context.ticket.ticketNumber ?? context.ticket.id,
    ticketChannelId: context.ticket.channelId,
    detail,
  }).catch(() => undefined);
}

function buildToolsMenu(context: TicketToolsContext): ActionRowBuilder<StringSelectMenuBuilder> {
  const options: Array<{ label: string; value: string; description: string; emoji: string }> = [
    {
      label: 'Search Knowledge Base',
      value: 'knowledge-search',
      description: 'Find a verified article without blocking ticket support',
      emoji: '📚',
    },
  ];
  if (context.permissions.canUseQuickReplies) {
    options.push({
      label: 'Quick Replies',
      value: 'quick-replies',
      description: 'Send a saved reply appropriate for this ticket',
      emoji: '💬',
    });
  }
  if (context.permissions.canManageRelatedTickets) {
    options.push({
      label: 'Related Tickets',
      value: 'related-tickets',
      description: 'View linked tickets (administrator only)',
      emoji: '🔗',
    });
  }
  if (context.permissions.canInspectWorkflowHistory) {
    options.push({
      label: 'Workflow History',
      value: 'workflow-history',
      description: 'Inspect manual workflow runs and their status',
      emoji: '⚙️',
    });
  }
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ticket:stage4:tools:action')
      .setPlaceholder('Choose a support tool')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options),
  );
}

function articleResultsRow(
  results: Awaited<ReturnType<typeof searchKnowledgeBase>>,
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ticket:stage4:tools:knowledge-results')
      .setPlaceholder('Open an article')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(results.slice(0, 10).map((article) => ({
        label: article.title.slice(0, 100),
        description: (article.confidence + ' confidence · ' + (article.summary || article.category)).slice(0, 100),
        value: article.id,
      }))),
  );
}

function articleEmbed(
  article: NonNullable<Awaited<ReturnType<typeof getKnowledgeArticle>>>,
  themeColor: number,
): EmbedBuilder {
  const body = [
    article.summary,
    '**Category:** ' + article.category,
    '**Tags:** ' + (article.tags.join(', ') || 'none'),
    '**Revision:** ' + article.revision,
    '',
    article.body,
  ].filter(Boolean).join('\n');
  return new EmbedBuilder()
    .setColor(themeColor)
    .setTitle(article.title.slice(0, 256))
    .setDescription(body.slice(0, 3900))
    .setFooter({ text: 'Knowledge Base · ' + article.slug + ' · Ticket support remains available' });
}

function articleShareRow(articleId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:stage4:tools:share:' + articleId)
      .setLabel('Share to ticket')
      .setEmoji('📨')
      .setStyle(ButtonStyle.Primary),
  );
}

async function handleKnowledgeSearchModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const context = await resolveTicketToolsContext(interaction);
    const query = interaction.fields.getTextInputValue('query').trim();
    const results = await searchKnowledgeBase(
      context.guild.id,
      query,
      knowledgeAccess(context),
      interaction.user.id,
    );
    if (!results.length) {
      await interaction.editReply(
        'No confident Knowledge Base match was found. This does not block ordinary human support. Continue with the ticket and your support team can help.',
      );
      return;
    }
    const description = results.slice(0, 10).map((result, index) =>
      '**' + (index + 1) + '. ' + result.title + '**' +
      (result.confidence !== 'high' ? ' · *Possible match, please verify*' : '') +
      '\n' + (result.summary || result.category) +
      '\nScore: ' + result.score.toFixed(2) + ' · ID: ' + result.id,
    ).join('\n\n');
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(getThemeColor(context.config.theme))
        .setTitle('📚 Knowledge Base Search')
        .setDescription(description.slice(0, 3800))
        .setFooter({ text: 'Suggestions are not definitive answers. Opening a ticket never depends on a Knowledge Base match.' })],
      components: [articleResultsRow(results)],
    });
  } catch (error) {
    await interaction.editReply('❌ ' + (error instanceof Error ? error.message : 'Knowledge search could not be completed.'));
  }
}

async function handleToolsActionMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  const action = interaction.values[0];
  if (action === 'knowledge-search') {
    const modal = new ModalBuilder()
      .setCustomId('ticket:stage4:tools:knowledge-search')
      .setTitle('Search Knowledge Base');
    const queryInput = new TextInputBuilder()
      .setCustomId('query')
      .setLabel('What do you need help with?')
      .setStyle(TextInputStyle.Short)
      .setMinLength(2)
      .setMaxLength(120)
      .setRequired(true)
      .setPlaceholder('Refund, account access, order status…');
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(queryInput));
    await interaction.showModal(modal);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const context = await resolveTicketToolsContext(interaction);
    if (action === 'quick-replies') {
      if (!context.permissions.canUseQuickReplies) throw new Error('Only administrators or staff assigned to this ticket department can use quick replies.');
      const replies = await listQuickReplies(context.guild.id, {
        isAdmin: context.isAdmin,
        roleIds: context.roleIds,
      });
      if (!replies.length) {
        await interaction.editReply('No enabled quick replies are available to your roles. Administrators can create replies with /supportforge quick-reply create.');
        return;
      }
      const rows = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('ticket:stage4:tools:quick-reply')
          .setPlaceholder('Choose a saved quick reply')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(replies.slice(0, 25).map((reply) => ({
            label: reply.name.slice(0, 100),
            description: (reply.category + (reply.tags.length ? ' · ' + reply.tags.join(', ') : '')).slice(0, 100),
            value: reply.id,
          }))),
      );
      await interaction.editReply({
        content: '**Quick Replies**\nReplies are rechecked against your current roles before sending. Automatic mentions are disabled.',
        components: [rows],
      });
      return;
    }

    if (action === 'related-tickets') {
      if (!context.permissions.canManageRelatedTickets) throw new Error('Manage Server or Administrator is required to inspect related tickets in this view.');
      const related = await listRelatedTickets(context.guild.id, context.ticket.id);
      const description = related.length ? related.map((item) =>
        '• **Ticket #' + (item.ticketNumber ?? item.ticketId.slice(0, 8)) + '** · ' + item.status +
        ' · ' + (item.priority ?? 'normal') + ' · <#' + item.channelId + '> · ' + item.ticketId,
      ).join('\n') : 'No related tickets are linked to this ticket.';
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(getThemeColor(context.config.theme))
          .setTitle('🔗 Related Tickets')
          .setDescription(description.slice(0, 3900))
          .setFooter({ text: 'Administrator view. Links never merge ticket records or change their lifecycle.' })],
      });
      return;
    }

    if (action === 'workflow-history') {
      if (!context.permissions.canInspectWorkflowHistory) throw new Error('Manage Server or Administrator is required to inspect workflow history.');
      const runs = await listWorkflowExecutionRunsForTicket(context.guild.id, context.ticket.id, 10);
      const description = runs.length ? runs.map((run) =>
        '• **' + run.templateName + '** · ' + run.status + ' · v' + run.templateVersion +
        ' · steps ' + run.steps.filter((step) => step.status === 'completed').length + '/' + run.steps.length +
        ' · run ' + run.id,
      ).join('\n') : 'No manual workflow runs are recorded for this ticket.';
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(getThemeColor(context.config.theme))
          .setTitle('⚙️ Workflow History')
          .setDescription(description.slice(0, 3900))
          .setFooter({ text: 'Read-only audit view. Workflows do not run automatically.' })],
      });
      return;
    }

    throw new Error('This Support Tools option is no longer available. Close the menu and open it again.');
  } catch (error) {
    await interaction.editReply('❌ ' + (error instanceof Error ? error.message : 'Support Tools could not be opened.'));
  }
}

async function handleQuickReplySelection(interaction: StringSelectMenuInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const context = await resolveTicketToolsContext(interaction);
    if (!context.permissions.canUseQuickReplies) throw new Error('Only administrators or staff assigned to this ticket department can send quick replies.');
    const reply = await getQuickReply(context.guild.id, interaction.values[0] ?? '', {
      isAdmin: context.isAdmin,
      roleIds: context.roleIds,
    });
    if (!reply || !reply.enabled) throw new Error('That quick reply is no longer available to your role. Reopen Support Tools and choose another.');
    const owner = context.ticket.ownerId
      ? await context.guild.members.fetch(context.ticket.ownerId).catch(() => null)
      : null;
    const department = context.ticket.departmentId
      ? context.config.departments[context.ticket.departmentId]
      : undefined;
    const content = renderQuickReply(reply, {
      user: owner?.displayName ?? 'customer',
      username: owner?.user.username ?? 'customer',
      ticketId: context.ticket.id,
      ticketNumber: context.ticket.ticketNumber ?? context.ticket.id.slice(0, 8),
      department: department?.name ?? 'Support',
      priority: context.ticket.priority ?? 'normal',
      staff: interaction.user.tag,
    });
    await context.channel.send({
      content,
      allowedMentions: { parse: [] },
    });
    auditTicketAction(context, interaction, 'QUICK_REPLY_SENT', 'Sent quick reply ' + reply.id + ' version ' + reply.version + '. The message body was not copied into the audit record.');
    await interaction.editReply('✅ Sent **' + reply.name + '** in this ticket. No automatic mentions were triggered.');
  } catch (error) {
    await interaction.editReply('❌ ' + (error instanceof Error ? error.message : 'Quick reply could not be sent.'));
  }
}

async function handleKnowledgeArticleSelection(interaction: StringSelectMenuInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const context = await resolveTicketToolsContext(interaction);
    const article = await getKnowledgeArticle(
      context.guild.id,
      interaction.values[0] ?? '',
      knowledgeAccess(context),
      true,
      interaction.user.id,
    );
    if (!article || article.status !== 'published') throw new Error('That article is no longer published or is not visible to your role.');
    const components = context.permissions.canUseQuickReplies ? [articleShareRow(article.id)] : [];
    await interaction.editReply({
      embeds: [articleEmbed(article, getThemeColor(context.config.theme))],
      components,
    });
  } catch (error) {
    await interaction.editReply('❌ ' + (error instanceof Error ? error.message : 'That article could not be opened.'));
  }
}

async function handleKnowledgeArticleShare(interaction: ButtonInteraction, articleId: string): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const context = await resolveTicketToolsContext(interaction);
    if (!context.permissions.canUseQuickReplies) throw new Error('Only administrators or staff assigned to this ticket department can share articles into this ticket.');
    const article = await getKnowledgeArticle(context.guild.id, articleId, knowledgeAccess(context));
    if (!article || article.status !== 'published') throw new Error('That article is no longer published or is not visible to your role.');
    const shareText = [
      article.summary,
      '**Category:** ' + article.category,
      '**Tags:** ' + (article.tags.join(', ') || 'none'),
      '',
      article.body.slice(0, 2800),
      ...(article.body.length > 2800 ? ['… Open Support Tools → Knowledge Base Search to read the full article.'] : []),
      '',
      '_This is a suggested resource, not a replacement for human support. The ticket remains open for follow-up._',
    ].filter(Boolean).join('\n');
    await context.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(getThemeColor(context.config.theme))
        .setTitle(article.title.slice(0, 256))
        .setDescription(shareText.slice(0, 3900))
        .setFooter({ text: 'Knowledge Base article ' + article.id + ' · revision ' + article.revision + ' · shared by ' + interaction.user.tag })],
      allowedMentions: { parse: [] },
    });
    await recordKnowledgeArticleShare(context.guild.id, article.id, knowledgeAccess(context), interaction.user.id);
    auditTicketAction(context, interaction, 'KNOWLEDGE_ARTICLE_SHARED', 'Shared published Knowledge Base article ' + article.id + ' revision ' + article.revision + '.');
    await interaction.editReply('✅ Shared **' + article.title + '** in this ticket. The ticket remains open for follow-up.');
  } catch (error) {
    await interaction.editReply('❌ ' + (error instanceof Error ? error.message : 'The article could not be shared.'));
  }
}

export async function handleStage4TicketToolsInteraction(interaction: Stage4Component): Promise<boolean> {
  if (!isStage4TicketToolsCustomId(interaction.customId)) return false;
  try {
    if (interaction.isButton() && interaction.customId === 'ticket:stage4:tools') {
      const context = await resolveTicketToolsContext(interaction);
      if (!context.permissions.canSearchPublicKnowledge) throw new Error('This ticket is no longer active.');
      await interaction.reply({
        content: '**Support Tools**\nChoose a tool available for your current ticket permissions.',
        components: [buildToolsMenu(context)],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'ticket:stage4:tools:knowledge-search') {
      await handleKnowledgeSearchModal(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:stage4:tools:action') {
      await handleToolsActionMenu(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:stage4:tools:quick-reply') {
      await handleQuickReplySelection(interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:stage4:tools:knowledge-results') {
      await handleKnowledgeArticleSelection(interaction);
      return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith('ticket:stage4:tools:share:')) {
      const articleId = interaction.customId.slice('ticket:stage4:tools:share:'.length);
      if (!articleId || articleId.length > 36) {
        await interaction.reply({ content: 'That article reference is invalid. Reopen Knowledge Base search.', flags: MessageFlags.Ephemeral });
        return true;
      }
      await handleKnowledgeArticleShare(interaction, articleId);
      return true;
    }

    await interaction.reply({
      content: 'This Support Tools control is no longer available. Close it and open Support Tools again.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Support Tools failed safely.';
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('❌ ' + message).catch(() => undefined);
      } else {
        await interaction.reply({ content: '❌ ' + message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
    }
    return true;
  }
}
