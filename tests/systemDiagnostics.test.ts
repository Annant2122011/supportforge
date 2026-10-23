import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diagnosticsOverallStatus,
  evaluateOutboxCounts,
  type DiagnosticFinding,
} from '../src/services/systemDiagnosticsService';

test('system diagnostics report status escalates on errors and warnings without false success', () => {
  const ok: DiagnosticFinding = {
    area: 'Database', severity: 'ok', title: 'Connected', detail: 'Probe succeeded.',
  };
  const warning: DiagnosticFinding = {
    area: 'Discord', severity: 'warning', title: 'Panel missing', detail: 'Stored message is not present.',
  };
  const error: DiagnosticFinding = {
    area: 'Database', severity: 'error', title: 'Disconnected', detail: 'Probe failed.',
  };

  assert.equal(diagnosticsOverallStatus([]), 'HEALTHY');
  assert.equal(diagnosticsOverallStatus([ok]), 'HEALTHY');
  assert.equal(diagnosticsOverallStatus([ok, warning]), 'DEGRADED');
  assert.equal(diagnosticsOverallStatus([warning, error]), 'ACTION REQUIRED');
});

test('outbox diagnostics report failed delivery as an error rather than healthy', () => {
  const findings = evaluateOutboxCounts({
    pending: 2,
    processing: 0,
    failed: 1,
  }, Date.parse('2026-10-23T12:00:00.000Z'));

  assert.equal(findings.find((item) => item.title.includes('Failed outbox'))?.severity, 'error');
  assert.equal(findings.find((item) => item.title.includes('Pending outbox'))?.severity, 'ok');
  assert.equal(findings.find((item) => item.title.includes('processing lease'))?.severity, 'ok');
});

test('outbox diagnostics warn for a large backlog and stale pending or processing lease', () => {
  const now = Date.parse('2026-10-23T12:00:00.000Z');
  const findings = evaluateOutboxCounts({
    pending: 51,
    processing: 2,
    failed: 0,
    oldestPendingAt: '2026-10-23T11:30:00.000Z',
    oldestProcessingAt: '2026-10-23T11:45:00.000Z',
  }, now);

  assert.equal(findings.find((item) => item.title.includes('Outbox backlog'))?.severity, 'warning');
  assert.equal(findings.find((item) => item.title.includes('stuck in processing'))?.severity, 'warning');
});

test('outbox diagnostics handle invalid timestamps without crashing or inventing an age', () => {
  const findings = evaluateOutboxCounts({
    pending: 0,
    processing: 1,
    failed: 0,
    oldestPendingAt: 'not-a-date',
    oldestProcessingAt: 'invalid',
  }, Date.now());

  assert.ok(findings.every((finding) => typeof finding.detail === 'string'));
  assert.equal(findings.find((item) => item.title.includes('stuck in processing'))?.severity, undefined);
});
