import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRestoreTargetDistinctFromConfiguredDatabase,
  isAllowedRestoreTargetLabel,
  isSafeBackupFilename,
  RESTORE_TARGET_CONFIRMATION,
  validateBackupManifest,
} from '../src/core/persistence/backupRestoreSafety';

const manifest = {
  format: 'postgres-custom' as const,
  filename: 'neon-backup-20261023T180000Z.dump',
  sha256: 'a'.repeat(64),
  sizeBytes: 1024,
  createdAt: '2026-10-23T18:00:00.000Z',
  databaseHost: 'ep-example.neon.tech',
  databaseName: 'resolvx',
};

test('restore requires an explicit non-production target label', () => {
  for (const label of ['test', 'staging-mainline', 'restore-branch', 'nonprod-neon']) {
    assert.equal(isAllowedRestoreTargetLabel(label), true);
  }
  for (const label of ['', 'prod', 'production', 'main', 'live', 'restore-production', '../test', 42, 'x']) {
    assert.equal(isAllowedRestoreTargetLabel(label), false);
  }
  assert.equal(RESTORE_TARGET_CONFIRMATION, 'RESTORE_TO_EMPTY_NON_PRODUCTION_DATABASE');
});

test('backup filenames cannot traverse directories or point outside custom dumps', () => {
  assert.equal(isSafeBackupFilename(manifest.filename), true);
  for (const value of ['../secrets.dump', '..\\secrets.dump', '/tmp/db.dump', 'db.sql', ' db.dump ', '', null]) {
    assert.equal(isSafeBackupFilename(value), false);
  }
});

test('restore refuses altered, incomplete, mismatched or empty backup manifests', () => {
  assert.doesNotThrow(() => validateBackupManifest(manifest, manifest.filename, manifest.sha256, manifest.sizeBytes));
  assert.throws(() => validateBackupManifest(manifest, manifest.filename, 'b'.repeat(64), manifest.sizeBytes), /checksum mismatch/);
  assert.throws(() => validateBackupManifest(manifest, 'other.dump', manifest.sha256, manifest.sizeBytes), /filename does not match/);
  assert.throws(() => validateBackupManifest(manifest, manifest.filename, manifest.sha256, 0), /size does not match/);
  assert.throws(() => validateBackupManifest(null, manifest.filename, manifest.sha256, manifest.sizeBytes), /missing or malformed/);
});


test('restore refuses targets matching the running bot configured database', () => {
  assert.throws(
    () => assertRestoreTargetDistinctFromConfiguredDatabase(
      'postgresql://restore-user:secret@ep-live.neon.tech:5432/resolvx?sslmode=require',
      ['postgresql://app:secret@ep-live.neon.tech:5432/resolvx?sslmode=require'],
    ),
    /matches a database configured for the running bot/,
  );
  assert.throws(
    () => assertRestoreTargetDistinctFromConfiguredDatabase(
      'postgresql://restore-user:secret@ep-test.neon.tech:5432/resolvx',
      ['not-a-postgres-url'],
    ),
    /configured PostgreSQL URL could not be validated/,
  );
});

test('restore allows an isolated database and ignores absent optional database URLs', () => {
  assert.doesNotThrow(() =>
    assertRestoreTargetDistinctFromConfiguredDatabase(
      'postgresql://restore-user:secret@ep-restore.neon.tech:5432/resolvx_restore',
      ['postgresql://app:secret@ep-live.neon.tech:5432/resolvx', undefined, ''],
    ),
  );
});
