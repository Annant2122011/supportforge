import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction, type TextChannel, type ThreadChannel } from 'discord.js';

import { getGuildConfig } from '../services/configService';
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
  listQuickReplies,
  renderQuickReply,
  saveQuickReply,
} from '../services/quickReplyService';
import { linkRelatedTickets, listRelatedTickets, unlinkRelatedTickets } from '../services/relatedTicketService';
import {
  deleteWorkflowTemplate,
  listWorkflowTemplates,
  previewWorkflowTemplateById,
  saveWorkflowTemplate,
  setWorkflowTemplateEnabled,
} from '../services/workflowTemplateService';

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
        await interaction.editReply('Created draft article "' + article.title + '". Article ID: ' + article.id + '. Revision: ' + article.revision + '. Publish it after review with /supportforge knowledge publish.');
        return true;
      }

      if (subcommand === 'list') {
        const articles = await listKnowledgeArticles(guildId, access, 25);
        const body = articles.length
          ? articles.map((article) =>
              '**' + article.title + '** (' + article.status + ', r' + article.revision + ')\\nID: ' + article.id +
              '\\nCategory: ' + article.category + ' • ' + article.visibility + '\\n' + (article.summary || 'No summary'),
            ).join('\\n\\n')
          : 'No Knowledge Base articles are available to you.';
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('📚 Knowledge Base Articles').setDescription(body.slice(0, 4000))
            .setFooter({ text: 'Only articles you are authorized to see are listed. Use the article ID with /supportforge knowledge view.' })],
        });
        return true;
      }

      if (subcommand === 'view') {
        const articleId = interaction.options.getString('article-id', true).trim();
        const page = interaction.options.getInteger('page') ?? 1;
        const article = await getKnowledgeArticle(guildId, articleId, access, true, actorId);
        if (!article) throw new Error('Article not found or you do not have permission to view it.');
        const pageSize = 3300;
        const pageCount = Math.max(1, Math.ceil(article.body.length / pageSize));
        if (page > pageCount) throw new Error('Article has ' + pageCount + ' page(s).');
        const excerpt = article.body.slice((page - 1) * pageSize, page * pageSize);
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle(article.title)
            .setDescription((article.summary ? article.summary + '\\n\\n' : '') + excerpt)
            .addFields(
              { name: 'Category', value: article.category, inline: true },
              { name: 'Tags', value: article.tags.join(', ') || 'None', inline: true },
              { name: 'Revision', value: String(article.revision), inline: true },
            )
            .setFooter({ text: 'Article ID ' + article.id + ' • Page ' + page + '/' + pageCount + ' • Updated ' + article.updatedAt })],
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
        if (!Object.keys(changes).length) throw new Error('Provide at least one article field to update.');
        const article = await updateKnowledgeArticle(
          guildId, interaction.options.getString('article-id', true).trim(),
          interaction.options.getInteger('revision', true), actorId, changes,
        );
        if (config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'KNOWLEDGE_ARTICLE_UPDATED', actorId, actorName: interaction.user.tag,
          detail: 'Updated Knowledge Base article ' + article.id + ' to revision ' + article.revision + '; changed fields=' + Object.keys(changes).join(',') + '.',
        });
        await interaction.editReply('Updated article "' + article.title + '" to revision ' + article.revision + '. The previous revision remains in history.');
        return true;
      }

      if (subcommand === 'publish' || subcommand === 'archive') {
        if (subcommand === 'archive' && !interaction.options.getBoolean('confirm', true)) {
          throw new Error('Archiving was not confirmed. No change was made.');
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
        await interaction.editReply('Article "' + article.title + '" is now ' + article.status + ' at revision ' + article.revision + '.');
        return true;
      }

      if (subcommand === 'search') {
        const results = await searchKnowledgeBase(guildId, interaction.options.getString('query', true), access, actorId);
        if (!results.length) {
          await interaction.editReply('No confident Knowledge Base match was found. This does not block ordinary human support; continue with a ticket if needed.');
          return true;
        }
        const body = results.map((result, index) =>
          '**' + (index + 1) + '. ' + result.title + '** • ' + result.confidence.toUpperCase() + ' confidence • score ' + result.score +
          '\\nID: ' + result.id + '\\n' + (result.summary || 'No summary') + '\\nCategory: ' + result.category,
        ).join('\\n\\n');
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('🔎 Knowledge Base Search').setDescription(body.slice(0, 4000))
            .setFooter({ text: 'Deterministic PostgreSQL search and typo-tolerant fallback • suggestions never replace human support' })],
        });
        return true;
      }

      if (subcommand === 'share') {
        if (!access.isStaff) throw accessDenied('a configured department staff role');
        const ticket = await requireTicketInCurrentChannel(interaction);
        const article = await getKnowledgeArticle(guildId, interaction.options.getString('article-id', true).trim(), access);
        if (!article || article.status !== 'published') throw new Error('Published article not found or you do not have permission to share it.');
        await requireTextChannel(interaction).send({
          embeds: [new EmbedBuilder().setTitle('📚 Suggested article: ' + article.title)
            .setDescription((article.summary ? article.summary + '\\n\\n' : '') +
              'Category: ' + article.category + '\\n' +
              'Tags: ' + (article.tags.join(', ') || 'none') + '\\n\\n' +
              'This is a suggested resource, not a replacement for human support. The ticket remains open for follow-up.')
            .setFooter({ text: 'Knowledge Base article ' + article.id + ' • revision ' + article.revision })],
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
        await interaction.editReply('Shared "' + article.title + '" in the current ticket. The message has no automatic user mentions.');
        return true;
      }

      if (subcommand === 'revisions') {
        const articleId = interaction.options.getString('article-id', true).trim();
        const revisions = await listKnowledgeArticleRevisions(guildId, articleId, access);
        await interaction.editReply(revisions.length
          ? revisions.map((item) => 'r' + item.revision + ' • ' + item.status + ' • ' + item.createdAt + '\\n' + item.title + ' • editor ' + item.changedBy).join('\\n\\n').slice(0, 4000)
          : 'No revision records were found.');
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
        await interaction.editReply('Restored historical content into a new revision. Article "' + article.title + '" is now revision ' + article.revision + '; previous history was not overwritten.');
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
        await interaction.editReply('Thank you. Your article feedback has been saved. Duplicate votes are blocked.');
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
        await interaction.editReply('Saved synonym mapping. Search logs retain usage counts, not raw customer queries.');
        return true;
      }

      if (subcommand === 'synonyms-list') {
        const synonyms = await listKnowledgeSynonyms(guildId);
        await interaction.editReply(synonyms.length
          ? synonyms.map((item) => '**' + item.term + '** → ' + (item.synonyms.join(', ') || 'no alternatives')).join('\\n').slice(0, 4000)
          : 'No synonyms have been configured.');
        return true;
      }

      if (subcommand === 'synonyms-delete') {
        const deleted = await deleteKnowledgeSynonyms(guildId, interaction.options.getString('term', true));
        if (deleted && config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'KNOWLEDGE_SYNONYMS_DELETED', actorId, actorName: interaction.user.tag,
          detail: 'Deleted deterministic Knowledge Base synonym mapping.',
        });
        await interaction.editReply(deleted ? 'Removed that synonym mapping.' : 'No matching synonym mapping was found.');
        return true;
      }

      if (subcommand === 'metrics') {
        const days = interaction.options.getInteger('days') ?? 30;
        const metrics = await getKnowledgeBaseMetrics(guildId, days);
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('📊 Knowledge Base Metrics')
            .setDescription(
              'Window: ' + days + ' days\\nPublished articles: ' + metrics.publishedArticles +
              '\\nDraft articles: ' + metrics.draftArticles + '\\nArchived articles: ' + metrics.archivedArticles +
              '\\nSearch-result appearances: ' + metrics.searchResultEvents + '\\nViews: ' + metrics.articleViews +
              '\\nShares: ' + metrics.articleShares + '\\nHelpful votes: ' + metrics.helpfulVotes +
              '\\nUnhelpful votes: ' + metrics.unhelpfulVotes,
            )
            .setFooter({ text: 'Only per-server aggregate usage is displayed. Raw search queries are not stored.' })],
        });
        return true;
      }
    }

    if (group === 'quick-reply') {
      const needsStaff = ['list','show','send'].includes(subcommand);
      if (needsStaff && !access.isStaff) throw accessDenied('a configured department staff role');
      if (subcommand === 'list') {
        const replies = await listQuickReplies(guildId, { isAdmin: access.isAdmin, roleIds: access.roleIds }, interaction.options.getString('category') ?? undefined);
        await interaction.editReply(replies.length
          ? replies.map((reply) => '**' + reply.name + '** • ' + reply.category + ' • ' + reply.id + ' • v' + reply.version + '\\nTags: ' + (reply.tags.join(', ') || 'none')).join('\\n\\n').slice(0, 4000)
          : 'No quick replies are available to you.');
        return true;
      }
      if (subcommand === 'show') {
        const reply = await getQuickReply(guildId, interaction.options.getString('name-or-id', true), { isAdmin: access.isAdmin, roleIds: access.roleIds });
        if (!reply) throw new Error('Quick reply not found or unavailable to your roles.');
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle(reply.name).setDescription(reply.body)
            .addFields({ name: 'Category', value: reply.category, inline: true },{ name:'Tags',value:reply.tags.join(', ')||'none',inline:true })
            .setFooter({ text: 'Supported placeholders: {user}, {username}, {ticket_id}, {ticket_number}, {department}, {priority}, {staff}' })],
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
        });
        if (config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'QUICK_REPLY_SAVED', actorId, actorName: interaction.user.tag,
          detail: 'Saved quick reply ' + reply.id + ' version ' + reply.version + '; role restrictions count=' + reply.allowedRoleIds.length + '.',
        });
        await interaction.editReply('Saved quick reply "' + reply.name + '" at version ' + reply.version + '.');
        return true;
      }
      if (subcommand === 'delete') {
        if (!access.isAdmin) throw accessDenied('Manage Server or Administrator permission');
        if (!interaction.options.getBoolean('confirm', true)) throw new Error('Delete was not confirmed. No quick reply was removed.');
        const quickReplyId = interaction.options.getString('name-or-id', true);
        const deleted = await deleteQuickReply(guildId, quickReplyId);
        if (deleted && config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'QUICK_REPLY_DELETED', actorId, actorName: interaction.user.tag,
          detail: 'Deleted quick reply identified by ' + quickReplyId.slice(0, 80) + '.',
        });
        await interaction.editReply(deleted ? 'Quick reply deleted.' : 'No matching quick reply was found.');
        return true;
      }
      if (subcommand === 'send') {
        const ticket = await requireTicketInCurrentChannel(interaction);
        const reply = await getQuickReply(guildId, interaction.options.getString('name-or-id', true), { isAdmin: access.isAdmin, roleIds: access.roleIds });
        if (!reply) throw new Error('Quick reply not found or unavailable to your roles.');
        const department = ticket.departmentId ? config.departments[ticket.departmentId] : undefined;
        const rendered = renderQuickReply(reply, {
          user: ticket.ownerId ? '<@' + ticket.ownerId + '>' : 'customer',
          username: interaction.user.username,
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber ?? '',
          department: department?.name ?? ticket.departmentId ?? '',
          priority: ticket.priority ?? 'normal',
          staff: interaction.user.username,
        });
        await requireTextChannel(interaction).send({ content: rendered, allowedMentions: { parse: [] } });
        if (config.supportCategoryId) await logTicketEvent(interaction.guild!, config.supportCategoryId, {
          ticketNumber: ticket.ticketNumber ?? ticket.id,
          ticketChannelId: ticket.channelId,
          event: 'QUICK_REPLY_SENT',
          actorId,
          actor: interaction.user.tag,
          actorName: interaction.user.tag,
          detail: 'Sent quick reply ' + reply.id + ' version ' + reply.version + '.',
        });
        await interaction.editReply('Sent quick reply "' + reply.name + '". User/role mentions were suppressed.');
        return true;
      }
    }

    if (group === 'related') {
      const ticket = await requireTicketInCurrentChannel(interaction, false);
      if (!access.isStaff) throw accessDenied('a configured department staff role');
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
          ? related.map((item) => '**Ticket ' + (item.ticketNumber ?? item.ticketId.slice(0, 8)) + '** • <#' + item.channelId + '> • ' + item.status + ' • ' + (item.priority ?? 'normal') + '\\nID: ' + item.ticketId).join('\\n\\n').slice(0, 4000)
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
      if (subcommand === 'list') {
        const templates = await listWorkflowTemplates(guildId);
        await interaction.editReply(templates.length
          ? templates.map((item) => '**' + item.name + '** • ' + item.id + ' • v' + item.version + ' • ' + (item.enabled ? 'catalogue enabled' : 'disabled') +
              '\\nConditions: ' + item.definition.conditions.length + ' • actions: ' + item.definition.actions.length).join('\\n\\n').slice(0, 4000)
          : 'No workflow templates exist.');
        return true;
      }
      if (subcommand === 'save') {
        let definition: unknown;
        try { definition = JSON.parse(interaction.options.getString('definition-json', true)); }
        catch { throw new Error('Definition must be valid JSON. Example: {"conditions":[{"field":"priority","equals":"urgent"}],"actions":[{"type":"assign_department","value":"billing"}]}'); }
        const item = await saveWorkflowTemplate(guildId, actorId, interaction.options.getString('name', true), definition);
        if (config.supportCategoryId) await logSettingsEvent(interaction.guild!, config.supportCategoryId, {
          action: 'WORKFLOW_TEMPLATE_SAVED', actorId, actorName: interaction.user.tag,
          detail: 'Saved validated workflow template ' + item.id + ' version ' + item.version + '; execution remains disabled.',
        });
        await interaction.editReply('Saved validated workflow template "' + item.name + '" v' + item.version + '. It remains non-executable; no ticket action was run.');
        return true;
      }
      if (subcommand === 'preview') {
        const preview = await previewWorkflowTemplateById(guildId, interaction.options.getString('template-id', true).trim());
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('Workflow template safety preview')
            .setDescription('Executable: **no**\\nConditions: ' + preview.conditionCount + '\\nActions: ' + preview.actionCount + '\\n\\n' + preview.warnings.map((warning) => '• ' + warning).join('\\n').slice(0, 3500))],
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
          detail: 'Set workflow template ' + item.id + ' enabled=' + item.enabled + ' at version ' + item.version + '. Execution is still not implemented.',
        });
        await interaction.editReply('Workflow template catalogue entry is now ' + (item.enabled ? 'enabled' : 'disabled') + ' at version ' + item.version + '. Automatic execution remains disabled.');
        return true;
      }
      if (subcommand === 'delete') {
        if (!interaction.options.getBoolean('confirm', true)) throw new Error('Delete was not confirmed. No workflow template was removed.');
        const templateId = interaction.options.getString('template-id', true).trim();
        const removed = await deleteWorkflowTemplate(
          guildId,
          templateId,
          interaction.options.getInteger('version', true),
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
    const message = error instanceof Error ? error.message : 'Stage 4 command failed safely. Please retry later.';
    await interaction.editReply(message.slice(0, 1900)).catch(() => undefined);
    return true;
  }
  return true;
}
