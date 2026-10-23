import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getOperationalTaskFindings,
  recordOperationalTaskFailed,
  recordOperationalTaskSkipped,
  recordOperationalTaskStarted,
  recordOperationalTaskSucceeded,
  resetOperationalTaskTelemetryForTests,
} from '../src/services/operationalTaskTelemetry';

test('unobserved background jobs are UNKNOWN/INFO instead of falsely healthy', () => {
  resetOperationalTaskTelemetryForTests();
  const findings = getOperationalTaskFindings('guild-a', 1_000_000);
  const outbox = findings.find((finding) => finding.title.includes('Durable outbox processor'));
  assert.equal(outbox?.severity, 'info');
  assert.match(outbox?.detail ?? '', /resets after restart/);
});

test('a successful task reports completion and isolates per-guild state', () => {
  resetOperationalTaskTelemetryForTests();
  recordOperationalTaskStarted('ticket-retention', 'guild-a', 1_000);
  recordOperationalTaskSucceeded('ticket-retention', 'guild-a', 1_500);
  const a = getOperationalTaskFindings('guild-a', 2_000).find((finding) => finding.title.includes('Ticket retention sweep'));
  const b = getOperationalTaskFindings('guild-b', 2_000).find((finding) => finding.title.includes('Ticket retention sweep'));
  assert.equal(a?.severity, 'ok');
  assert.match(a?.detail ?? '', /500 ms/);
  assert.equal(b?.severity, 'info');
});

test('a single task failure warns and repeated failures escalate to error', () => {
  resetOperationalTaskTelemetryForTests();
  recordOperationalTaskStarted('ticket-archive-backfill', null, 1_000);
  recordOperationalTaskFailed('ticket-archive-backfill', null, new Error('database-password=do-not-show'), 1_100);
  let finding = getOperationalTaskFindings('guild-a', 1_200).find((item) => item.title.includes('Ticket archive backfill'));
  assert.equal(finding?.severity, 'warning');
  assert.doesNotMatch(finding?.detail ?? '', /do-not-show|database-password/);

  recordOperationalTaskStarted('ticket-archive-backfill', null, 2_000);
  recordOperationalTaskFailed('ticket-archive-backfill', null, new Error('another failure'), 2_100);
  recordOperationalTaskStarted('ticket-archive-backfill', null, 3_000);
  recordOperationalTaskFailed('ticket-archive-backfill', null, new Error('third failure'), 3_100);
  finding = getOperationalTaskFindings('guild-a', 3_200).find((item) => item.title.includes('Ticket archive backfill'));
  assert.equal(finding?.severity, 'error');
  assert.match(finding?.detail ?? '', /3 consecutive failure/);
});

test('a successful run clears the consecutive-failure alarm', () => {
  resetOperationalTaskTelemetryForTests();
  recordOperationalTaskStarted('ticket-form-cache-refresh', null, 1_000);
  recordOperationalTaskFailed('ticket-form-cache-refresh', null, new Error('temporary'), 1_100);
  recordOperationalTaskStarted('ticket-form-cache-refresh', null, 2_000);
  recordOperationalTaskSucceeded('ticket-form-cache-refresh', null, 2_100);
  const finding = getOperationalTaskFindings('guild-a', 2_200).find((item) => item.title.includes('form-cache refresh'));
  assert.equal(finding?.severity, 'ok');
  assert.doesNotMatch(finding?.title ?? '', /failed/i);
});

test('stale periodic tasks warn while a deliberately skipped task stays informational', () => {
  resetOperationalTaskTelemetryForTests();
  recordOperationalTaskStarted('outbox-processor', null, 1_000);
  recordOperationalTaskSucceeded('outbox-processor', null, 1_100);
  const stale = getOperationalTaskFindings('guild-a', 1_100 + 61_000).find((item) => item.title.includes('Durable outbox processor'));
  assert.equal(stale?.severity, 'warning');

  recordOperationalTaskSkipped('startup-reconciliation', 'guild-a', 'Guild has no existing ResolvX setup', 2_000);
  const skipped = getOperationalTaskFindings('guild-a', 2_100).find((item) => item.title.includes('Managed-resource startup reconciliation'));
  assert.equal(skipped?.severity, 'info');
  assert.match(skipped?.detail ?? '', /no existing ResolvX setup/);
});

test('guild-specific task outcomes do not contaminate another guild', () => {
  resetOperationalTaskTelemetryForTests();
  recordOperationalTaskStarted('ticket-inactivity', 'guild-a', 1_000);
  recordOperationalTaskFailed('ticket-inactivity', 'guild-a', new Error('failure'), 1_100);
  const a = getOperationalTaskFindings('guild-a', 1_200).find((item) => item.title.includes('Ticket inactivity sweep'));
  const b = getOperationalTaskFindings('guild-b', 1_200).find((item) => item.title.includes('Ticket inactivity sweep'));
  assert.equal(a?.severity, 'warning');
  assert.equal(b?.severity, 'info');
});
