import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { closePostgresDatabase, getPostgresPool } from '../src/core/persistence/postgresDatabase';
import { migratePostgres } from '../src/core/persistence/migrationRunner';
import {
  createKnowledgeArticle,
  createQuickReply,
  getKnowledgeArticleRevisions,
  getKnowledgeBaseMetrics,
  getQuickReplyMetrics,
  listKnowledgeArticlesPage,
  listQuickReplies,
  recordKnowledgeArticleView,
  recordQuickReplyUsage,
  saveKnowledgeSynonyms,
  searchKnowledgeBase,
  setKnowledgeArticleStatus,
  setQuickReplyEnabled,
  submitKnowledgeArticleFeedback,
  updateKnowledgeArticle,
  updateQuickReply,
} from '../src/services/knowledgeBaseService';

const hasPostgres =
  process.env.SUPPORTFORGE_POSTGRES_TEST === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DATABASE_URL_UNPOOLED);

const isLocalPostgres = [
  process.env.DATABASE_URL,
  process.env.DATABASE_URL_UNPOOLED,
].every((value) => {
  try {
    const hostname = new URL(value ?? '').hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
});

const enabled = hasPostgres && isLocalPostgres;

if (hasPostgres && !isLocalPostgres) {
  throw new Error(
    'Refusing Knowledge Base integration tests against a non-local database. ' +
      'Use the disposable local PostgreSQL service for SUPPORTFORGE_POSTGRES_TEST=1.',
  );
}

test(
  'Knowledge Base and quick replies preserve revisions, visibility, synonyms and tenant boundaries',
  { skip: !enabled },
  async () => {
    await migratePostgres();
    const pool = getPostgresPool();
    const guildId = 'kb-test-' + randomUUID();
    const otherGuildId = 'kb-test-' + randomUUID();
    const actorId = '223456789012345678';
    const customerId = '323456789012345678';

    try {
      const publicDraft = await createKnowledgeArticle({
        guildId,
        title: 'Refund Policy',
        body: 'Customers can request a refund for eligible orders within 30 days.',
        category: 'Billing',
        tags: ['refund', 'billing'],
        visibility: 'public',
        actorId,
      });
      const staffDraft = await createKnowledgeArticle({
        guildId,
        title: 'Internal Refund Escalation',
        body: 'Staff should verify the payment reference before escalating.',
        category: 'Billing',
        tags: ['refund', 'staff'],
        visibility: 'staff',
        actorId,
      });

      assert.equal(publicDraft.status, 'draft');
      assert.equal(publicDraft.revision, 1);
      assert.equal((await listKnowledgeArticlesPage(guildId, 'published', { includeStaff: false })).total, 0);

      const publishedPublic = await setKnowledgeArticleStatus(guildId, publicDraft.id, 'published', actorId);
      const publishedStaff = await setKnowledgeArticleStatus(guildId, staffDraft.id, 'published', actorId);
      assert.equal(publishedPublic.revision, 2);
      assert.equal(publishedStaff.visibility, 'staff');

      const publicList = await listKnowledgeArticlesPage(guildId, 'published', { includeStaff: false, page: 1 });
      const staffList = await listKnowledgeArticlesPage(guildId, 'published', { includeStaff: true, page: 1 });
      assert.equal(publicList.total, 1);
      assert.deepEqual(publicList.articles.map((article) => article.id), [publicDraft.id]);
      assert.equal(staffList.total, 2);

      const exactSearch = await searchKnowledgeBase({ guildId, query: 'refund', includeStaff: false });
      assert.ok(exactSearch.some((result) => result.article.id === publicDraft.id));
      assert.ok(exactSearch.every((result) => result.article.visibility === 'public'));

      await saveKnowledgeSynonyms(guildId, 'refund', ['reimbursement'], actorId);
      const synonymSearch = await searchKnowledgeBase({ guildId, query: 'reimbursement', includeStaff: false });
      assert.ok(synonymSearch.some((result) => result.article.id === publicDraft.id));

      const edited = await updateKnowledgeArticle({
        guildId,
        articleId: publicDraft.id,
        actorId,
        body: 'Updated refund guidance: eligible orders within 45 days.',
      });
      assert.equal(edited.status, 'draft', 'editing published guidance must require republishing');
      assert.equal(edited.revision, 3);
      assert.equal((await listKnowledgeArticlesPage(guildId, 'published', { includeStaff: false })).total, 0);
      const revisions = await getKnowledgeArticleRevisions(guildId, publicDraft.id);
      assert.deepEqual(revisions.map((revision) => revision.revision), [3, 2, 1]);

      await setKnowledgeArticleStatus(guildId, publicDraft.id, 'published', actorId);
      await recordKnowledgeArticleView(guildId, publicDraft.id);
      await submitKnowledgeArticleFeedback({ guildId, articleId: publicDraft.id, userId: customerId, helpful: true });
      await submitKnowledgeArticleFeedback({ guildId, articleId: publicDraft.id, userId: customerId, helpful: false });
      const metrics = await getKnowledgeBaseMetrics(
        guildId,
        new Date(Date.now() - 60_000).toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      );
      assert.equal(metrics.feedbackVotes, 1, 'a user can update one current vote but cannot inflate response count');
      assert.equal(metrics.helpfulVotes, 0);
      assert.ok(metrics.views >= 1);

      const reply = await createQuickReply({
        guildId,
        name: 'Refund update',
        content: 'Hello {user}, your ticket {ticket_number} is being reviewed by {department}.',
        departmentId: 'billing',
        tags: ['billing'],
        actorId,
      });
      assert.equal(reply.revision, 1);
      assert.equal((await listQuickReplies(guildId, { departmentIds: ['billing'] })).length, 1);
      assert.equal((await listQuickReplies(otherGuildId, { departmentIds: ['billing'] })).length, 0);

      const changedReply = await updateQuickReply({
        guildId,
        id: reply.id,
        actorId,
        content: 'Update for {user}: your case is still in review.',
      });
      assert.equal(changedReply.revision, 2);

      await setQuickReplyEnabled(guildId, reply.id, false, actorId);
      await assert.rejects(
        () => recordQuickReplyUsage(guildId, reply.id, actorId),
        /disabled or no longer exists/,
      );
      await setQuickReplyEnabled(guildId, reply.id, true, actorId);
      await recordQuickReplyUsage(guildId, reply.id, actorId);
      const usage = await getQuickReplyMetrics(
        guildId,
        new Date(Date.now() - 60_000).toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      );
      assert.equal(usage.find((item) => item.id === reply.id)?.uses, 1);

      await pool.query('SELECT 1');
    } finally {
      await pool.query('DELETE FROM knowledge_base_articles WHERE guild_id=$1', [guildId]).catch(() => undefined);
      await pool.query('DELETE FROM knowledge_base_synonyms WHERE guild_id=$1', [guildId]).catch(() => undefined);
      await pool.query('DELETE FROM quick_reply_templates WHERE guild_id=$1', [guildId]).catch(() => undefined);
      await closePostgresDatabase();
    }
  },
);
