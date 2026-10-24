export type RecoverySource = 'discord_native' | 'ticket_button';

export interface RecoveryPreviewFacts {
  source: RecoverySource;
  status: string;
  accidentalAnswer: 'yes' | 'no' | null;
  channelSnapshotAvailable: boolean;
  historicalBackfillComplete: boolean;
  archivedMessageCount: number;
  deletedMessageCount: number;
  latestArchivedAt: string | null;
  totalAttachmentCount: number;
  trackedAttachmentCount: number;
  restorableAttachmentCount: number;
  tooLargeAttachmentCount: number;
  metadataOnlyAttachmentCount: number;
  pendingAttachmentCount: number;
  failedAttachmentCount: number;
  alreadyReplayedMessageCount: number;
}

export interface RecoveryPreviewSummary extends RecoveryPreviewFacts {
  eligibleToRestore: boolean;
  attachmentRecordsMissing: number;
  attachmentBytesUnavailable: number;
  warnings: string[];
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Build a safe, read-only recovery summary from archive metadata.
 * This intentionally accepts counts and identifiers only, never message bodies.
 */
export function buildRecoveryPreviewSummary(
  facts: RecoveryPreviewFacts,
): RecoveryPreviewSummary {
  const eligibleToRestore = facts.source === 'discord_native'
    ? ['deleted', 'failed', 'restoring'].includes(facts.status)
    : ['reviewed', 'failed', 'restoring'].includes(facts.status) &&
      facts.accidentalAnswer === 'yes';

  const totalAttachmentCount = nonNegativeInteger(facts.totalAttachmentCount);
  const trackedAttachmentCount = nonNegativeInteger(facts.trackedAttachmentCount);
  const restorableAttachmentCount = Math.min(
    totalAttachmentCount,
    nonNegativeInteger(facts.restorableAttachmentCount),
  );
  const attachmentRecordsMissing = Math.max(
    0,
    totalAttachmentCount - trackedAttachmentCount,
  );
  const attachmentBytesUnavailable = Math.max(
    0,
    totalAttachmentCount - restorableAttachmentCount,
  );
  const warnings: string[] = [];

  if (!eligibleToRestore) {
    warnings.push(
      facts.source === 'ticket_button'
        ? 'This ticket-button deletion is not eligible until the accidental-deletion review is answered Yes.'
        : 'This recovery record is no longer eligible for restoration.',
    );
  }
  if (!facts.channelSnapshotAvailable) {
    warnings.push('The original channel snapshot is missing; recovery will use safe defaults for unavailable channel settings.');
  }
  if (!facts.historicalBackfillComplete) {
    warnings.push('The historic message scan is incomplete. Only messages already archived can be replayed; older missing history cannot be inferred.');
  }
  if (nonNegativeInteger(facts.archivedMessageCount) === 0) {
    warnings.push('No archived message records were found for this ticket.');
  }
  if (attachmentRecordsMissing > 0) {
    warnings.push(
      attachmentRecordsMissing + ' attachment metadata record(s) do not yet have a corresponding attachment archive row.',
    );
  }
  if (attachmentBytesUnavailable > 0) {
    warnings.push(
      attachmentBytesUnavailable + ' attachment(s) do not have archived bytes available for upload. Metadata may still be shown.',
    );
  }
  if (nonNegativeInteger(facts.alreadyReplayedMessageCount) > 0) {
    warnings.push('A previous recovery attempt already replayed some message records. The retry ledger will be checked before replay continues.');
  }

  return {
    ...facts,
    archivedMessageCount: nonNegativeInteger(facts.archivedMessageCount),
    deletedMessageCount: nonNegativeInteger(facts.deletedMessageCount),
    totalAttachmentCount,
    trackedAttachmentCount,
    restorableAttachmentCount,
    tooLargeAttachmentCount: nonNegativeInteger(facts.tooLargeAttachmentCount),
    metadataOnlyAttachmentCount: nonNegativeInteger(facts.metadataOnlyAttachmentCount),
    pendingAttachmentCount: nonNegativeInteger(facts.pendingAttachmentCount),
    failedAttachmentCount: nonNegativeInteger(facts.failedAttachmentCount),
    alreadyReplayedMessageCount: nonNegativeInteger(facts.alreadyReplayedMessageCount),
    eligibleToRestore,
    attachmentRecordsMissing,
    attachmentBytesUnavailable,
    warnings,
  };
}
