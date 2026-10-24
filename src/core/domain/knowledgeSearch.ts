export type KnowledgeConfidence = 'high' | 'medium' | 'low';

export interface KnowledgeSearchCandidate {
  title: string;
  summary: string;
  category: string;
  tags: readonly string[];
}

export interface KnowledgeSearchScore {
  score: number;
  confidence: KnowledgeConfidence;
}

export function normalizeKnowledgeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(value: string): string[] {
  return normalizeKnowledgeText(value).split(' ').filter((token) => token.length > 1).slice(0, 12);
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function wordSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const largest = Math.max(left.length, right.length);
  if (largest > 32) return 0;
  return Math.max(0, 1 - editDistance(left, right) / largest);
}

function tokenCoverage(queryTokens: readonly string[], target: string): number {
  const targetTokens = tokens(target);
  if (!queryTokens.length || !targetTokens.length) return 0;
  const matchScores = queryTokens.map((queryToken) =>
    Math.max(0, ...targetTokens.map((targetToken) => wordSimilarity(queryToken, targetToken))),
  );
  return matchScores.reduce((sum, score) => sum + score, 0) / matchScores.length;
}

/**
 * Deterministic typo-tolerant fallback score. Full-text ranking remains primary;
 * this score only ranks candidates from the published, permission-filtered catalog.
 */
export function scoreKnowledgeCandidate(
  query: string,
  candidate: KnowledgeSearchCandidate,
): KnowledgeSearchScore {
  const normalizedQuery = normalizeKnowledgeText(query);
  const normalizedTitle = normalizeKnowledgeText(candidate.title);
  const normalizedSummary = normalizeKnowledgeText(candidate.summary);
  const normalizedCategory = normalizeKnowledgeText(candidate.category);
  const normalizedTags = normalizeKnowledgeText(candidate.tags.join(' '));
  if (!normalizedQuery) return { score: 0, confidence: 'low' };
  if (normalizedQuery === normalizedTitle) return { score: 1, confidence: 'high' };

  const titlePhraseMatch = normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle);
  const queryTokens = tokens(normalizedQuery);
  const titleScore = titlePhraseMatch ? 0.96 : tokenCoverage(queryTokens, normalizedTitle);
  const tagScore = tokenCoverage(queryTokens, normalizedTags);
  const categoryScore = tokenCoverage(queryTokens, normalizedCategory);
  const summaryScore = tokenCoverage(queryTokens, normalizedSummary);

  let score = (titleScore * 0.58) + (tagScore * 0.21) + (categoryScore * 0.13) + (summaryScore * 0.08);
  if (normalizedTags === normalizedQuery || normalizedCategory === normalizedQuery) score = Math.max(score, 0.88);
  score = Math.max(0, Math.min(1, Number(score.toFixed(4))));
  const confidence: KnowledgeConfidence = score >= 0.72 ? 'high' : score >= 0.48 ? 'medium' : 'low';
  return { score, confidence };
}

export function shouldOfferKnowledgeResult(score: KnowledgeSearchScore): boolean {
  return score.score >= 0.38;
}


/** Expand into independent search alternatives; never turn synonyms into a giant AND query. */
export function expandKnowledgeQueries(
  query: string,
  mappings: readonly { normalizedTerm: string; synonyms: readonly string[] }[],
  maximumVariants = 25,
): string[] {
  const normalizedQuery = normalizeKnowledgeText(query);
  if (!normalizedQuery) return [];
  const variants = new Set<string>([normalizedQuery]);
  const boundedMaximum = Math.max(1, Math.min(50, Math.floor(maximumVariants)));
  const paddedQuery = ' ' + normalizedQuery + ' ';

  for (const mapping of mappings) {
    if (variants.size >= boundedMaximum) break;
    const term = normalizeKnowledgeText(mapping.normalizedTerm);
    if (!term || !paddedQuery.includes(' ' + term + ' ')) continue;

    for (const synonymInput of mapping.synonyms) {
      const synonym = normalizeKnowledgeText(synonymInput);
      if (!synonym || synonym === term) continue;
      const next = (' ' + normalizedQuery + ' ').split(' ' + term + ' ').join(' ' + synonym + ' ').trim();
      if (next && next !== normalizedQuery) variants.add(next);
      if (variants.size >= boundedMaximum) break;
    }
  }
  return [...variants];
}

/** Postgres websearch_to_tsquery interprets each variant as its own OR branch. */
export function buildKnowledgeSearchExpression(variants: readonly string[]): string {
  return variants
    .map((variant) => normalizeKnowledgeText(variant))
    .filter(Boolean)
    .slice(0, 50)
    .map((variant) => '(' + variant + ')')
    .join(' OR ')
    .slice(0, 1000);
}

/** Kept as a convenience for callers that need a safe search expression. */
export function expandKnowledgeQuery(
  query: string,
  mappings: readonly { normalizedTerm: string; synonyms: readonly string[] }[],
): string {
  return buildKnowledgeSearchExpression(expandKnowledgeQueries(query, mappings));
}

export function isKnowledgeShareableConfidence(confidence: KnowledgeConfidence): boolean {
  return confidence === 'high' || confidence === 'medium';
}
