import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import { getPostgresPool } from '../core/persistence/postgresDatabase';
import { buildKnowledgeSearchExpression, expandKnowledgeQueries, normalizeKnowledgeText, scoreKnowledgeCandidate, shouldOfferKnowledgeResult, type KnowledgeConfidence } from '../core/domain/knowledgeSearch';

export type KnowledgeArticleStatus = 'draft' | 'published' | 'archived';
export type KnowledgeVisibility = 'public' | 'staff';

export interface KnowledgeAccess {
  isAdmin: boolean;
  isStaff: boolean;
  roleIds: string[];
}

export interface KnowledgeArticleInput {
  title: string;
  summary?: string;
  body: string;
  category?: string;
  tags?: string[];
  visibility?: KnowledgeVisibility;
  allowedRoleIds?: string[];
}

export interface KnowledgeBaseArticle {
  id: string;
  guildId: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: string;
  tags: string[];
  status: KnowledgeArticleStatus;
  visibility: KnowledgeVisibility;
  allowedRoleIds: string[];
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  archivedAt: string | null;
}

export interface KnowledgeSearchResult {
  id: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  revision: number;
  score: number;
  confidence: KnowledgeConfidence;
  updatedAt: string;
}

export interface KnowledgeBaseMetrics {
  publishedArticles: number;
  draftArticles: number;
  archivedArticles: number;
  searchResultEvents: number;
  articleViews: number;
  articleShares: number;
  helpfulVotes: number;
  unhelpfulVotes: number;
}

interface KnowledgeArticleRow extends QueryResultRow {
  id: string;
  guild_id: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: string;
  tags: string[] | null;
  status: KnowledgeArticleStatus;
  visibility: KnowledgeVisibility;
  allowed_role_ids: string[] | null;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  published_at: Date | string | null;
  archived_at: Date | string | null;
  search_rank?: number | string;
}

const ARTICLE_COLUMNS = 'id,guild_id,slug,title,summary,body,category,tags,status,visibility,allowed_role_ids,' +
  'revision,created_by,updated_by,created_at,updated_at,published_at,archived_at';

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function fromRow(row: KnowledgeArticleRow): KnowledgeBaseArticle {
  return {
    id: row.id,
    guildId: row.guild_id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body: row.body,
    category: row.category,
    tags: Array.isArray(row.tags) ? row.tags : [],
    status: row.status,
    visibility: row.visibility,
    allowedRoleIds: Array.isArray(row.allowed_role_ids) ? row.allowed_role_ids : [],
    revision: Number(row.revision),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    publishedAt: iso(row.published_at),
    archivedAt: iso(row.archived_at),
  };
}

function normalizedTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) throw new Error('Tags must be a list of text values.');
  const output = [...new Set(tags.map((tag) => {
    if (typeof tag !== 'string') throw new Error('Every tag must be text.');
    const value = tag.trim().replace(/\s+/g, ' ').slice(0, 32);
    if (!value) throw new Error('Tags cannot be empty.');
    return value;
  }))];
  if (output.length > 12) throw new Error('An article can have at most 12 tags.');
  return output;
}

function normalizedRoleIds(roleIds: unknown): string[] {
  if (!Array.isArray(roleIds)) throw new Error('Allowed role IDs must be a list.');
  const normalized = [...new Set(roleIds.map((id) => {
    if (typeof id !== 'string' || !/^\d{17,20}$/.test(id.trim())) {
      throw new Error('Every allowed role must be a valid Discord role ID.');
    }
    return id.trim();
  }))];
  if (normalized.length > 20) throw new Error('An article can require at most 20 roles.');
  return normalized;
}

function normalizeArticleInput(input: KnowledgeArticleInput): KnowledgeArticleInput {
  const title = input.title.trim().replace(/\s+/g, ' ');
  const summary = (input.summary ?? '').trim();
  const body = input.body.trim();
  const category = (input.category ?? 'General').trim().replace(/\s+/g, ' ') || 'General';
  const visibility = input.visibility ?? 'public';
  if (title.length < 3 || title.length > 160) throw new Error('Article titles must be 3–160 characters.');
  if (summary.length > 500) throw new Error('Article summaries must be 500 characters or fewer.');
  if (!body || body.length > 20_000) throw new Error('Article body must contain 1–20,000 characters.');
  if (category.length > 80) throw new Error('Article category must be 80 characters or fewer.');
  if (visibility !== 'public' && visibility !== 'staff') throw new Error('Visibility must be public or staff.');
  return {
    title,
    summary,
    body,
    category,
    tags: normalizedTags(input.tags ?? []),
    visibility,
    allowedRoleIds: normalizedRoleIds(input.allowedRoleIds ?? []),
  };
}

function slugFor(title: string): string {
  const slug = normalizeKnowledgeText(title).replace(/\s+/g, '-').slice(0, 80).replace(/^-+|-+$/g, '');
  return slug || 'article-' + randomUUID().slice(0, 8);
}

function canRead(article: KnowledgeBaseArticle, access: KnowledgeAccess): boolean {
  if (access.isAdmin) return true;
  if (article.status !== 'published') return false;
  if (article.visibility === 'staff' && !access.isStaff) return false;
  if (article.allowedRoleIds.length > 0 && !article.allowedRoleIds.some((roleId) => access.roleIds.includes(roleId))) return false;
  return true;
}

async function addRevision(
  executor: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  article: KnowledgeBaseArticle,
  actorId: string,
): Promise<void> {
  await executor.query(
    'INSERT INTO knowledge_base_article_revisions ' +
      '(id,guild_id,article_id,revision,title,summary,body,category,tags,status,visibility,allowed_role_ids,changed_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [randomUUID(), article.guildId, article.id, article.revision, article.title, article.summary, article.body,
      article.category, article.tags, article.status, article.visibility, article.allowedRoleIds, actorId],
  );
}

export async function createKnowledgeArticle(
  guildId: string,
  actorId: string,
  source: KnowledgeArticleInput,
): Promise<KnowledgeBaseArticle> {
  const input = normalizeArticleInput(source);
  const pool = getPostgresPool();
  const client = await pool.connect();
  const id = randomUUID();
  const slug = slugFor(input.title!);
  try {
    await client.query('BEGIN');
    const result = await client.query<KnowledgeArticleRow>(
      'INSERT INTO knowledge_base_articles ' +
        '(id,guild_id,slug,title,summary,body,category,tags,status,visibility,allowed_role_ids,revision,created_by,updated_by) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,\'draft\',$9,$10,1,$11,$11) RETURNING ' + ARTICLE_COLUMNS,
      [id,guildId,slug,input.title,input.summary,input.body,input.category,input.tags,input.visibility,input.allowedRoleIds,actorId],
    );
    const article = fromRow(result.rows[0]);
    await client.query(
      'INSERT INTO knowledge_base_article_revisions ' +
        '(id,guild_id,article_id,revision,title,summary,body,category,tags,status,visibility,allowed_role_ids,changed_by) ' +
        'VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [randomUUID(),guildId,id,article.title,article.summary,article.body,article.category,article.tags,article.status,article.visibility,article.allowedRoleIds,actorId],
    );
    await client.query('COMMIT');
    return article;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505') {
      throw new Error('An article with a conflicting slug already exists. Adjust its title and retry.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listKnowledgeArticles(
  guildId: string,
  access: KnowledgeAccess,
  limit = 25,
): Promise<KnowledgeBaseArticle[]> {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const rows = await getPostgresPool().query<KnowledgeArticleRow>(
    'SELECT ' + ARTICLE_COLUMNS + ' FROM knowledge_base_articles WHERE guild_id=$1 ' +
      'AND ($2::boolean OR (status=\'published\' AND (visibility=\'public\' OR $3::boolean) ' +
      'AND (cardinality(allowed_role_ids)=0 OR allowed_role_ids && $4::text[] OR $2::boolean))) ' +
      'ORDER BY CASE status WHEN \'published\' THEN 0 WHEN \'draft\' THEN 1 ELSE 2 END,updated_at DESC LIMIT $5',
    [guildId, access.isAdmin, access.isStaff, access.roleIds, safeLimit],
  );
  return rows.rows.map(fromRow).filter((article) => canRead(article, access));
}

export async function getKnowledgeArticle(
  guildId: string,
  articleId: string,
  access: KnowledgeAccess,
  recordView = false,
  actorId: string | null = null,
): Promise<KnowledgeBaseArticle | null> {
  const result = await getPostgresPool().query<KnowledgeArticleRow>(
    'SELECT ' + ARTICLE_COLUMNS + ' FROM knowledge_base_articles WHERE guild_id=$1 AND id=$2 LIMIT 1',
    [guildId, articleId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const article = fromRow(row);
  if (!canRead(article, access)) return null;
  if (recordView && article.status === 'published') {
    await recordKnowledgeUsage(guildId, article.id, actorId, 'view');
  }
  return article;
}

async function recordKnowledgeUsage(
  guildId: string,
  articleId: string,
  actorId: string | null,
  eventType: 'search_result' | 'view' | 'shared',
): Promise<void> {
  try {
    await getPostgresPool().query(
      'INSERT INTO knowledge_base_usage (id,guild_id,article_id,actor_id,event_type) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(),guildId,articleId,actorId,eventType],
    );
  } catch {
    // Usage is telemetry, not part of the customer's search/view/share contract.
    // Never log query text, article body, IDs, connection details or raw DB errors.
    console.warn('Knowledge Base usage telemetry write failed; the primary action continues.');
  }
}

export async function updateKnowledgeArticle(
  guildId: string,
  articleId: string,
  expectedRevision: number,
  actorId: string,
  changes: Partial<KnowledgeArticleInput>,
): Promise<KnowledgeBaseArticle> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('Expected revision must be a positive integer.');
  const pool = getPostgresPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingResult = await client.query<KnowledgeArticleRow>(
      'SELECT ' + ARTICLE_COLUMNS + ' FROM knowledge_base_articles WHERE guild_id=$1 AND id=$2 FOR UPDATE',
      [guildId,articleId],
    );
    const existing = existingResult.rows[0];
    if (!existing) throw new Error('Knowledge Base article not found in this server.');
    if (Number(existing.revision) !== expectedRevision) {
      throw new Error('This article changed since it was opened. Refresh its current revision before saving.');
    }
    if (existing.status === 'archived') throw new Error('Archived articles are read-only to preserve revision history.');
    const current = fromRow(existing);
    const input = normalizeArticleInput({
      title: changes.title ?? current.title,
      summary: changes.summary ?? current.summary,
      body: changes.body ?? current.body,
      category: changes.category ?? current.category,
      tags: changes.tags ?? current.tags,
      visibility: changes.visibility ?? current.visibility,
      allowedRoleIds: changes.allowedRoleIds ?? current.allowedRoleIds,
    });
    const updatedResult = await client.query<KnowledgeArticleRow>(
      'UPDATE knowledge_base_articles SET title=$3,summary=$4,body=$5,category=$6,tags=$7,visibility=$8,allowed_role_ids=$9,' +
        'revision=revision+1,updated_by=$10,updated_at=NOW() WHERE guild_id=$1 AND id=$2 AND revision=$11 RETURNING ' + ARTICLE_COLUMNS,
      [guildId,articleId,input.title,input.summary,input.body,input.category,input.tags,input.visibility,input.allowedRoleIds,actorId,expectedRevision],
    );
    if (!updatedResult.rows[0]) throw new Error('This article changed during the save. Refresh and retry.');
    const updated = fromRow(updatedResult.rows[0]);
    await client.query(
      'INSERT INTO knowledge_base_article_revisions ' +
        '(id,guild_id,article_id,revision,title,summary,body,category,tags,status,visibility,allowed_role_ids,changed_by) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [randomUUID(),guildId,articleId,updated.revision,updated.title,updated.summary,updated.body,updated.category,updated.tags,updated.status,updated.visibility,updated.allowedRoleIds,actorId],
    );
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function setKnowledgeArticleStatus(
  guildId: string,
  articleId: string,
  expectedRevision: number,
  actorId: string,
  status: 'published' | 'archived',
): Promise<KnowledgeBaseArticle> {
  const pool = getPostgresPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<KnowledgeArticleRow>(
      'SELECT ' + ARTICLE_COLUMNS + ' FROM knowledge_base_articles WHERE guild_id=$1 AND id=$2 FOR UPDATE',
      [guildId,articleId],
    );
    const currentRow = result.rows[0];
    if (!currentRow) throw new Error('Knowledge Base article not found in this server.');
    if (Number(currentRow.revision) !== expectedRevision) throw new Error('This article has a stale revision. Refresh before changing its publication status.');
    const current = fromRow(currentRow);
    if (current.status === 'archived') throw new Error('Archived articles cannot be republished; create a new article instead.');
    if (current.status === status) throw new Error('Article is already ' + status + '.');
    const updatedResult = await client.query<KnowledgeArticleRow>(
      'UPDATE knowledge_base_articles SET status=$3,revision=revision+1,updated_by=$4,updated_at=NOW(),' +
        'published_at=CASE WHEN $3=\'published\' THEN COALESCE(published_at,NOW()) ELSE published_at END,' +
        'archived_at=CASE WHEN $3=\'archived\' THEN NOW() ELSE archived_at END ' +
        'WHERE guild_id=$1 AND id=$2 AND revision=$5 RETURNING ' + ARTICLE_COLUMNS,
      [guildId,articleId,status,actorId,expectedRevision],
    );
    if (!updatedResult.rows[0]) throw new Error('Article changed during publication. Refresh and retry.');
    const updated = fromRow(updatedResult.rows[0]);
    await client.query(
      'INSERT INTO knowledge_base_article_revisions ' +
        '(id,guild_id,article_id,revision,title,summary,body,category,tags,status,visibility,allowed_role_ids,changed_by) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [randomUUID(),guildId,articleId,updated.revision,updated.title,updated.summary,updated.body,updated.category,updated.tags,updated.status,updated.visibility,updated.allowedRoleIds,actorId],
    );
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listKnowledgeArticleRevisions(
  guildId: string,
  articleId: string,
  access: KnowledgeAccess,
): Promise<Array<{ revision: number; title: string; status: KnowledgeArticleStatus; changedBy: string; createdAt: string }>> {
  const article = await getKnowledgeArticle(guildId, articleId, access);
  if (!article) throw new Error('Knowledge Base article not found or you do not have permission to view it.');
  if (!access.isAdmin) throw new Error('Only administrators can inspect revision history.');
  const result = await getPostgresPool().query<QueryResultRow & {
    revision: number; title: string; status: KnowledgeArticleStatus; changed_by: string; created_at: Date | string;
  }>(
    'SELECT revision,title,status,changed_by,created_at FROM knowledge_base_article_revisions WHERE guild_id=$1 AND article_id=$2 ORDER BY revision DESC LIMIT 50',
    [guildId,articleId],
  );
  return result.rows.map((row) => ({
    revision: Number(row.revision),
    title: row.title,
    status: row.status,
    changedBy: row.changed_by,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  }));
}

export async function restoreKnowledgeArticleRevision(
  guildId: string,
  articleId: string,
  targetRevision: number,
  expectedCurrentRevision: number,
  actorId: string,
): Promise<KnowledgeBaseArticle> {
  const revision = await getPostgresPool().query<QueryResultRow & {
    title: string; summary: string; body: string; category: string; tags: string[];
    visibility: KnowledgeVisibility; allowed_role_ids: string[];
  }>(
    'SELECT title,summary,body,category,tags,visibility,allowed_role_ids FROM knowledge_base_article_revisions ' +
      'WHERE guild_id=$1 AND article_id=$2 AND revision=$3 LIMIT 1',
    [guildId,articleId,targetRevision],
  );
  if (!revision.rows[0]) throw new Error('Requested article revision was not found.');
  return updateKnowledgeArticle(guildId,articleId,expectedCurrentRevision,actorId,{
    title:revision.rows[0].title,summary:revision.rows[0].summary,body:revision.rows[0].body,category:revision.rows[0].category,
    tags:revision.rows[0].tags,visibility:revision.rows[0].visibility,allowedRoleIds:revision.rows[0].allowed_role_ids,
  });
}

export async function setKnowledgeSynonyms(
  guildId: string,
  actorId: string,
  term: string,
  synonyms: string[],
): Promise<void> {
  const normalizedTerm = normalizeKnowledgeText(term);
  if (!normalizedTerm || normalizedTerm.length > 80) throw new Error('Synonym term must be 1–80 characters.');
  const normalizedSynonyms = [...new Set(synonyms.map((item) => normalizeKnowledgeText(item)).filter(Boolean))]
    .filter((item) => item !== normalizedTerm);
  if (normalizedSynonyms.length > 20 || normalizedSynonyms.some((item) => item.length > 80)) {
    throw new Error('Enter at most 20 synonyms, each no longer than 80 characters.');
  }
  await getPostgresPool().query(
    'INSERT INTO knowledge_base_synonyms (guild_id,term,normalized_term,synonyms,updated_by,updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (guild_id,normalized_term) DO UPDATE SET ' +
      'term=EXCLUDED.term,synonyms=EXCLUDED.synonyms,updated_by=EXCLUDED.updated_by,updated_at=NOW()',
    [guildId,term.trim(),normalizedTerm,normalizedSynonyms,actorId],
  );
}

export async function listKnowledgeSynonyms(guildId: string): Promise<Array<{ term: string; synonyms: string[] }>> {
  const result = await getPostgresPool().query<QueryResultRow & { term: string; synonyms: string[] }>(
    'SELECT term,synonyms FROM knowledge_base_synonyms WHERE guild_id=$1 ORDER BY normalized_term LIMIT 100',
    [guildId],
  );
  return result.rows.map((row) => ({ term: row.term, synonyms: Array.isArray(row.synonyms) ? row.synonyms : [] }));
}

export async function deleteKnowledgeSynonyms(guildId: string, term: string): Promise<boolean> {
  const result = await getPostgresPool().query(
    'DELETE FROM knowledge_base_synonyms WHERE guild_id=$1 AND normalized_term=$2',
    [guildId,normalizeKnowledgeText(term)],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function searchKnowledgeBase(
  guildId: string,
  query: string,
  access: KnowledgeAccess,
  actorId: string | null,
): Promise<KnowledgeSearchResult[]> {
  const normalizedQuery = normalizeKnowledgeText(query);
  if (normalizedQuery.length < 2 || normalizedQuery.length > 200) {
    throw new Error('Search must be between 2 and 200 characters.');
  }
  const pool = getPostgresPool();
  const synonymResult = await pool.query<QueryResultRow & { normalized_term: string; synonyms: string[] }>(
    'SELECT normalized_term,synonyms FROM knowledge_base_synonyms WHERE guild_id=$1 ORDER BY normalized_term LIMIT 100',
    [guildId],
  );
  const expandedQueries = expandKnowledgeQueries(query, synonymResult.rows.map((row) => ({
    normalizedTerm: row.normalized_term,
    synonyms: Array.isArray(row.synonyms) ? row.synonyms : [],
  })));
  const searchExpression = buildKnowledgeSearchExpression(expandedQueries);
  const permissionPredicate = 'guild_id=$1 AND status=\'published\' AND ' +
    '(visibility=\'public\' OR $3::boolean OR $4::boolean) AND ' +
    '(cardinality(allowed_role_ids)=0 OR allowed_role_ids && $5::text[] OR $3::boolean)';
  const fts = await pool.query<KnowledgeArticleRow>(
    'SELECT ' + ARTICLE_COLUMNS + ',ts_rank_cd(search_vector,websearch_to_tsquery(\'english\'::regconfig,$2)) AS search_rank ' +
      'FROM knowledge_base_articles WHERE ' + permissionPredicate + ' AND search_vector @@ websearch_to_tsquery(\'english\'::regconfig,$2) ' +
      'ORDER BY search_rank DESC,updated_at DESC LIMIT 50',
    [guildId, searchExpression, access.isAdmin, access.isStaff, access.roleIds],
  );
  const metadataCandidates = await pool.query<KnowledgeArticleRow>(
    'SELECT ' + ARTICLE_COLUMNS + ' FROM knowledge_base_articles WHERE ' + permissionPredicate +
      ' AND $2::text IS NOT NULL ORDER BY updated_at DESC LIMIT 500',
    [guildId, searchExpression, access.isAdmin, access.isStaff, access.roleIds],
  );
  const articleMap = new Map<string, { row: KnowledgeArticleRow; score: number }>();
  for (const row of metadataCandidates.rows) {
    const article = fromRow(row);
    if (!canRead(article, access)) continue;
    const candidate = {
      title: article.title,
      summary: article.summary,
      category: article.category,
      tags: article.tags,
      bodyTokens: new Set(normalizeKnowledgeText(article.body).split(' ').filter((token) => token.length > 1)),
    };
    const score = Math.max(
      0,
      ...expandedQueries.map((variant) => scoreKnowledgeCandidate(variant, candidate).score),
    );
    const confidence: KnowledgeConfidence = score >= 0.72 ? 'high' : score >= 0.48 ? 'medium' : 'low';
    if (shouldOfferKnowledgeResult({ score, confidence })) {
      articleMap.set(article.id, { row, score });
    }
  }
  for (const row of fts.rows) {
    const article = fromRow(row);
    if (!canRead(article, access)) continue;
    const rawRank = Number(row.search_rank ?? 0);
    const ftsScore = Math.min(0.99,0.48 + Math.max(0,rawRank) * 2.5);
    const existing = articleMap.get(article.id);
    articleMap.set(article.id,{row,score:Math.max(existing?.score ?? 0,ftsScore)});
  }
  const results = [...articleMap.values()]
    .map(({row,score}) => ({
      id:row.id,title:row.title,summary:row.summary,category:row.category,
      tags:Array.isArray(row.tags)?row.tags:[],revision:Number(row.revision),score:Number(score.toFixed(3)),
      confidence:score>=0.72?'high' as const:score>=0.48?'medium' as const:'low' as const,
      updatedAt:iso(row.updated_at)??new Date(0).toISOString(),
    }))
    .sort((a,b)=>b.score-a.score || Date.parse(b.updatedAt)-Date.parse(a.updatedAt))
    .slice(0,5);
  await Promise.all(results.map((article) => recordKnowledgeUsage(guildId,article.id,actorId,'search_result')));
  return results;
}

export async function recordKnowledgeArticleShare(
  guildId: string,
  articleId: string,
  access: KnowledgeAccess,
  actorId: string,
): Promise<void> {
  const article = await getKnowledgeArticle(guildId, articleId, access);
  if (!article || article.status !== 'published') {
    throw new Error('Published article not found.');
  }
  await recordKnowledgeUsage(guildId, article.id, actorId, 'shared');
}

export async function recordKnowledgeArticleFeedback(
  guildId: string,
  articleId: string,
  userId: string,
  access: KnowledgeAccess,
  helpful: boolean,
): Promise<void> {
  const article = await getKnowledgeArticle(guildId,articleId,access);
  if (!article || article.status !== 'published') throw new Error('Published article not found or you do not have permission to rate it.');
  try {
    await getPostgresPool().query(
      'INSERT INTO knowledge_base_article_feedback (id,guild_id,article_id,user_id,helpful) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(),guildId,articleId,userId,helpful],
    );
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505') {
      throw new Error('You have already rated this article. Repeated votes are disabled.');
    }
    throw error;
  }
}

export async function getKnowledgeBaseMetrics(guildId: string, days: number): Promise<KnowledgeBaseMetrics> {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('Knowledge metrics window must be 1–366 days.');
  const pool = getPostgresPool();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const [articles, usage, feedback] = await Promise.all([
    pool.query<QueryResultRow & { published: number|string; drafts: number|string; archived: number|string }>(
      'SELECT COUNT(*) FILTER (WHERE status=\'published\')::int AS published,' +
        'COUNT(*) FILTER (WHERE status=\'draft\')::int AS drafts,' +
        'COUNT(*) FILTER (WHERE status=\'archived\')::int AS archived FROM knowledge_base_articles WHERE guild_id=$1',
      [guildId],
    ),
    pool.query<QueryResultRow & { search_result: number|string; view: number|string; shared: number|string }>(
      'SELECT COUNT(*) FILTER (WHERE event_type=\'search_result\')::int AS search_result,' +
        'COUNT(*) FILTER (WHERE event_type=\'view\')::int AS view,' +
        'COUNT(*) FILTER (WHERE event_type=\'shared\')::int AS shared ' +
        'FROM knowledge_base_usage WHERE guild_id=$1 AND created_at >= $2::timestamptz',
      [guildId,from],
    ),
    pool.query<QueryResultRow & { helpful: number|string; unhelpful: number|string }>(
      'SELECT COUNT(*) FILTER (WHERE helpful=TRUE)::int AS helpful,' +
        'COUNT(*) FILTER (WHERE helpful=FALSE)::int AS unhelpful FROM knowledge_base_article_feedback ' +
        'WHERE guild_id=$1 AND created_at >= $2::timestamptz',
      [guildId,from],
    ),
  ]);
  return {
    publishedArticles:Number(articles.rows[0]?.published??0),draftArticles:Number(articles.rows[0]?.drafts??0),
    archivedArticles:Number(articles.rows[0]?.archived??0),searchResultEvents:Number(usage.rows[0]?.search_result??0),
    articleViews:Number(usage.rows[0]?.view??0),articleShares:Number(usage.rows[0]?.shared??0),
    helpfulVotes:Number(feedback.rows[0]?.helpful??0),unhelpfulVotes:Number(feedback.rows[0]?.unhelpful??0),
  };
}
