import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfigurationHistoryDocument, restoreConfigurationSnapshot } from '../src/services/configurationHistoryService';

function snapshot(id: string, guildId = '123456789012345678') {
  return {
    id: 'cfg_' + id,
    guildId,
    createdAt: '2026-10-23T12:00:00.000Z',
    createdById: '223456789012345678',
    createdByName: 'Test administrator',
    reason: 'Checkpoint ' + id,
    departmentCount: 1,
    panelCount: 0,
    tagCount: 2,
    formCount: 0,
    supportHoursPolicyCount: 0,
    payload: {
      guildConfig: { departments: {}, customPanels: {} },
      advancedSettings: {},
      supportHours: [],
      ticketForms: [],
    },
  };
}

test('empty configuration-history storage initializes a versioned empty document', () => {
  assert.deepEqual(normalizeConfigurationHistoryDocument(null), {
    version: 1,
    guilds: {},
  });
});

test('valid snapshots are kept in the correct guild and retention stays bounded', () => {
  const guildId = '123456789012345678';
  const snapshots = Array.from({ length: 12 }, (_, index) => snapshot(String(index + 1), guildId));
  const normalized = normalizeConfigurationHistoryDocument({
    version: 1,
    guilds: { [guildId]: snapshots },
  });

  assert.equal(normalized.version, 1);
  assert.equal(normalized.guilds[guildId]?.length, 10);
  assert.equal(normalized.guilds[guildId]?.[0]?.id, 'cfg_1');
  assert.equal(normalized.guilds[guildId]?.[9]?.id, 'cfg_10');
});

test('malformed snapshots fail closed instead of being silently dropped on the next history write', () => {
  const guildId = '123456789012345678';
  const existing = snapshot('valid', guildId);
  const malformed = { id: 'cfg_broken', guildId, payload: { guildConfig: {} } };

  assert.throws(
    () => normalizeConfigurationHistoryDocument({
      version: 1,
      guilds: { [guildId]: [existing, malformed] },
    }),
    /Existing history was not overwritten/,
  );
});

test('history documents from unsupported versions are not normalized or overwritten', () => {
  assert.throws(
    () => normalizeConfigurationHistoryDocument({ version: 2, guilds: {} }),
    /version is unsupported/,
  );
});

test('a snapshot stored under the wrong guild key is rejected', () => {
  const guildId = '123456789012345678';
  const otherGuildId = '323456789012345678';

  assert.throws(
    () => normalizeConfigurationHistoryDocument({
      version: 1,
      guilds: { [guildId]: [snapshot('foreign', otherGuildId)] },
    }),
    /malformed snapshot/,
  );
});


test('configuration restore rejects an incorrect confirmation before reading or mutating persistence', async () => {
  await assert.rejects(
    restoreConfigurationSnapshot(
      '123456789012345678',
      'cfg_expected',
      'RESTORE cfg_typo',
      { id: '223456789012345678', name: 'Test administrator' },
    ),
    /Restore confirmation did not match/,
  );
});

test('non-array snapshots and blank guild keys fail closed', () => {
  assert.throws(
    () => normalizeConfigurationHistoryDocument({ version: 1, guilds: { '123456789012345678': {} } }),
    /malformed guild entry/,
  );
  assert.throws(
    () => normalizeConfigurationHistoryDocument({ version: 1, guilds: { '   ': [] } }),
    /malformed guild entry/,
  );
});
