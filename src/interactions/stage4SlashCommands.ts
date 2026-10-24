import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, type ChatInputCommandInteraction, type TextChannel, type ThreadChannel } from 'discord.js';

import { getGuildConfig } from '../services/configService';
import { getAdvancedSettings } from '../services/advancedSettingsService';
import { formatLocaleDate, translate } from '../i18n/translationService';
import { isKnowledgeShareableConfidence } from '../core/domain/knowledgeSearch';
import { getPersistedTicket } from '../services/ticketPersistenceService';
import { logSettingsEvent, logTicketEvent } from '../services/auditLogService';
import {
  createKnowledgeArticle,
  getKnowledgeArticle,
  recordKnowledgeArticleShare,
  getKnowledgeBaseMetrics,
  listKnowledgeArticles,
  listKnowledgeArticleRevisions,
  recordKnowledgeArticleFeedback,
  restoreKnowledgeArticleRevision,
  searchKnowledgeBase,
  setKnowledgeArticleStatus,
  setKnowledgeSynonyms,
  listKnowledgeSynonyms,
  deleteKnowledgeSynonyms,
  updateKnowledgeArticle,
  type KnowledgeArticleInput,
} from '../services/knowledgeBaseService';
import {
  deleteQuickReply,
  getQuickReply,
  getQuickReplyUsageMetrics,
  searchQuickRepliesPage,
  listQuickReplyRevisions,
  restoreQuickReplyRevision,
  saveQuickReply,
  sendQuickReplyInTicket,
} from '../services/quickReplyService';
import { linkRelatedTickets, listRelatedTickets, unlinkRelatedTickets } from '../services/relatedTicketService';
import {
  deleteWorkflowTemplate,
  listWorkflowTemplates,
  listWorkflowTemplateRevisions,
  previewWorkflowTemplateById,
  restoreWorkflowTemplateRevision,
  saveWorkflowTemplate,
  setWorkflowTemplateEnabled,
} from '../services/workflowTemplateService';
import {
  WorkflowExecutionFailure,
  listWorkflowRunsForTicket,
  resumeWorkflowRun,
  runWorkflowForTicket,
  type WorkflowExecutionDetails,
} from '../services/workflowExecutionService';

interface Access {
  isAdmin: boolean;
  isStaff: boolean;
  roleIds: string[];
}

function accessFor(interaction: ChatInputCommandInteraction, departmentRoleIds: string[]): Access {
  const member = interaction.member;
  const roleIds = !member ? [] : Array.isArray(member.roles) ? member.roles : member.roles.cache.map((role) => role.id);
  const isAdmin = Boolean(
    interaction.memberPermissions?.has('Administrator') ||
    interaction.memberPermissions?.has('ManageGuild'),
  );
  return { isAdmin, isStaff: isAdmin || roleIds.some((id) => departmentRoleIds.includes(id)), roleIds };
}

function commaList(value: string | null, field: string, max = 20): string[] {
  if (!value?.trim()) return [];
  const items = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (items.length > max) throw new Error(field + ' accepts at most ' + max + ' values.');
  return items;
}

function requireTextChannel(interaction: ChatInputCommandInteraction): TextChannel | ThreadChannel {
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || !('send' in channel)) {
    throw new Error('This command requires a server text channel or ticket thread.');
  }
  return channel as TextChannel | ThreadChannel;
}

function activeTicketStatus(status: string): boolean {
  return ['open', 'claimed', 'pending', 'reopened'].includes(status);
}

function canHandleTicketForStaff(
  access: Access,
  ticket: NonNullable<Awaited<ReturnType<typeof getPersistedTicket>>>,
  config: Awaited<ReturnType<typeof getGuildConfig>>,
): boolean {
  if (access.isAdmin) return true;
  if (!ticket.departmentId) return false;
  const department = config.departments[ticket.departmentId];
  return Boolean(department?.staffRoleId && access.roleIds.includes(department.staffRoleId));
}

async function prepare(interaction: ChatInputCommandInteraction): Promise<{ access: Access; config: Awaited<ReturnType<typeof getGuildConfig>> }> {
  if (!interaction.guildId) throw new Error('This command must be used inside a server.');
  const config = await getGuildConfig(interaction.guildId);
  const staffRoles = Object.values(config.departments)
    .map((department) => department.staffRoleId)
    .filter((id): id is string => Boolean(id));
  return { access: accessFor(interaction, staffRoles), config };
}

async function requireTicketInCurrentChannel(interaction: ChatInputCommandInteraction, requireActive = true) {
  const ticket = await getPersistedTicket(interaction.channelId);
  if (!ticket || ticket.guildId !== interaction.guildId || ticket.deletedAt) {
    throw new Error('Use this command inside an active managed ticket channel or private ticket thread.');
  }
  if (requireActive && !activeTicketStatus(ticket.status)) throw new Error('This operation is available only while the ticket is active.');
  return ticket;
}

function accessDenied(action: string): Error {
  return new Error('You need ' + action + ' to use this command.');
}

function safeWorkflowText(value: string): string {
  return value.split(String.fromCharCode(96)).join('').replace(/[*_~|<>@]/g, '').replace(/\s+/g, ' ').slice(0, 100);
}

function formatWorkflowRun(details: WorkflowExecutionDetails): string {
  const run = details.run;
  const steps = details.steps.map((step) =>
    (step.stepIndex + 1) + '. ' + safeWorkflowText(step.actionType) + ': ' + step.status +
      (step.errorCode ? ' (' + safeWorkflowText(step.errorCode) + ')' : ''),
  );
  return [
    'Workflow run: ' + run.status,
    'Template: ' + safeWorkflowText(run.templateName) + ' v' + run.templateVersion,
    'Run ID: ' + run.id,
    'Ticket ID: ' + run.ticketId,
    'Steps: ' + run.stepCount,
    steps.length ? steps.join('\n') : 'No workflow steps were recorded.',
  ].join('\n').slice(0, 1900);
}

function formatWorkflowRunList(
  runs: Awaited<ReturnType<typeof listWorkflowRunsForTicket>>,
): string {
  if (!runs.length) return 'No workflow runs are recorded for this ticket.';
  return runs.map((run) =>
    run.status + ' • ' + run.id + '\n' +
    safeWorkflowText(run.templateName) + ' v' + run.templateVersion + ' • ' +
    run.stepCount + ' steps • started ' + run.startedAt,
  ).join('\n\n').slice(0, 1900);
}

export async function handleStage4SlashCommand(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const group = interaction.options.getSubcommandGroup(false);
  if (!['knowledge', 'quick-reply', 'related', 'workflow'].includes(group ?? '')) return false;
  const subcommand = interaction.options.getSubcommand();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { access, config } = await prepare(interaction);
    const guildId = interaction.guildId!;
    const actorId = interaction.user.id;

    if (group === 'knowledge') {
      const settings = await getAdvancedSettings(guildId);
      if (['create','update','publish','archive','revisions','restore-revision','synonyms-set','synonyms-delete','metrics'].includes(subcommand) && !access.isAdmin) {
        throw accessDenied('Manage Server or Administrator permission');
      }

      if (subcommand === 'create') {
        const input: KnowledgeArticleInput = {
          title: interaction.options.getString('title', true),
          body: interaction.options.getString('body', true),
          summary: interaction.options.getString('summary') ?? '',
          category: interaction.options.getString('category') ?? 'General',
          tags: commaList(interaction.options.getString('tags'), 'tags', 12),
          visibility: (interaction.options.getString('visibility') ?? 'public') as 'public' | 'staff',
          allowedRoleIds: commaList(interaction.options.getString('role-ids'), 'role IDs', 20),
        };
        const article = await createKnowledgeArticle(guildId, actorId, input);
        if (config.supportCategoryId) {
          await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
            action: 'KNOWLEDGE_ARTICLE_CREATED',
            actorId,
            actorName: interaction.user.tag,
            detail: 'Created Knowledge Base draft ' + article.id + ', revision ' + article.revision + '.',
          });
        }
        await interaction.editReply(translate(settings.locale, 'knowledge.command.createdDraft', { title: article.title, id: article.id, revision: article.revision }));
        return true;
      }

      if (subcommand === 'list') {
        const articles = await listKnowledgeArticles(guildId, access, 25);
        const body = articles.length
          ? articles.map((article) =>
              '**' + article.title + '** (' + translate(settings.locale, article.status === 'draft' ? 'knowledge.command.statusDraft' : article.status === 'published' ? 'knowledge.command.statusPublished' : 'knowledge.command.statusArchived') + ', r' + article.revision + ')\nID: ' + article.id +
              '\n' + translate(settings.locale, 'knowledge.command.category') + ': ' + article.category + ' • ' + translate(settings.locale, article.visibility === 'staff' ? 'knowledge.command.visibilityStaff' : 'knowledge.command.visibilityPublic') + '\n' + (article.summary || translate(settings.locale, 'knowledge.command.noSummary')),
            ).join('\n\n')
          : translate(settings.locale, 'knowledge.command.noArticles');
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('📚 ' + translate(settings.locale, 'knowledge.command.articlesTitle')).setDescription(body.slice(0, 4000))
            .setFooter({ text: translate(settings.locale, 'knowledge.command.articlesFooter') })],
        });
        return true;
      }

      if (subcommand === 'view') {
        const articleId = interaction.options.getString('article-id', true).trim();
        const page = interaction.options.getInteger('page') ?? 1;
        const article = await getKnowledgeArticle(guildId, articleId, access, true, actorId);
        if (!article) throw new Error(translate(settings.locale, 'knowledge.command.articleNotFound'));
        const pageSize = 3300;
        const pageCount = Math.max(1, Math.ceil(article.body.length / pageSize));
        if (page < 1 || page > pageCount) throw new Error(translate(settings.locale, 'knowledge.command.pageOutOfRange', { pages: pageCount }));
        const excerpt = article.body.slice((page - 1) * pageSize, page * pageSize);
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle(article.title)
            .setDescription((article.summary ? article.summary + '\n\n' : '') + excerpt)
            .addFields(
              { name: translate(settings.locale, 'knowledge.command.category'), value: article.category, inline: true },
              { name: translate(settings.locale, 'knowledge.command.tags'), value: article.tags.join(', ') || translate(settings.locale, 'knowledge.command.noTags'), inline: true },
              { name: translate(settings.locale, 'knowledge.command.revision'), value: String(article.revision), inline: true },
            )
            .setFooter({ text: translate(settings.locale, 'knowledge.command.articleFooter', { id: article.id, page, pages: pageCount, updated: article.updatedAt }) })],
        });
        return true;
      }

      if (subcommand === 'update') {
        const changes: Partial<KnowledgeArticleInput> = {};
        const title = interaction.options.getString('title');
        const summary = interaction.options.getString('summary');
        const body = interaction.options.getString('body');
        const category = interaction.options.getString('category');
        const tags = interaction.options.getString('tags');
        const visibility = interaction.options.getString('visibility');
        const roles = interaction.options.getString('role-ids');
        if (title !== null) changes.title = title;
        if (summary !== null) changes.summary = summary;
        if (body !== null) changes.body = body;
        if (category !== null) changes.category = category;
        if (tags !== null) changes.tags = commaList(tags, 'tags', 12);
        if (visibility !== null) changes.visibility = visibility as 'public' | 'staff';
        if (roles !== null) changes.allowedRoleIds = commaList(roles, 'role IDs', 20);
        if (!Object.keys(changes).length) throw new Error(translate(settings.locale, 'knowledge.command.updateNoFields'));
        const article = await updateKnowledgeArticle(
          guildId, interaction.options.getString('article-id', true).trim(),
          interaction.options.getInteger('revision', true), actorId, changes,
        );
        if (config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'KNOWLEDGE_ARTICLE_UPDATED', actorId, actorName: interaction.user.tag,
          detail: 'Updated Knowledge Base article ' + article.id + ' to revision ' + article.revision + '; changed fields=' + Object.keys(changes).join(',') + '.',
        });
        await interaction.editReply(translate(settings.locale, 'knowledge.command.updated', { title: article.title, revision: article.revision }));
        return true;
      }

      if (subcommand === 'publish' || subcommand === 'archive') {
        if (subcommand === 'archive' && !interaction.options.getBoolean('confirm', true)) {
          throw new Error(translate(settings.locale, 'knowledge.command.archiveNotConfirmed'));
        }
        const article = await setKnowledgeArticleStatus(
          guildId,
          interaction.options.getString('article-id', true).trim(),
          interaction.options.getInteger('revision', true),
          actorId,
          subcommand === 'publish' ? 'published' : 'archived',
        );
        if (config.supportCategoryId) {
          await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
            action: subcommand === 'publish' ? 'KNOWLEDGE_ARTICLE_PUBLISHED' : 'KNOWLEDGE_ARTICLE_ARCHIVED',
            actorId,
            actorName: interaction.user.tag,
            detail: (subcommand === 'publish' ? 'Published ' : 'Archived ') + article.id + ' at revision ' + article.revision + '.',
          });
        }
        await interaction.editReply(translate(settings.locale, subcommand === 'publish' ? 'knowledge.command.publishedSuccess' : 'knowledge.command.archivedSuccess', { title: article.title, revision: article.revision }));
        return true;
      }

      if (subcommand === 'suggest') {
        if (!access.isStaff) throw accessDenied('a configured department staff role');
        const ticket = await requireTicketInCurrentChannel(interaction);
        if (!canHandleTicketForStaff(access, ticket, config)) {
          throw accessDenied('the staff role configured for this ticket department');
        }
        const query = interaction.options.getString('query', true);
        const results = await searchKnowledgeBase(guildId, query, access, actorId);
        if (!results.length) {
          await interaction.editReply(
            translate(settings.locale, 'knowledge.command.noConfidentTicketMatch'),
          );
          return true;
        }

        const description = results.map((result, index) =>
          translate(settings.locale, 'knowledge.command.suggestionLine', { index: index + 1, title: result.title, confidence: translate(settings.locale, result.confidence === 'high' ? 'knowledge.command.confidenceHigh' : result.confidence === 'medium' ? 'knowledge.command.confidenceMedium' : 'knowledge.command.confidenceLow'), score: result.score, summary: result.summary || translate(settings.locale, 'knowledge.command.noSummary'), category: result.category }) +
          (result.tags.length ? '\n' + translate(settings.locale, 'knowledge.command.tagsLine', { tags: result.tags.join(', ') }) : ''),
        ).join('\n\n').slice(0, 3600);
        const shareable = results.filter((result) => isKnowledgeShareableConfidence(result.confidence)).slice(0, 5);
        const components = shareable.length
          ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
              ...shareable.map((result) => new ButtonBuilder()
                .setCustomId('sf:kb:share:' + result.id + ':' + ticket.channelId)
                .setLabel(translate(settings.locale, 'knowledge.command.shareButton', { number: results.findIndex((item) => item.id === result.id) + 1 }))
                .setEmoji('📚')
                .setStyle(ButtonStyle.Secondary)),
            )]
          : [];
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('📚 ' + translate(settings.locale, 'knowledge.command.suggestionsTitle'))
            .setDescription(description)
            .setFooter({ text: translate(settings.locale, 'knowledge.command.suggestionsFooter') })],
          components,
        });
        return true;
      }

      if (subcommand === 'search') {
        const results = await searchKnowledgeBase(guildId, interaction.options.getString('query', true), access, actorId);
        if (!results.length) {
          await interaction.editReply(translate(settings.locale, 'knowledge.command.noConfidentSearchMatch'));
          return true;
        }
        const body = results.map((result, index) =>
          translate(settings.locale, 'knowledge.command.searchResultLine', { index: index + 1, title: result.title, confidence: translate(settings.locale, result.confidence === 'high' ? 'knowledge.command.confidenceHigh' : result.confidence === 'medium' ? 'knowledge.command.confidenceMedium' : 'knowledge.command.confidenceLow'), score: result.score, id: result.id, summary: result.summary || translate(settings.locale, 'knowledge.command.noSummary'), category: result.category }),
        ).join('\n\n');
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('🔎 ' + translate(settings.locale, 'knowledge.command.searchTitle')).setDescription(body.slice(0, 4000))
            .setFooter({ text: translate(settings.locale, 'knowledge.command.searchFooter') })],
        });
        return true;
      }

      if (subcommand === 'share') {
        if (!access.isStaff) throw accessDenied('a configured department staff role');
        const ticket = await requireTicketInCurrentChannel(interaction);
        if (!canHandleTicketForStaff(access, ticket, config)) {
          throw accessDenied('the staff role configured for this ticket department');
        }
        const article = await getKnowledgeArticle(guildId, interaction.options.getString('article-id', true).trim(), access);
        if (!article || article.status !== 'published') throw new Error(translate(settings.locale, 'knowledge.command.publishedArticleNotFound'));
        const shareBody = article.body.slice(0, 2600);
        const truncated = article.body.length > shareBody.length;
        await requireTextChannel(interaction).send({
          embeds: [new EmbedBuilder().setTitle(translate(settings.locale, 'knowledge.command.suggestedArticleTitle', { title: article.title }))
            .setDescription(
              (article.summary ? article.summary + '\n\n' : '') +
              '**' + translate(settings.locale, 'knowledge.command.shareCategoryLabel') + ':** ' + article.category + '\n' +
              '**' + translate(settings.locale, 'knowledge.command.shareTagsLabel') + ':** ' + (article.tags.join(', ') || translate(settings.locale, 'knowledge.command.shareNoTags')) + '\n\n' +
              shareBody + (truncated ? '\n\n' + translate(settings.locale, 'knowledge.command.truncatedNotice', { id: article.id }) : '') +
              '\n\n' + translate(settings.locale, 'knowledge.command.humanSupportNote')',
            )
            .setFooter({ text: translate(settings.locale, 'knowledge.command.shareFooter', { id: article.id, revision: article.revision }) })],
          allowedMentions: { parse: [] },
        });
        await recordKnowledgeArticleShare(guildId, article.id, access, actorId);
        if (config.supportCategoryId) {
          await logTicketEvent(interaction.guild!, config.supportCategoryId, {
            ticketNumber: ticket.ticketNumber ?? ticket.id,
            ticketChannelId: ticket.channelId,
            event: 'KNOWLEDGE_ARTICLE_SHARED',
            actorId,
            actor: interaction.user.tag,
            actorName: interaction.user.tag,
            detail: 'Shared published Knowledge Base article ' + article.id + ' revision ' + article.revision + '.',
          });
        }
        await interaction.editReply(translate(settings.locale, 'knowledge.command.shared', { title: article.title }));
        return true;
      }

      if (subcommand === 'revisions') {
        const articleId = interaction.options.getString('article-id', true).trim();
        const revisions = await listKnowledgeArticleRevisions(guildId, articleId, access);
        await interaction.editReply(revisions.length
          ? revisions.map((item) => translate(settings.locale, 'knowledge.command.revisionLine', { revision: item.revision, status: translate(settings.locale, item.status === 'published' ? 'knowledge.command.statusPublished' : item.status === 'archived' ? 'knowledge.command.statusArchived' : 'knowledge.command.statusDraft'), createdAt: item.createdAt, title: item.title, editor: item.changedBy })).join('\n\n').slice(0, 4000)
          : translate(settings.locale, 'knowledge.command.noRevisions'));
        return true;
      }

      if (subcommand === 'restore-revision') {
        const article = await restoreKnowledgeArticleRevision(
          guildId,
          interaction.options.getString('article-id', true).trim(),
          interaction.options.getInteger('target-revision', true),
          interaction.options.getInteger('current-revision', true),
          actorId,
        );
        if (config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'KNOWLEDGE_ARTICLE_REVISION_RESTORED', actorId, actorName: interaction.user.tag,
          detail: 'Restored historical article content for ' + article.id + ' into new revision ' + article.revision + '.',
        });
        await interaction.editReply(translate(settings.locale, 'knowledge.command.restoreSuccess', { title: article.title, revision: article.revision }));
        return true;
      }

      if (subcommand === 'rate') {
        await recordKnowledgeArticleFeedback(
          guildId,
          interaction.options.getString('article-id', true).trim(),
          actorId,
          access,
          interaction.options.getBoolean('helpful', true),
        );
        await interaction.editReply(translate(settings.locale, 'knowledge.command.feedbackSaved'));
        return true;
      }

      if (subcommand === 'synonyms-set') {
        await setKnowledgeSynonyms(
          guildId,
          actorId,
          interaction.options.getString('term', true),
          commaList(interaction.options.getString('synonyms', true), 'synonyms', 20),
        );
        if (config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'KNOWLEDGE_SYNONYMS_UPDATED', actorId, actorName: interaction.user.tag,
          detail: 'Updated deterministic Knowledge Base synonyms for a canonical term.',
        });
        await interaction.editReply(translate(settings.locale, 'knowledge.command.synonymsSaved'));
        return true;
      }

      if (subcommand === 'synonyms-list') {
        const synonyms = await listKnowledgeSynonyms(guildId);
        await interaction.editReply(synonyms.length
          ? synonyms.map((item) => '**' + item.term + '** → ' + (item.synonyms.join(', ') || translate(settings.locale, 'knowledge.command.synonymsNoAlternatives'))).join('\n').slice(0, 4000)
          : translate(settings.locale, 'knowledge.command.synonymsNone'));
        return true;
      }

      if (subcommand === 'synonyms-delete') {
        const deleted = await deleteKnowledgeSynonyms(guildId, interaction.options.getString('term', true));
        if (deleted && config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'KNOWLEDGE_SYNONYMS_DELETED', actorId, actorName: interaction.user.tag,
          detail: 'Deleted deterministic Knowledge Base synonym mapping.',
        });
        await interaction.editReply(translate(settings.locale, deleted ? 'knowledge.command.synonymsRemoved' : 'knowledge.command.synonymNotFound'));
        return true;
      }

      if (subcommand === 'metrics') {
        const days = interaction.options.getInteger('days') ?? 30;
        const metrics = await getKnowledgeBaseMetrics(guildId, days);
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('📊 ' + translate(settings.locale, 'knowledge.command.metricsTitle'))
            .setDescription(translate(settings.locale, 'knowledge.command.metricsDescription', { days, published: metrics.publishedArticles, drafts: metrics.draftArticles, archived: metrics.archivedArticles, searches: metrics.searchResultEvents, views: metrics.articleViews, shares: metrics.articleShares, helpful: metrics.helpfulVotes, unhelpful: metrics.unhelpfulVotes }))
            .setFooter({ text: translate(settings.locale, 'knowledge.command.metricsFooter') })],
        });
        return true;
      }
    }

    if (group === 'quick-reply') {
      const settings = await getAdvancedSettings(guildId);
      const needsStaff = ['list','show','send'].includes(subcommand);
      // Administrators can inspect the library even when the guild has not
      // configured a staff role. Sending still requires staff membership and
      // the active ticket's department authorization below.
      if (needsStaff && !access.isStaff && !(access.isAdmin && ['list','show'].includes(subcommand))) {
        throw accessDenied('a configured department staff role (administrators may list/show replies)');
      }
      if (subcommand === 'list') {
        const pageNumber = interaction.options.getInteger('page') ?? 1;
        const result = await searchQuickRepliesPage(
          guildId,
          { isAdmin: access.isAdmin, roleIds: access.roleIds },
          {
            category: interaction.options.getString('category') ?? undefined,
            tag: interaction.options.getString('tag') ?? undefined,
            query: interaction.options.getString('query') ?? undefined,
            page: pageNumber - 1,
            pageSize: 10,
          },
        );
        const settings = await getAdvancedSettings(guildId);
        if (!result.total) {
          await interaction.editReply(translate(settings.locale, 'quickReply.list.noResults'));
          return true;
        }
        const description = result.replies.map((reply) =>
          '**' + reply.name + '** • ' + reply.category + ' • v' + reply.version + '\n' +
          translate(settings.locale, 'quickReply.list.tags') + ': ' + (reply.tags.join(', ') || translate(settings.locale, 'common.none')) +
          (access.isAdmin && !reply.enabled ? '\n⚪ ' + translate(settings.locale, 'common.disabled') : ''),
        ).join('\n\n').slice(0, 3800);
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle(translate(settings.locale, 'quickReply.list.title'))
            .setDescription(description)
            .setFooter({ text: translate(settings.locale, 'quickReply.list.page', {
              page: result.page + 1,
              pages: result.pageCount,
              total: result.total,
            }) })],
          allowedMentions: { parse: [] },
        });
        return true;
      }
      if (subcommand === 'metrics') {
        if (!access.isAdmin) throw accessDenied('Manage Server or Administrator permission');
        const days = interaction.options.getInteger('days') ?? 30;
        const settings = await getAdvancedSettings(guildId);
        const summary = await getQuickReplyUsageMetrics(guildId, days);
        const description = summary.replies.length
          ? summary.replies.slice(0, 15).map((item) =>
              translate(settings.locale, 'quickReply.metrics.replyLine', {
                name: item.name,
                category: item.category,
                count: item.sentCount,
                last: item.lastSentAt ? formatLocaleDate(settings.locale, item.lastSentAt) : translate(settings.locale, 'quickReply.metrics.never'),
              }),
            ).join('\n\n').slice(0, 3800)
          : translate(settings.locale, 'quickReply.metrics.none');
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle(translate(settings.locale, 'quickReply.metrics.title'))
            .setDescription(
              translate(settings.locale, 'quickReply.metrics.summary', {
                total: summary.totalSends,
                days: summary.days,
              }) + '\n\n' + description,
            )
            .setFooter({ text: translate(settings.locale, 'quickReply.metrics.footer') })],
          allowedMentions: { parse: [] },
        });
        return true;
      }
      if (subcommand === 'history') {
        if (!access.isAdmin) throw accessDenied('Manage Server or Administrator permission');
        const replyId = interaction.options.getString('name-or-id', true).trim();
        const revisions = await listQuickReplyRevisions(guildId, replyId);
        const description = revisions.length
          ? revisions.map((item) => {
              const operationKey = item.operation === 'created' ? 'quickReply.command.operationCreated'
                : item.operation === 'updated' ? 'quickReply.command.operationUpdated'
                : item.operation === 'deleted' ? 'quickReply.command.operationDeleted'
                : item.operation === 'restored' ? 'quickReply.command.operationRestored'
                : 'quickReply.command.operationBaseline';
              return translate(settings.locale, 'quickReply.command.historyLine', {
                version: item.version,
                operation: translate(settings.locale, operationKey),
                status: translate(settings.locale, item.enabled ? 'common.enabled' : 'common.disabled'),
                name: item.name,
                editor: item.changedBy,
                createdAt: item.createdAt,
              });
            }).join('\n\n').slice(0, 3800)
          : translate(settings.locale, 'quickReply.command.noHistory');
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle(translate(settings.locale, 'quickReply.command.historyTitle'))
            .setDescription(description)
            .setFooter({ text: translate(settings.locale, 'quickReply.command.historyFooter') })],
        });
        return true;
      }
      if (subcommand === 'restore-revision') {
        if (!access.isAdmin) throw accessDenied('Manage Server or Administrator permission');
        const reply = await restoreQuickReplyRevision(
          guildId,
          actorId,
          interaction.options.getString('name-or-id', true),
          interaction.options.getInteger('revision', true),
          interaction.options.getInteger('expected-version', true),
        );
        if (config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'QUICK_REPLY_REVISION_RESTORED',
          actorId,
          actorName: interaction.user.tag,
          detail: 'Restored retained quick reply content into new version ' + reply.version + '.',
        });
        await interaction.editReply(translate(settings.locale, 'quickReply.command.restored', { version: reply.version }));
        return true;
      }
      if (subcommand === 'show') {
        const reply = await getQuickReply(guildId, interaction.options.getString('name-or-id', true), { isAdmin: access.isAdmin, roleIds: access.roleIds });
        if (!reply) throw new Error(translate(settings.locale, 'quickReply.command.notFound'));
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle(reply.name).setDescription(reply.body)
            .addFields(
              { name: translate(settings.locale, 'quickReply.command.category'), value: reply.category, inline: true },
              { name: translate(settings.locale, 'quickReply.command.tags'), value: reply.tags.join(', ') || translate(settings.locale, 'common.none'), inline: true },
            )
            .setFooter({ text: translate(settings.locale, 'quickReply.command.placeholderFooter') })],
        });
        return true;
      }
      if (subcommand === 'save') {
        if (!access.isAdmin) throw accessDenied('Manage Server or Administrator permission');
        const reply = await saveQuickReply(guildId, actorId, {
          name: interaction.options.getString('name', true),
          body: interaction.options.getString('body', true),
          category: interaction.options.getString('category') ?? 'General',
          tags: commaList(interaction.options.getString('tags'), 'tags', 12),
          allowedRoleIds: commaList(interaction.options.getString('role-ids'), 'role IDs', 20),
          enabled: interaction.options.getBoolean('enabled') ?? undefined,
        }, interaction.options.getInteger('expected-version') ?? undefined);
        if (config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'QUICK_REPLY_SAVED', actorId, actorName: interaction.user.tag,
          detail: 'Saved quick reply ' + reply.id + ' version ' + reply.version + '; role restrictions count=' + reply.allowedRoleIds.length + '.',
        });
        await interaction.editReply(translate(settings.locale, 'quickReply.command.saved', { name: reply.name, version: reply.version }));
        return true;
      }
      if (subcommand === 'delete') {
        if (!access.isAdmin) throw accessDenied('Manage Server or Administrator permission');
        if (!interaction.options.getBoolean('confirm', true)) throw new Error(translate(settings.locale, 'quickReply.command.deleteNotConfirmed'));
        const quickReplyId = interaction.options.getString('name-or-id', true);
        const expectedVersion = interaction.options.getInteger('expected-version', true);
        const deleted = await deleteQuickReply(guildId, quickReplyId, expectedVersion, actorId);
        if (deleted && config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'QUICK_REPLY_DELETED', actorId, actorName: interaction.user.tag,
          detail: 'Deleted quick reply identified by ' + quickReplyId.slice(0, 80) + '.',
        });
        await interaction.editReply(translate(settings.locale, deleted ? 'quickReply.command.deleted' : 'quickReply.command.deleteNotFound'));
        return true;
      }
      if (subcommand === 'send') {
        const channel = requireTextChannel(interaction);
        const reply = await sendQuickReplyInTicket({
          guild: interaction.guild!,
          channel,
          quickReplyId: interaction.options.getString('name-or-id', true),
          sendIntentId: interaction.id,
          actorId,
          actorName: interaction.user.tag,
          actorUsername: interaction.user.username,
          isAdmin: access.isAdmin,
          roleIds: access.roleIds,
        });
        const settings = await getAdvancedSettings(guildId);
        await interaction.editReply(translate(
          settings.locale,
          reply.status === 'uncertain' ? 'quickReply.picker.uncertain' : 'quickReply.picker.sent',
          { name: reply.reply.name },
        ));
        return true;
      }
    }

    if (group === 'related') {
      // Related links expose metadata about two tickets. Keep every operation
      // administrator-only until both-ticket department authorization is
      // implemented and tested, rather than granting it to staff in any dept.
      if (!access.isAdmin) throw accessDenied('Manage Server or Administrator permission');
      const ticket = await requireTicketInCurrentChannel(interaction, false);
      if (subcommand === 'link') {
        const other = interaction.options.getString('other-ticket-id', true).trim();
        await linkRelatedTickets(guildId, ticket.id, other, actorId);
        if (config.supportCategoryId) await logTicketEvent(interaction.guild!, config.supportCategoryId, {
          ticketNumber: ticket.ticketNumber ?? ticket.id, ticketChannelId: ticket.channelId,
          event: 'RELATED_TICKET_LINKED', actorId, actor: interaction.user.tag, actorName: interaction.user.tag,
          detail: 'Linked another same-server ticket to ' + ticket.id + '.',
        });
        await interaction.editReply('Related-ticket link saved. Both tickets remain unchanged; no ticket was merged.');
        return true;
      }
      if (subcommand === 'list') {
        const related = await listRelatedTickets(guildId, ticket.id);
        await interaction.editReply(related.length
          ? related.map((item) => '**Ticket ' + (item.ticketNumber ?? item.ticketId.slice(0, 8)) + '** • <#' + item.channelId + '> • ' + item.status + ' • ' + (item.priority ?? 'normal') + '\nID: ' + item.ticketId).join('\n\n').slice(0, 4000)
          : 'No related tickets are linked to this ticket.');
        return true;
      }
      if (subcommand === 'unlink') {
        if (!interaction.options.getBoolean('confirm', true)) throw new Error('Unlink was not confirmed. No relationship was removed.');
        const otherTicketId = interaction.options.getString('other-ticket-id', true).trim();
        const removed = await unlinkRelatedTickets(guildId, ticket.id, otherTicketId);
        if (removed && config.supportCategoryId) await logTicketEvent(interaction.guild!, config.supportCategoryId, {
          ticketNumber: ticket.ticketNumber ?? ticket.id, ticketChannelId: ticket.channelId,
          event: 'RELATED_TICKET_UNLINKED', actorId, actor: interaction.user.tag, actorName: interaction.user.tag,
          detail: 'Removed one same-server related-ticket link from ' + ticket.id + '.',
        });
        await interaction.editReply(removed ? 'Related-ticket link removed. Both tickets and their history remain unchanged.' : 'No matching related-ticket link was found.');
        return true;
      }
    }

    if (group === 'workflow') {
      if (!access.isAdmin) throw accessDenied('Manage Server or Administrator permission');

      if (subcommand === 'execute') {
        const confirmation = interaction.options.getBoolean('confirm', true);
        if (!confirmation) throw new Error('Execution was not confirmed. No workflow action was run.');
        const ticket = await requireTicketInCurrentChannel(interaction);
        const channel = requireTextChannel(interaction);
        const details = await runWorkflowForTicket({
          guild: interaction.guild!,
          channel,
          ticketId: ticket.id,
          templateId: interaction.options.getString('template-id', true).trim(),
          actorId,
          interactionId: interaction.id,
          confirmation,
        });
        await interaction.editReply(formatWorkflowRun(details));
        return true;
      }

      if (subcommand === 'resume') {
        const confirmation = interaction.options.getBoolean('confirm', true);
        if (!confirmation) throw new Error('Resume was not confirmed. No workflow action was run.');
        const ticket = await requireTicketInCurrentChannel(interaction);
        const channel = requireTextChannel(interaction);
        const details = await resumeWorkflowRun({
          guild: interaction.guild!,
          channel,
          ticketId: ticket.id,
          runId: interaction.options.getString('run-id', true).trim(),
          actorId,
          confirmation,
        });
        await interaction.editReply(formatWorkflowRun(details));
        return true;
      }

      if (subcommand === 'runs') {
        const ticket = await requireTicketInCurrentChannel(interaction, false);
        const runs = await listWorkflowRunsForTicket(guildId, ticket.id, 10);
        await interaction.editReply(formatWorkflowRunList(runs));
        return true;
      }

      if (subcommand === 'list') {
        const templates = await listWorkflowTemplates(guildId);
        await interaction.editReply(templates.length
          ? templates.map((item) => '**' + item.name + '** • ' + item.id + ' • v' + item.version + ' • ' + (item.enabled ? 'catalogue enabled' : 'disabled') +
              '\nConditions: ' + item.definition.conditions.length + ' • actions: ' + item.definition.actions.length).join('\n\n').slice(0, 4000)
          : 'No workflow templates exist.');
        return true;
      }
      if (subcommand === 'history') {
        const templateId = interaction.options.getString('template-id', true).trim();
        const revisions = await listWorkflowTemplateRevisions(guildId, templateId);
        const description = revisions.length
          ? revisions.map((item) =>
              '**v' + item.version + '** • ' + item.operation + ' • ' +
              (item.enabled ? 'catalogue enabled' : 'disabled') + (item.deleted ? ' • deleted' : '') +
              '\n' + item.name + ' • editor ' + item.changedBy + ' • ' + item.createdAt,
            ).join('\n\n').slice(0, 3800)
          : 'No revision history is recorded for this workflow template.';
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('Workflow Template Revision History').setDescription(description)
            .setFooter({ text: 'Immutable history • manual execution only • no automatic triggers' })],
        });
        return true;
      }
      if (subcommand === 'save') {
        let definition: unknown;
        try { definition = JSON.parse(interaction.options.getString('definition-json', true)); }
        catch { throw new Error('Definition must be valid JSON. Example: {"conditions":[{"field":"priority","equals":"urgent"}],"actions":[{"type":"assign_department","value":"billing"}]}'); }
        const item = await saveWorkflowTemplate(
          guildId,
          actorId,
          interaction.options.getString('name', true),
          definition,
          interaction.options.getInteger('expected-version') ?? undefined,
        );
        if (config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'WORKFLOW_TEMPLATE_SAVED', actorId, actorName: interaction.user.tag,
          detail: 'Saved validated workflow template ' + item.id + ' version ' + item.version + '; manual execution requires explicit admin confirmation after enablement, and automatic triggers remain disabled.',
        });
        await interaction.editReply('Saved validated workflow template "' + item.name + '" v' + item.version + '. Preview it, enable the reviewed version, then use /supportforge workflow execute inside an active ticket. Department reassignment remains blocked until channel-visibility reconciliation is supported.');
        return true;
      }
      if (subcommand === 'restore-revision') {
        const templateId = interaction.options.getString('template-id', true).trim();
        const saved = await restoreWorkflowTemplateRevision(
          guildId,
          templateId,
          interaction.options.getInteger('revision', true),
          interaction.options.getInteger('expected-version', true),
          actorId,
        );
        if (config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'WORKFLOW_TEMPLATE_REVISION_RESTORED',
          actorId,
          actorName: interaction.user.tag,
          detail: 'Restored retained workflow definition for template ' + saved.id + ' into version ' + saved.version + '; left disabled for review.',
        });
        await interaction.editReply('Restored the selected workflow revision as version ' + saved.version + '. It is disabled and non-executable until reviewed.');
        return true;
      }
      if (subcommand === 'preview') {
        const preview = await previewWorkflowTemplateById(guildId, interaction.options.getString('template-id', true).trim());
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('Workflow template safety preview')
            .setDescription('Manual execution supported: **' + (preview.executable ? 'yes' : 'no') + '**\nAutomatic execution: **no**\nConditions: ' + preview.conditionCount + '\nActions: ' + preview.actionCount + '\n\n' + preview.warnings.map((warning) => '• ' + warning).join('\n').slice(0, 3400))],
        });
        return true;
      }
      if (subcommand === 'enable') {
        const item = await setWorkflowTemplateEnabled(
          guildId,
          interaction.options.getString('template-id', true).trim(),
          interaction.options.getInteger('version', true),
          interaction.options.getBoolean('enabled', true),
          actorId,
        );
        if (config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'WORKFLOW_TEMPLATE_CATALOGUE_TOGGLE', actorId, actorName: interaction.user.tag,
          detail: 'Set workflow template ' + item.id + ' enabled=' + item.enabled + ' at version ' + item.version + '. Manual execution still requires explicit admin confirmation; automatic triggers remain disabled.',
        });
        await interaction.editReply('Workflow template is now ' + (item.enabled ? 'enabled for manual execution' : 'disabled') + ' at version ' + item.version + '. It never runs automatically. Use /supportforge workflow preview before execution.');
        return true;
      }
      if (subcommand === 'delete') {
        if (!interaction.options.getBoolean('confirm', true)) throw new Error('Delete was not confirmed. No workflow template was removed.');
        const templateId = interaction.options.getString('template-id', true).trim();
        const removed = await deleteWorkflowTemplate(
          guildId,
          templateId,
          interaction.options.getInteger('version', true),
          actorId,
        );
        if (removed && config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'WORKFLOW_TEMPLATE_DELETED', actorId, actorName: interaction.user.tag,
          detail: 'Deleted safe workflow template catalogue entry ' + templateId + '.',
        });
        await interaction.editReply(removed ? 'Workflow template deleted.' : 'No template matched that ID and version. Refresh before retrying.');
        return true;
      }
    }
  } catch (error) {
    if (error instanceof WorkflowExecutionFailure) {
      await interaction.editReply(formatWorkflowRun(error.details)).catch(() => undefined);
      return true;
    }
    const message = error instanceof Error ? error.message : 'Stage 4 command failed safely. Please retry later.';
    await interaction.editReply(message.slice(0, 1900)).catch(() => undefined);
    return true;
  }
  return true;
}
