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


/** Expand only complete canonical terms or phrases configured for this server. */
export function expandKnowledgeQuery(
  query: string,
  mappings: readonly { normalizedTerm: string; synonyms: readonly string[] }[],
): string {
  const normalizedQuery = normalizeKnowledgeText(query);
  if (!normalizedQuery) return '';
  const queryTokens = new Set(normalizedQuery.split(' ').filter(Boolean));
  const paddedQuery = ' ' + normalizedQuery + ' ';
  const matchedSynonyms = mappings
    .filter((mapping) => {
      const term = normalizeKnowledgeText(mapping.normalizedTerm);
      return Boolean(term) && (queryTokens.has(term) || paddedQuery.includes(' ' + term + ' '));
    })
    .flatMap((mapping) => mapping.synonyms.map((synonym) => normalizeKnowledgeText(synonym)).filter(Boolean));
  return [...new Set([query.trim(), ...matchedSynonyms].filter(Boolean))].join(' ').slice(0, 500);
}

export function isKnowledgeShareableConfidence(confidence: KnowledgeConfidence): boolean {
  return confidence === 'high' || confidence === 'medium';
}
