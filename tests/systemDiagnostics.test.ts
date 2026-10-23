import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addDiagnosticReferences,
  buildSystemDiagnosticsEmbed,
  diagnosticsOverallStatus,
  diagnosticsPageCount,
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

  assert.equal(diagnosticsOverallStatus([]), 'UNKNOWN');
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


test('diagnostic findings receive stable references and embed output displays them', () => {
  const report = {
    guildId: 'guild-test',
    reportId: 'DX-ABC12345',
    generatedAt: '2026-10-23T12:00:00.000Z',
    mode: 'health' as const,
    findings: [
      { area: 'Database', severity: 'error' as const, title: 'Connection failed', detail: 'No connection.' },
      { area: 'Queue', severity: 'warning' as const, title: 'Backlog', detail: 'Queue is delayed.' },
    ],
  };
  addDiagnosticReferences(report);

  assert.equal(report.findings[0]?.referenceId, 'DX-ABC12345-001');
  assert.equal(report.findings[1]?.referenceId, 'DX-ABC12345-002');
  const embed = buildSystemDiagnosticsEmbed(report).toJSON();
  assert.ok(embed.description?.includes('DX-ABC12345'));
  assert.ok(embed.fields?.some((field) => field.value.includes('DX-ABC12345-001')));
  assert.ok(embed.fields?.some((field) => field.value.includes('DX-ABC12345-002')));
});


test('empty diagnostic reports are explicitly unknown, never presented as healthy', () => {
  assert.equal(diagnosticsOverallStatus([]), 'UNKNOWN');
  const embed = buildSystemDiagnosticsEmbed({
    guildId: 'guild-test',
    reportId: 'DX-EMPTY001',
    generatedAt: '2026-10-23T12:00:00.000Z',
    mode: 'setup-doctor',
    findings: [],
  }).toJSON();
  assert.ok(embed.description?.includes('UNKNOWN'));
  assert.ok(embed.description?.includes('no checks produced results'));
});


test('large diagnostic reports paginate findings without silently dropping later checks', () => {
  const report = {
    guildId: 'guild-large',
    reportId: 'DX-LARGE001',
    generatedAt: '2026-10-23T12:00:00.000Z',
    mode: 'setup-doctor' as const,
    findings: Array.from({ length: 23 }, (_, index) => ({
      area: index % 2 === 0 ? 'Custom panels' : 'Departments',
      severity: index % 3 === 0 ? 'error' as const : 'warning' as const,
      title: 'Finding ' + (index + 1),
      detail: 'Detail for finding ' + (index + 1),
    })),
  };
  addDiagnosticReferences(report);

  assert.equal(diagnosticsPageCount(report), 3);
  const pages = [1, 2, 3].map((page) => buildSystemDiagnosticsEmbed(report, 0x3b82f6, page).toJSON());
  assert.deepEqual(pages.map((page) => page.fields?.length), [10, 10, 3]);

  const displayedNames = pages.flatMap((page) => page.fields?.map((field) => field.name) ?? []);
  for (let index = 1; index <= 23; index += 1) {
    assert.ok(displayedNames.some((name) => name.includes('DX-LARGE001-' + String(index).padStart(3, '0'))));
  }
  assert.equal(new Set(displayedNames).size, 23);
  assert.ok(pages[0]?.description?.includes('Page:** 1 of 3'));
  assert.ok(pages[2]?.description?.includes('Page:** 3 of 3'));
});
