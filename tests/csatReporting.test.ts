import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateCsatPercentage,
  compareCsatMetric,
  isCsatCohortVisible,
  neutralizeCsatCsvCell,
} from '../src/core/domain/csatReporting';

test('CSAT percentages keep denominator semantics explicit and handle zero samples', () => {
  assert.equal(calculateCsatPercentage(15, 20), 75);
  assert.equal(calculateCsatPercentage(1, 3), 33.3);
  assert.equal(calculateCsatPercentage(0, 0), null);
  assert.throws(() => calculateCsatPercentage(2, 1), /valid denominator/);
  assert.throws(() => calculateCsatPercentage(-1, 2), /non-negative/);
});

test('CSAT cohort privacy threshold suppresses small groups', () => {
  assert.equal(isCsatCohortVisible(4, 5), false);
  assert.equal(isCsatCohortVisible(5, 5), true);
  assert.throws(() => isCsatCohortVisible(1, 0), /threshold/);
});

test('CSAT trend comparisons remain unavailable when either period has no safe value', () => {
  assert.equal(compareCsatMetric(4.2, 3.8), 0.4);
  assert.equal(compareCsatMetric(null, 3.8), null);
  assert.equal(compareCsatMetric(4.2, null), null);
});

test('CSAT aggregate CSV cells neutralize formula prefixes and retain CSV quoting', () => {
  for (const value of ['=1+1', '+SUM(A1:A2)', '-cmd', '@SUM(A1)', '  =2+2']) {
    assert.equal(neutralizeCsatCsvCell(value).startsWith("'"), true);
  }
  assert.equal(neutralizeCsatCsvCell('plain text'), 'plain text');
  assert.equal(neutralizeCsatCsvCell('one,"two"'), '"one,""two"""');
});
