import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRecoveryPreviewSummary, type RecoveryPreviewFacts } from '../src/core/domain/recoveryPreview';

function facts(overrides: Partial<RecoveryPreviewFacts> = {}): RecoveryPreviewFacts {
  return {
    source: 'discord_native',
    status: 'deleted',
    accidentalAnswer: null,
    channelSnapshotAvailable: true,
    historicalBackfillComplete: true,
    archivedMessageCount: 25,
    deletedMessageCount: 2,
    latestArchivedAt: '2026-10-23T12:00:00.000Z',
    totalAttachmentCount: 4,
    trackedAttachmentCount: 4,
    restorableAttachmentCount: 2,
    tooLargeAttachmentCount: 1,
    metadataOnlyAttachmentCount: 1,
    pendingAttachmentCount: 0,
    failedAttachmentCount: 0,
    alreadyReplayedMessageCount: 0,
    ...overrides,
  };
}

test('native deletion preview allows only eligible recovery states', () => {
  assert.equal(buildRecoveryPreviewSummary(facts({ status: 'deleted' })).eligibleToRestore, true);
  assert.equal(buildRecoveryPreviewSummary(facts({ status: 'failed' })).eligibleToRestore, true);
  assert.equal(buildRecoveryPreviewSummary(facts({ status: 'restored' })).eligibleToRestore, false);
});

test('ticket-button recovery preview requires an explicit accidental answer', () => {
  assert.equal(buildRecoveryPreviewSummary(facts({
    source: 'ticket_button',
    status: 'reviewed',
    accidentalAnswer: 'yes',
  })).eligibleToRestore, true);
  const intentionalOrUnreviewed = buildRecoveryPreviewSummary(facts({
    source: 'ticket_button',
    status: 'reviewed',
    accidentalAnswer: 'no',
  }));
  assert.equal(intentionalOrUnreviewed.eligibleToRestore, false);
  assert.ok(intentionalOrUnreviewed.warnings.some((warning) => warning.includes('answered Yes')));
});

test('preview identifies incomplete channel history and missing attachment bytes', () => {
  const preview = buildRecoveryPreviewSummary(facts({
    channelSnapshotAvailable: false,
    historicalBackfillComplete: false,
    totalAttachmentCount: 7,
    trackedAttachmentCount: 4,
    restorableAttachmentCount: 2,
  }));
  assert.equal(preview.attachmentRecordsMissing, 3);
  assert.equal(preview.attachmentBytesUnavailable, 5);
  assert.ok(preview.warnings.some((warning) => warning.includes('snapshot is missing')));
  assert.ok(preview.warnings.some((warning) => warning.includes('scan is incomplete')));
  assert.ok(preview.warnings.some((warning) => warning.includes('do not yet have a corresponding attachment archive row')));
  assert.ok(preview.warnings.some((warning) => warning.includes('do not have archived bytes')));
});

test('preview clamps malformed negative counts and never needs message content', () => {
  const preview = buildRecoveryPreviewSummary(facts({
    archivedMessageCount: -10,
    totalAttachmentCount: -5,
    trackedAttachmentCount: Number.NaN,
    restorableAttachmentCount: 99,
  }));
  assert.equal(preview.archivedMessageCount, 0);
  assert.equal(preview.totalAttachmentCount, 0);
  assert.equal(preview.trackedAttachmentCount, 0);
  assert.equal(preview.restorableAttachmentCount, 0);
  assert.equal(preview.attachmentBytesUnavailable, 0);
});
