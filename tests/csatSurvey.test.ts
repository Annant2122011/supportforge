import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCsatSurveyTransition,
  calculateCsatSurveyRetryDelayMs,
  canTransitionCsatSurvey,
  isCsatSurveyExpired,
  validateCsatSurveyTiming,
} from '../src/core/domain/csatSurvey';

test('CSAT survey state machine allows only explicit forward/recovery transitions', () => {
  assert.equal(canTransitionCsatSurvey('pending', 'sending'), true);
  assert.equal(canTransitionCsatSurvey('sending', 'failed'), true);
  assert.equal(canTransitionCsatSurvey('failed', 'sending'), true);
  assert.equal(canTransitionCsatSurvey('sent', 'responded'), true);
  assert.equal(canTransitionCsatSurvey('responded', 'sent'), false);
  assert.equal(canTransitionCsatSurvey('expired', 'responded'), false);
  assert.equal(canTransitionCsatSurvey('cancelled', 'sending'), false);
  assert.throws(() => assertCsatSurveyTransition('responded', 'sent'), /Invalid CSAT survey transition/);
});

test('CSAT delivery retry delays are bounded and reject nonsensical attempt counts', () => {
  assert.equal(calculateCsatSurveyRetryDelayMs(1), 30_000);
  assert.equal(calculateCsatSurveyRetryDelayMs(2), 60_000);
  assert.equal(calculateCsatSurveyRetryDelayMs(8), 30_000 * 2 ** 7);
  assert.equal(calculateCsatSurveyRetryDelayMs(100), 6 * 60 * 60_000);
  assert.throws(() => calculateCsatSurveyRetryDelayMs(0), /positive whole number/);
  assert.throws(() => calculateCsatSurveyRetryDelayMs(1.5), /positive whole number/);
});

test('CSAT expiry is inclusive and invalid timestamps are rejected', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  assert.equal(isCsatSurveyExpired('2026-10-29T12:00:00.000Z', now), true);
  assert.equal(isCsatSurveyExpired('2026-10-29T12:00:00.001Z', now), false);
  assert.throws(() => isCsatSurveyExpired('not-a-date', now), /valid timestamp/);
});

test('CSAT timing has explicit bounds and disallows delay beyond expiry', () => {
  assert.doesNotThrow(() => validateCsatSurveyTiming(0, 1));
  assert.doesNotThrow(() => validateCsatSurveyTiming(60, 7));
  assert.throws(() => validateCsatSurveyTiming(-1, 7), /delay must be a whole number/);
  assert.throws(() => validateCsatSurveyTiming(10081, 30), /delay must be a whole number/);
  assert.throws(() => validateCsatSurveyTiming(0, 0), /expiry must be a whole number/);
  assert.throws(() => validateCsatSurveyTiming(1440, 1), /shorter than the survey expiry window/);
});
