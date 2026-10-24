import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import {
  fuzzyKnowledgeScore,
  normalizeKnowledgeTags,
  normalizeKnowledgeText,
  slugifyKnowledgeTitle,
  validateQuickReplyTemplate,
  type KnowledgeVisibility,
  type QuickReplyPlaceholder,
} from '../core/domain/knowledgeTools';

export type KnowledgeArticleStatus = 'draft' | 'published' | 'archived';
export type KnowledgeUsageAction = 'search_result' | 'view' | 'share';

export interface KnowledgeArticle {
  id: string;
  guildId: string;
  slug: string;
  title: string;
  body: string;
  category: string;
  tags: string[];
  visibility: KnowledgeVisibility;
  status: KnowledgeArticleStatus;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface KnowledgeSearchResult {
  article: KnowledgeArticle;
  score: number;
  confidence: 'matched' | 'suggestion';
}

export interface KnowledgeBaseMetrics {
  publishedArticles: number;
  draftArticles: number;
  archivedArticles: number;
  views: number;
  searchResultViews: number;
  shares: number;
  feedbackVotes: number;
  helpfulVotes: number;
  helpfulRate: number | null;
}

export interface QuickReplyTemplate {
  id: string;
  guildId: string;
  name: string;
  content: string;
  departmentId: string;
  tags: string[];
  enabled: boolean;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface ArticleRow extends QueryResultRow {
  id: string;
  guild_id: string;
  slug: string;
  title: string;
  body: string;
  category: string;
  tags: string[] | null;
  visibility: KnowledgeVisibility;
  status: KnowledgeArticleStatus;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  published_at: Date | string | null;
  rank?: number | string;
}

interface QuickReplyRow extends QueryResultRow {
  id: string;
  guild_id: string;
  name: string;
  content: string;
  department_id: string;
  tags: string[] | null;
  enabled: boolean;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function articleFromRow(row: ArticleRow): KnowledgeArticle {
  return {
    id: row.id,
    guildId: row.guild_id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    category: row.category,
    tags: Array.isArray(row.tags) ? row.tags : [],
    visibility: row.visibility,
    status: row.status,
    revision: Number(row.revision),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    publishedAt: iso(row.published_at),
  };
}

function quickReplyFromRow(row: QuickReplyRow): QuickReplyTemplate {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    content: row.content,
    departmentId: row.department_id,
    tags: Array.isArray(row.tags) ? row.tags : [],
    enabled: Boolean(row.enabled),
    revision: Number(row.revision),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

const ARTICLE_COLUMNS = 'id,guild_id,slug,title,body,category,tags,visibility,status,revision,created_by,updated_by,created_at,updated_at,published_at';
const QUICK_REPLY_COLUMNS = 'id,guild_id,name,content,department_id,tags,enabled,revision,created_by,updated_by,created_at,updated_at';

function validateArticleInput(input: {
  title?: string;
  body?: string;
  category?: string;
  tags?: readonly string[];
  visibility?: string;
}): void {
  if (input.title !== undefined && (!input.title.trim() || input.title.trim().length > 180)) {
    throw new Error('Article title must contain 1–180 characters.');
  }
  if (input.body !== undefined && (!input.body.trim() || input.body.length > 20000)) {
    throw new Error('Article body must contain 1–20,000 characters.');
  }
  if (input.category !== undefined && (!input.category.trim() || input.category.trim().length > 80)) {
    throw new Error('Article category must contain 1–80 characters.');
  }
  if (input.visibility !== undefined && input.visibility !== 'public' && input.visibility !== 'staff') {
    throw new Error('Article visibility must be public or staff.');
  }
}

function normalizeSynonymList(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeKnowledgeText(value);
    if (!normalized || normalized.length > 60) {
      if (value.trim()) throw new Error('Each synonym must contain 1–60 characters.');
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= 20) break;
  }
  return result;
}

async function inTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertArticleRevision(
  client: PoolClient,
  article: KnowledgeArticle,
  changedBy: string,
): Promise<void> {
  await client.query(
    'INSERT INTO knowledge_base_article_revisions ' +
      '(article_id,guild_id,revision,slug,title,body,category,tags,visibility,status,changed_by,created_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())',
    [article.id, article.guildId, article.revision, article.slug, article.title, article.body,
      article.category, article.tags, article.visibility, article.status, changedBy],
  );
}

async function insertQuickReplyRevision(
  client: PoolClient,
  template: QuickReplyTemplate,
  changedBy: string,
): Promise<void> {
  await client.query(
    'INSERT INTO quick_reply_template_revisions ' +
      '(quick_reply_id,guild_id,revision,name,content,department_id,tags,enabled,changed_by,created_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())',
    [template.id, template.guildId, template.revision, template.name, template.content,
      template.departmentId, template.tags, template.enabled, changedBy],
  );
}

export async function createKnowledgeArticle(args: {
  guildId: string;
  title: string;
  body: string;
  category?: string;
  tags?: readonly string[];
  visibility?: KnowledgeVisibility;
  actorId: string;
}): Promise<KnowledgeArticle> {
  validateArticleInput(args);
  const title = args.title.trim();
  const body = args.body.trim();
  const category = (args.category ?? 'General').trim() || 'General';
  const tags = normalizeKnowledgeTags(args.tags ?? []);
  const visibility = args.visibility ?? 'public';
  const id = randomUUID();
  const baseSlug = slugifyKnowledgeTitle(title);
  const candidateSlugs = [baseSlug, baseSlug + '-' + id.slice(0, 6)];
  let lastError: unknown;

  for (const slug of candidateSlugs) {
    try {
      return await inTransaction(async (client) => {
        const result = await client.query<ArticleRow>(
          'INSERT INTO knowledge_base_articles ' +
            '(id,guild_id,slug,title,body,category,tags,visibility,status,revision,created_by,updated_by,created_at,updated_at) ' +
            'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,\'draft\',1,$9,$9,NOW(),NOW()) ' +
            'RETURNING ' + ARTICLE_COLUMNS,
          [id, args.guildId, slug, title, body, category, tags, visibility, args.actorId],
        );
        const article = articleFromRow(result.rows[0]);
        await insertArticleRevision(client, article, args.actorId);
        return article;
      });
    } catch (error) {
      lastError = error;
      const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
      if (code !== '23505') throw error;
    }
  }
  throw new Error('An article with this slug already exists. Use a more specific title. ' + (lastError instanceof Error ? lastError.message : ''));
}

export async function getKnowledgeArticle(
  guildId: string,
  idOrSlug: string,
  options: { publishedOnly?: boolean; includeStaff?: boolean } = {},
): Promise<KnowledgeArticle | null> {
  const conditions = ['guild_id=$1', '(id=$2 OR slug=$2)'];
  const values: unknown[] = [guildId, idOrSlug.trim()];
  if (options.publishedOnly) conditions.push("status='published'");
  if (!options.includeStaff) conditions.push("visibility='public'");
  const result = await getPostgresPool().query<ArticleRow>(
    'SELECT ' + ARTICLE_COLUMNS + ' FROM knowledge_base_articles WHERE ' + conditions.join(' AND ') + ' LIMIT 1',
    values,
  );
  return result.rows[0] ? articleFromRow(result.rows[0]) : null;
}

export async function updateKnowledgeArticle(args: {
  guildId: string;
  articleId: string;
  actorId: string;
  title?: string;
  body?: string;
  category?: string;
  tags?: readonly string[];
  visibility?: KnowledgeVisibility;
}): Promise<KnowledgeArticle> {
  validateArticleInput(args);
  return inTransaction(async (client) => {
    const currentResult = await client.query<ArticleRow>(
      'SELECT ' + ARTICLE_COLUMNS + ' FROM knowledge_base_articles WHERE guild_id=$1 AND id=$2 FOR UPDATE',
      [args.guildId, args.articleId],
    );
    const currentRow = currentResult.rows[0];
    if (!currentRow) throw new Error('Knowledge article was not found in this server.');
    const current = articleFromRow(currentRow);
    const nextTitle = args.title === undefined ? current.title : args.title.trim();
    const nextBody = args.body === undefined ? current.body : args.body.trim();
    const nextCategory = args.category === undefined ? current.category : (args.category.trim() || 'General');
    const nextTags = args.tags === undefined ? current.tags : normalizeKnowledgeTags(args.tags);
    const nextVisibility = args.visibility ?? current.visibility;
    const nextStatus: KnowledgeArticleStatus = current.status === 'published' ? 'draft' : current.status;
    const revision = current.revision + 1;
    const result = await client.query<ArticleRow>(
      'UPDATE knowledge_base_articles SET title=$3,body=$4,category=$5,tags=$6,visibility=$7,status=$8,revision=$9,updated_by=$10,updated_at=NOW(),published_at=CASE WHEN $8=\'published\' THEN published_at ELSE NULL END ' +
        'WHERE guild_id=$1 AND id=$2 RETURNING ' + ARTICLE_COLUMNS,
      [args.guildId, args.articleId, nextTitle, nextBody, nextCategory, nextTags, nextVisibility, nextStatus, revision, args.actorId],
    );
    const article = articleFromRow(result.rows[0]);
    await insertArticleRevision(client, article, args.actorId);
    return article;
  });
}

export async function setKnowledgeArticleStatus(
  guildId: string,
  articleId: string,
  status: Exclude<KnowledgeArticleStatus, 'draft'>,
  actorId: string,
): Promise<KnowledgeArticle> {
  return inTransaction(async (client) => {
    const currentResult = await client.query<ArticleRow>(
      'SELECT ' + ARTICLE_COLUMNS + ' FROM knowledge_base_articles WHERE guild_id=$1 AND id=$2 FOR UPDATE',
      [guildId, articleId],
    );
    if (!currentResult.rows[0]) throw new Error('Knowledge article was not found in this server.');
    const current = articleFromRow(currentResult.rows[0]);
    if (current.status === status) return current;
    const revision = current.revision + 1;
    const result = await client.query<ArticleRow>(
      'UPDATE knowledge_base_articles SET status=$3,revision=$4,updated_by=$5,updated_at=NOW(),published_at=CASE WHEN $3=\'published\' THEN NOW() ELSE NULL END ' +
        'WHERE guild_id=$1 AND id=$2 RETURNING ' + ARTICLE_COLUMNS,
      [guildId, articleId, status, revision, actorId],
    );
    const article = articleFromRow(result.rows[0]);
    await insertArticleRevision(client, article, actorId);
    return article;
  });
}

export async function listKnowledgeArticles(
  guildId: string,
  status: KnowledgeArticleStatus | 'all' = 'published',
): Promise<KnowledgeArticle[]> {
  const result = await getPostgresPool().query<ArticleRow>(
    'SELECT ' + ARTICLE_COLUMNS + ' FROM knowledge_base_articles WHERE guild_id=$1 ' +
      (status === 'all' ? '' : 'AND status=$2 ') +
      'ORDER BY CASE status WHEN \'published\' THEN 0 WHEN \'draft\' THEN 1 ELSE 2 END, updated_at DESC LIMIT 200',
    status === 'all' ? [guildId] : [guildId, status],
  );
  return result.rows.map(articleFromRow);
}

export async function listKnowledgeArticlesPage(
  guildId: string,
  status: KnowledgeArticleStatus | 'all',
  options: { includeStaff?: boolean; page?: number; pageSize?: number } = {},
): Promise<{ articles: KnowledgeArticle[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.max(5, Math.min(25, Math.floor(options.pageSize ?? 20)));
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const conditions = ['guild_id=$1'];
  const values: unknown[] = [guildId];
  if (status !== 'all') {
    values.push(status);
    conditions.push('status=$' + values.length);
  }
  if (!options.includeStaff) conditions.push("visibility='public'");
  const where = conditions.join(' AND ');
  const pool = getPostgresPool();
  const countResult = await pool.query<QueryResultRow & { count: number | string }>(
    'SELECT COUNT(*)::int AS count FROM knowledge_base_articles WHERE ' + where,
    values,
  );
  const total = Number(countResult.rows[0]?.count ?? 0);
  const paginatedValues = [...values, pageSize, (page - 1) * pageSize];
  const result = await pool.query<ArticleRow>(
    'SELECT ' + ARTICLE_COLUMNS + ' FROM knowledge_base_articles WHERE ' + where +
      ' ORDER BY CASE status WHEN \'published\' THEN 0 WHEN \'draft\' THEN 1 ELSE 2 END, updated_at DESC ' +
      'LIMIT $' + (values.length + 1) + ' OFFSET $' + (values.length + 2),
    paginatedValues,
  );
  return { articles: result.rows.map(articleFromRow), total, page, pageSize };
}

export async function getKnowledgeArticleRevisions(
  guildId: string,
  articleId: string,
): Promise<Array<{ revision: number; title: string; status: KnowledgeArticleStatus; changedBy: string; createdAt: string }>> {
  const result = await getPostgresPool().query<QueryResultRow & {
    revision: number; title: string; status: KnowledgeArticleStatus; changed_by: string; created_at: Date | string;
  }>(
    'SELECT revision,title,status,changed_by,created_at FROM knowledge_base_article_revisions WHERE guild_id=$1 AND article_id=$2 ORDER BY revision DESC LIMIT 20',
    [guildId, articleId],
  );
  return result.rows.map((row) => ({
    revision: Number(row.revision),
    title: row.title,
    status: row.status,
    changedBy: row.changed_by,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  }));
}

export async function saveKnowledgeSynonyms(
  guildId: string,
  term: string,
  values: readonly string[],
  actorId: string,
): Promise<string[]> {
  const normalizedTerm = normalizeKnowledgeText(term);
  if (!normalizedTerm || normalizedTerm.length > 60) throw new Error('Synonym term must contain 1–60 characters.');
  const synonyms = normalizeSynonymList(values).filter((value) => value !== normalizedTerm);
  await getPostgresPool().query(
    'INSERT INTO knowledge_base_synonyms (guild_id,normalized_term,synonyms,updated_by,updated_at) VALUES ($1,$2,$3,$4,NOW()) ' +
      'ON CONFLICT (guild_id,normalized_term) DO UPDATE SET synonyms=EXCLUDED.synonyms,updated_by=EXCLUDED.updated_by,updated_at=NOW()',
    [guildId, normalizedTerm, synonyms, actorId],
  );
  return synonyms;
}

export async function listKnowledgeSynonyms(guildId: string): Promise<Array<{ term: string; synonyms: string[] }>> {
  const result = await getPostgresPool().query<QueryResultRow & { normalized_term: string; synonyms: string[] }>(
    'SELECT normalized_term,synonyms FROM knowledge_base_synonyms WHERE guild_id=$1 ORDER BY normalized_term LIMIT 200',
    [guildId],
  );
  return result.rows.map((row) => ({ term: row.normalized_term, synonyms: Array.isArray(row.synonyms) ? row.synonyms : [] }));
}

export async function deleteKnowledgeSynonyms(guildId: string, term: string): Promise<boolean> {
  const normalized = normalizeKnowledgeText(term);
  const result = await getPostgresPool().query('DELETE FROM knowledge_base_synonyms WHERE guild_id=$1 AND normalized_term=$2', [guildId, normalized]);
  return (result.rowCount ?? 0) > 0;
}

async function getKnowledgeSynonymExpansions(guildId: string, tokens: string[]): Promise<string[]> {
  if (!tokens.length) return [];
  const terms = Array.from(new Set([tokens.join(' '), ...tokens]));
  const result = await getPostgresPool().query<QueryResultRow & { normalized_term: string; synonyms: string[] }>(
    'SELECT normalized_term,synonyms FROM knowledge_base_synonyms WHERE guild_id=$1 AND normalized_term=ANY($2::text[])',
    [guildId, terms],
  );
  return result.rows.flatMap((row) => Array.isArray(row.synonyms) ? row.synonyms : []);
}

export async function recordKnowledgeUsage(
  guildId: string,
  articleId: string,
  action: KnowledgeUsageAction,
): Promise<void> {
  await getPostgresPool().query(
    'INSERT INTO knowledge_base_usage (id,guild_id,article_id,action,created_at) VALUES ($1,$2,$3,$4,NOW())',
    [randomUUID(), guildId, articleId, action],
  );
}

export async function submitKnowledgeArticleFeedback(args: {
  guildId: string;
  articleId: string;
  userId: string;
  helpful: boolean;
  comment?: string;
  includeStaff?: boolean;
}): Promise<void> {
  const comment = args.comment?.trim() ?? '';
  if (comment.length > 500) throw new Error('Feedback comment must be 500 characters or fewer.');
  const articleResult = await getPostgresPool().query<QueryResultRow & { id: string }>(
    'SELECT id FROM knowledge_base_articles WHERE guild_id=$1 AND id=$2 AND status=\'published\' ' +
      (args.includeStaff ? '' : "AND visibility='public' ") + 'LIMIT 1',
    [args.guildId, args.articleId],
  );
  if (!articleResult.rows[0]) throw new Error('Published article was not found or you do not have permission to rate it.');
  await getPostgresPool().query(
    'INSERT INTO knowledge_base_feedback (guild_id,article_id,user_id,helpful,comment,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,NOW(),NOW()) ' +
      'ON CONFLICT (guild_id,article_id,user_id) DO UPDATE SET helpful=EXCLUDED.helpful,comment=EXCLUDED.comment,updated_at=NOW()',
    [args.guildId, args.articleId, args.userId, args.helpful, comment],
  );
}

export async function getKnowledgeBaseMetrics(guildId: string, from: string, to: string): Promise<KnowledgeBaseMetrics> {
  const pool = getPostgresPool();
  const [articles, usage, feedback] = await Promise.all([
    pool.query<QueryResultRow & { status: string; count: number | string }>(
      'SELECT status,COUNT(*)::int AS count FROM knowledge_base_articles WHERE guild_id=$1 GROUP BY status',
      [guildId],
    ),
    pool.query<QueryResultRow & { action: string; count: number | string }>(
      'SELECT action,COUNT(*)::int AS count FROM knowledge_base_usage WHERE guild_id=$1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz GROUP BY action',
      [guildId, from, to],
    ),
    pool.query<QueryResultRow & { votes: number | string; helpful: number | string }>(
      'SELECT COUNT(*)::int AS votes,COUNT(*) FILTER (WHERE helpful)::int AS helpful FROM knowledge_base_feedback WHERE guild_id=$1 AND updated_at >= $2::timestamptz AND updated_at < $3::timestamptz',
      [guildId, from, to],
    ),
  ]);
  const count = (rows: Array<{ action?: string; status?: string; count: number | string }>, key: string, value: string): number =>
    Number(rows.find((row) => row[key as 'action' | 'status'] === value)?.count ?? 0);
  const feedbackVotes = Number(feedback.rows[0]?.votes ?? 0);
  const helpfulVotes = Number(feedback.rows[0]?.helpful ?? 0);
  return {
    publishedArticles: count(articles.rows, 'status', 'published'),
    draftArticles: count(articles.rows, 'status', 'draft'),
    archivedArticles: count(articles.rows, 'status', 'archived'),
    views: count(usage.rows, 'action', 'view'),
    searchResultViews: count(usage.rows, 'action', 'search_result'),
    shares: count(usage.rows, 'action', 'share'),
    feedbackVotes,
    helpfulVotes,
    helpfulRate: feedbackVotes ? helpfulVotes / feedbackVotes : null,
  };
}

export async function recordKnowledgeArticleView(guildId: string, articleId: string): Promise<void> {
  await recordKnowledgeUsage(guildId, articleId, 'view');
}
export async function recordKnowledgeArticleShare(guildId: string, articleId: string): Promise<void> {
  await recordKnowledgeUsage(guildId, articleId, 'share');
}

export async function createQuickReply(args: {
  guildId: string;
  name: string;
  content: string;
  departmentId?: string;
  tags?: readonly string[];
  actorId: string;
}): Promise<QuickReplyTemplate> {
  const name = args.name.trim();
  const content = args.content.trim();
  if (!name || name.length > 80) throw new Error('Quick reply name must contain 1–80 characters.');
  validateQuickReplyTemplate(content);
  const departmentId = args.departmentId?.trim() || '*';
  if (departmentId !== '*' && departmentId.length > 80) throw new Error('Department ID is invalid.');
  const tags = normalizeKnowledgeTags(args.tags ?? []);
  return inTransaction(async (client) => {
    const result = await client.query<QuickReplyRow>(
      'INSERT INTO quick_reply_templates (id,guild_id,name,content,department_id,tags,enabled,revision,created_by,updated_by,created_at,updated_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,TRUE,1,$7,$7,NOW(),NOW()) RETURNING ' + QUICK_REPLY_COLUMNS,
      [randomUUID(), args.guildId, name, content, departmentId, tags, args.actorId],
    );
    const template = quickReplyFromRow(result.rows[0]);
    await insertQuickReplyRevision(client, template, args.actorId);
    return template;
  });
}

export async function listQuickReplies(
  guildId: string,
  options: { departmentIds?: readonly string[]; includeDisabled?: boolean } = {},
): Promise<QuickReplyTemplate[]> {
  const departmentIds = Array.from(new Set(options.departmentIds ?? ['*']));
  const result = await getPostgresPool().query<QuickReplyRow>(
    'SELECT ' + QUICK_REPLY_COLUMNS + ' FROM quick_reply_templates WHERE guild_id=$1 ' +
      (options.includeDisabled ? '' : 'AND enabled=TRUE ') +
      'AND (department_id=\'*\' OR department_id=ANY($2::text[])) ORDER BY lower(name) LIMIT 200',
    [guildId, departmentIds],
  );
  return result.rows.map(quickReplyFromRow);
}

export async function getQuickReply(guildId: string, id: string): Promise<QuickReplyTemplate | null> {
  const result = await getPostgresPool().query<QuickReplyRow>(
    'SELECT ' + QUICK_REPLY_COLUMNS + ' FROM quick_reply_templates WHERE guild_id=$1 AND id=$2 LIMIT 1',
    [guildId, id],
  );
  return result.rows[0] ? quickReplyFromRow(result.rows[0]) : null;
}

export async function updateQuickReply(args: {
  guildId: string;
  id: string;
  actorId: string;
  name?: string;
  content?: string;
  departmentId?: string;
  tags?: readonly string[];
  enabled?: boolean;
}): Promise<QuickReplyTemplate> {
  return inTransaction(async (client) => {
    const currentResult = await client.query<QuickReplyRow>(
      'SELECT ' + QUICK_REPLY_COLUMNS + ' FROM quick_reply_templates WHERE guild_id=$1 AND id=$2 FOR UPDATE',
      [args.guildId, args.id],
    );
    if (!currentResult.rows[0]) throw new Error('Quick reply was not found in this server.');
    const current = quickReplyFromRow(currentResult.rows[0]);
    const name = args.name === undefined ? current.name : args.name.trim();
    const content = args.content === undefined ? current.content : args.content.trim();
    const departmentId = args.departmentId === undefined ? current.departmentId : (args.departmentId.trim() || '*');
    const tags = args.tags === undefined ? current.tags : normalizeKnowledgeTags(args.tags);
    const enabled = args.enabled ?? current.enabled;
    if (!name || name.length > 80) throw new Error('Quick reply name must contain 1–80 characters.');
    validateQuickReplyTemplate(content);
    if (departmentId !== '*' && departmentId.length > 80) throw new Error('Department ID is invalid.');
    const result = await client.query<QuickReplyRow>(
      'UPDATE quick_reply_templates SET name=$3,content=$4,department_id=$5,tags=$6,enabled=$7,revision=revision+1,updated_by=$8,updated_at=NOW() WHERE guild_id=$1 AND id=$2 RETURNING ' + QUICK_REPLY_COLUMNS,
      [args.guildId, args.id, name, content, departmentId, tags, enabled, args.actorId],
    );
    const template = quickReplyFromRow(result.rows[0]);
    if (template.revision !== current.revision) await insertQuickReplyRevision(client, template, args.actorId);
    return template;
  });
}

export async function setQuickReplyEnabled(
  guildId: string,
  id: string,
  enabled: boolean,
  actorId: string,
): Promise<QuickReplyTemplate> {
  return inTransaction(async (client) => {
    const currentResult = await client.query<QuickReplyRow>(
      'SELECT ' + QUICK_REPLY_COLUMNS + ' FROM quick_reply_templates WHERE guild_id=$1 AND id=$2 FOR UPDATE',
      [guildId, id],
    );
    if (!currentResult.rows[0]) throw new Error('Quick reply was not found in this server.');
    const current = quickReplyFromRow(currentResult.rows[0]);
    if (current.enabled === enabled) return current;
    const result = await client.query<QuickReplyRow>(
      'UPDATE quick_reply_templates SET enabled=$3,revision=revision+1,updated_by=$4,updated_at=NOW() WHERE guild_id=$1 AND id=$2 RETURNING ' + QUICK_REPLY_COLUMNS,
      [guildId, id, enabled, actorId],
    );
    const template = quickReplyFromRow(result.rows[0]);
    await insertQuickReplyRevision(client, template, actorId);
    return template;
  });
}

export async function recordQuickReplyUsage(guildId: string, quickReplyId: string, actorId: string): Promise<void> {
  const result = await getPostgresPool().query(
    'INSERT INTO quick_reply_usage (id,guild_id,quick_reply_id,actor_id,used_at) ' +
      'SELECT $1,$2,id,$4,NOW() FROM quick_reply_templates WHERE guild_id=$2 AND id=$3 AND enabled=TRUE',
    [randomUUID(), guildId, quickReplyId, actorId],
  );
  if ((result.rowCount ?? 0) === 0) throw new Error('This quick reply is disabled or no longer exists.');
}

export async function getQuickReplyMetrics(guildId: string, from: string, to: string): Promise<Array<{ id: string; name: string; uses: number }>> {
  const result = await getPostgresPool().query<QueryResultRow & { id: string; name: string; uses: number | string }>(
    'SELECT template.id,template.name,COUNT(usage.id)::int AS uses FROM quick_reply_templates template ' +
      'LEFT JOIN quick_reply_usage usage ON usage.quick_reply_id=template.id AND usage.used_at >= $2::timestamptz AND usage.used_at < $3::timestamptz ' +
      'WHERE template.guild_id=$1 GROUP BY template.id,template.name ORDER BY uses DESC,lower(template.name) LIMIT 20',
    [guildId, from, to],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, uses: Number(row.uses) }));
}

export const QUICK_REPLY_SUPPORTED_PLACEHOLDERS: readonly QuickReplyPlaceholder[] = [
  'user', 'ticket_number', 'department', 'channel', 'guild',
];
export async function searchKnowledgeBase(args: {
  guildId: string;
  query: string;
  includeStaff?: boolean;
  limit?: number;
}): Promise<KnowledgeSearchResult[]> {
  const query = args.query.trim();
  const normalized = normalizeKnowledgeText(query);
  if (normalized.length < 2 || query.length > 120) {
    throw new Error('Search must contain 2–120 characters.');
  }
  const tokens = normalized.split(' ').filter(Boolean);
  const synonyms = await getKnowledgeSynonymExpansions(args.guildId, tokens);
  const expansions = Array.from(new Set([normalized, ...synonyms])).slice(0, 12);
  const expanded = expansions.map((term) => '"' + term.replace(/"/g, '') + '"').join(' OR ');
  const limit = Math.max(1, Math.min(10, Math.floor(args.limit ?? 5)));
  const visibilitySql = args.includeStaff ? '' : "AND visibility='public' ";
  const pool = getPostgresPool();

  const matched = await pool.query<ArticleRow>(
    'SELECT ' + ARTICLE_COLUMNS + ', ts_rank_cd(search_vector, websearch_to_tsquery(\'simple\'::regconfig,$2)) AS rank ' +
      'FROM knowledge_base_articles WHERE guild_id=$1 AND status=\'published\' ' + visibilitySql +
      'AND (search_vector @@ websearch_to_tsquery(\'simple\'::regconfig,$2) OR lower(title) LIKE lower($3) OR lower(category) LIKE lower($3) OR lower(array_to_string(tags, \' \')) LIKE lower($3)) ' +
      'ORDER BY CASE WHEN lower(title)=lower($2) THEN 0 WHEN lower(title) LIKE lower($3) THEN 1 ELSE 2 END, rank DESC, updated_at DESC LIMIT $4',
    [args.guildId, expanded, '%' + normalized.replace(/[%_\\]/g, '\\$&') + '%', limit],
  );

  let rows = matched.rows;
  let confidence: KnowledgeSearchResult['confidence'] = 'matched';
  let score = (row: ArticleRow): number => Number(row.rank ?? 0);

  if (!rows.length) {
    const candidates = await pool.query<ArticleRow>(
      'SELECT ' + ARTICLE_COLUMNS + ' FROM knowledge_base_articles WHERE guild_id=$1 AND status=\'published\' ' + visibilitySql +
        'ORDER BY updated_at DESC LIMIT 500',
      [args.guildId],
    );
    const ranked = candidates.rows.map((row) => ({
      row,
      score: fuzzyKnowledgeScore(normalized, {
        title: row.title,
        category: row.category,
        tags: Array.isArray(row.tags) ? row.tags : [],
        body: row.body,
      }),
    })).filter((entry) => entry.score >= 1.25)
      .sort((a, b) => b.score - a.score || Date.parse(String(b.row.updated_at)) - Date.parse(String(a.row.updated_at)))
      .slice(0, limit);
    rows = ranked.map((entry) => ({ ...entry.row, rank: entry.score }));
    confidence = 'suggestion';
    score = (row: ArticleRow): number => Number(row.rank ?? 0);
  }

  const results = rows.map((row) => ({ article: articleFromRow(row), score: score(row), confidence }));
  await Promise.all(results.map((result) => recordKnowledgeUsage(args.guildId, result.article.id, 'search_result').catch(() => undefined)));
  return results;
}
