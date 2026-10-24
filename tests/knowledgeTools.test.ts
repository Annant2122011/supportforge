import assert from 'node:assert/strict';
import test from 'node:test';

import {
  editDistance,
  fuzzyKnowledgeScore,
  normalizeKnowledgeTags,
  normalizeKnowledgeText,
  renderQuickReplyTemplate,
  slugifyKnowledgeTitle,
  validateQuickReplyTemplate,
} from '../src/core/domain/knowledgeTools';

test('knowledge normalization is Unicode-aware, stable, and trims punctuation', () => {
  assert.equal(normalizeKnowledgeText('  Refund—POLICY!  '), 'refund policy');
  assert.equal(slugifyKnowledgeTitle('Refund / Payment Policy'), 'refund-payment-policy');
  assert.deepEqual(normalizeKnowledgeTags([' Billing ', 'billing', 'Refunds', '', 'Refunds']), ['Billing', 'Refunds']);
});

test('bounded edit distance and fuzzy ranking catch common title typos', () => {
  assert.equal(editDistance('refund', 'refnud', 2), 2);
  assert.equal(editDistance('refund', 'unrelated', 2), 3);
  assert.ok(fuzzyKnowledgeScore('refnud policy', {
    title: 'Refund Policy',
    category: 'Payments',
    tags: ['billing', 'refund'],
    body: 'How a customer can request a refund.',
  }) > 0);
  assert.equal(fuzzyKnowledgeScore('x', { title: 'Refund', category: '', tags: [], body: '' }), 0);
});

test('quick reply placeholders are allowlisted and mention-safe', () => {
  const rendered = renderQuickReplyTemplate('Hello {user}, ticket {ticket_number} is with {department}.', {
    user: '@everyone',
    ticket_number: '42',
    department: 'Billing',
    channel: 'ticket-42',
    guild: 'Shop',
  });
  assert.equal(rendered, 'Hello @\u200beveryone, ticket 42 is with Billing.');
  assert.throws(() => validateQuickReplyTemplate('Use {unknown_secret}'), /Unsupported placeholder/);
  assert.throws(() => validateQuickReplyTemplate('Use {user-name}'), /Unsupported placeholder/);
  assert.throws(() => validateQuickReplyTemplate('Use { user }'), /Unsupported placeholder/);
  assert.throws(() => validateQuickReplyTemplate('x'.repeat(1901)), /1,900 characters/);
});
