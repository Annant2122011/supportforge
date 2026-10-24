import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildKnowledgeSearchExpression,
  expandKnowledgeQueries,
  isKnowledgeShareableConfidence,
  normalizeKnowledgeText,
  scoreKnowledgeCandidate,
  shouldOfferKnowledgeResult,
} from '../src/core/domain/knowledgeSearch';

test('knowledge search normalization is Unicode-aware and stable', () => {
  assert.equal(normalizeKnowledgeText('  REFUNDS—Policy!! '), 'refunds policy');
  assert.equal(normalizeKnowledgeText('HINDI भुगतान'), 'hindi भुगतान');
});

test('exact title and tags outrank weaker title/summary similarity', () => {
  const exact = scoreKnowledgeCandidate('refund policy', {
    title: 'Refund Policy',
    summary: 'How refunds work',
    category: 'Billing',
    tags: ['refund', 'money'],
  });
  const weaker = scoreKnowledgeCandidate('refund policy', {
    title: 'Account questions',
    summary: 'Refunds may be available under some circumstances',
    category: 'General',
    tags: ['account'],
  });
  assert.equal(exact.score, 1);
  assert.ok(exact.score > weaker.score);
  assert.equal(exact.confidence, 'high');
});

test('typo-tolerant fallback returns ranked medium-confidence candidates without hiding low confidence', () => {
  const result = scoreKnowledgeCandidate('refud policy', {
    title: 'Refund Policy',
    summary: 'Eligibility and processing times',
    category: 'Billing',
    tags: ['refunds'],
  });
  assert.ok(result.score > 0.38);
  assert.equal(shouldOfferKnowledgeResult(result), true);
  const unrelated = scoreKnowledgeCandidate('space elevator', {
    title: 'Refund Policy',
    summary: 'Billing account help',
    category: 'Billing',
    tags: ['payments'],
  });
  assert.equal(shouldOfferKnowledgeResult(unrelated), false);
});

test('empty query does not create false-positive matches', () => {
  const score = scoreKnowledgeCandidate('   ', {
    title: 'Help',
    summary: 'Support article',
    category: 'General',
    tags: ['help'],
  });
  assert.equal(score.score, 0);
  assert.equal(shouldOfferKnowledgeResult(score), false);
});


test('knowledge search expands whole-term and phrase synonyms as independent alternatives', () => {
  const variants = expandKnowledgeQueries('refund policy', [
    { normalizedTerm: 'refund', synonyms: ['return', 'money back'] },
    { normalizedTerm: 'refund policy', synonyms: ['refund rules'] },
    { normalizedTerm: 'fund', synonyms: ['investment'] },
  ]);
  assert.deepEqual(variants, [
    'refund policy',
    'return policy',
    'money back policy',
    'refund rules',
  ]);
  const expression = buildKnowledgeSearchExpression(variants);
  assert.match(expression, /\(refund policy\) OR \(return policy\)/);
  assert.ok(!expression.includes('investment'));
  assert.ok(!expression.includes('money back policy refund rules'), 'synonyms must not become one mandatory AND query');
});

test('only medium and high confidence Knowledge Base results receive direct-share controls', () => {
  assert.equal(isKnowledgeShareableConfidence('high'), true);
  assert.equal(isKnowledgeShareableConfidence('medium'), true);
  assert.equal(isKnowledgeShareableConfidence('low'), false);
});


test('knowledge search finds exact terms inside long article bodies, including non-English tokens', () => {
  const bodyTokens = new Set(normalizeKnowledgeText('The customer must submit a chargeback evidence packet. बंगाली সহায়তা ফেরত নীতি').split(' ').filter((token) => token.length > 1));
  const result = scoreKnowledgeCandidate('chargeback evidence', {
    title: 'Account support', summary: 'General account help', category: 'General', tags: ['account'], bodyTokens,
  });
  assert.ok(result.score >= 0.5, 'a complete body-token match should be offered');
  assert.equal(shouldOfferKnowledgeResult(result), true);
  const nonEnglish = scoreKnowledgeCandidate('সহায়তা ফেরত', {
    title: 'Account support', summary: 'General account help', category: 'General', tags: ['account'], bodyTokens,
  });
  assert.ok(nonEnglish.score >= 0.5, 'Unicode body tokens should be searchable without English stemming');
  assert.equal(shouldOfferKnowledgeResult(nonEnglish), true);
});
