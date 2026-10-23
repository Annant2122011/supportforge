import assert from 'node:assert/strict';
import test from 'node:test';

import { categorizeCsatRating, normalizeCsatResponse } from '../src/core/domain/csatPolicy';

test('CSAT accepts whole-number ratings from one through five', () => {
  for (let rating = 1; rating <= 5; rating += 1) {
    assert.equal(normalizeCsatResponse(rating).rating, rating);
  }
  for (const rating of [0, 6, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => normalizeCsatResponse(rating), /whole number from 1 to 5/);
  }
});

test('CSAT comments are trimmed and bounded without altering internal content', () => {
  assert.deepEqual(normalizeCsatResponse(4, '  Helpful, thank you.  '), {
    rating: 4,
    comment: 'Helpful, thank you.',
  });
  assert.equal(normalizeCsatResponse(5, 'x'.repeat(500)).comment.length, 500);
  assert.throws(() => normalizeCsatResponse(5, 'x'.repeat(501)), /500 characters or fewer/);
  assert.throws(() => normalizeCsatResponse(4, 123), /must be text/);
});

test('CSAT aggregate sentiment thresholds stay consistent', () => {
  assert.equal(categorizeCsatRating(1), 'negative');
  assert.equal(categorizeCsatRating(2), 'negative');
  assert.equal(categorizeCsatRating(3), 'neutral');
  assert.equal(categorizeCsatRating(4), 'positive');
  assert.equal(categorizeCsatRating(5), 'positive');
});
