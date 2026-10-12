import type { PersistedTicket } from './ticketPersistenceService';
import {
  TICKET_PREFIX,
  getField,
  isTicketTopic,
  removeField,
  setField,
} from './ticketStateService';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function setOrRemove(topic: string, key: string, value: unknown): string {
  const string = stringValue(value);
  return string ? setField(topic, key, string) : removeField(topic, key);
}

/**
 * The database owns ticket state. Channel topics are a compatibility
 * projection for existing controls and humans, never the source of truth.
 * All command and recovery paths use this one mapping.
 */
export function projectDurableTicketTopic(
  currentTopic: string,
  ticket: PersistedTicket,
): string {
  let topic = isTicketTopic(currentTopic) ? currentTopic : TICKET_PREFIX;
  const metadata = ticket.metadata ?? {};

  topic = setField(topic, 'v', '2');
  topic = setField(topic, 'status', ticket.status);
  topic = setOrRemove(topic, 'number', ticket.ticketNumber);
  topic = setOrRemove(topic, 'owner', ticket.ownerId);
  topic = setOrRemove(topic, 'department', ticket.departmentId);
  topic = setOrRemove(topic, 'tag', ticket.tagId);
  topic = setOrRemove(topic, 'tags', ticket.tagId);
  topic = setField(topic, 'priority', ticket.priority ?? 'normal');

  const staffRoleId = stringValue(metadata.staffRoleId) ?? getField(topic, 'staff');
  topic = setField(topic, 'staff', staffRoleId ?? 'none');

  topic = setOrRemove(topic, 'claimed_by', ticket.claimedByIds.join(','));
  const additionalParticipants = ticket.participantIds.filter((id) => id !== ticket.ownerId);
  topic = setOrRemove(topic, 'users', additionalParticipants.join(','));
  topic = setOrRemove(
    topic,
    'subject',
    stringValue(metadata.subject)
      ? encodeURIComponent(String(metadata.subject))
      : getField(topic, 'subject'),
  );
  topic = setOrRemove(
    topic,
    'message',
    metadata.panelMessageId ?? getField(topic, 'message'),
  );
  topic = setOrRemove(
    topic,
    'opened_at',
    metadata.openedAt ?? ticket.createdAt ?? getField(topic, 'opened_at'),
  );
  topic = setOrRemove(topic, 'updated_at', ticket.updatedAt);

  const fields: ReadonlyArray<readonly [string, string]> = [
    ['pendingSince', 'pending_since'],
    ['closedAt', 'closed_at'],
    ['reopenedAt', 'reopened_at'],
    ['archivedAt', 'archived_at'],
    ['transcriptId', 'transcript_id'],
    ['transcriptDestinationId', 'transcript_destination_id'],
    ['voiceChannelId', 'voice_channel_id'],
    ['voiceChannelName', 'voice_channel_name'],
    ['voiceStartedAt', 'voice_started_at'],
    ['voiceStartedBy', 'voice_started_by'],
    ['lastActivityAt', 'last_activity_at'],
    ['lastCustomerMessageAt', 'last_customer_message_at'],
    ['lastStaffActivityAt', 'last_staff_activity_at'],
  ];

  for (const [metadataKey, topicKey] of fields) {
    const value = metadata[metadataKey];
    if (value === undefined) continue;
    if (value === null) {
      topic = removeField(topic, topicKey);
      continue;
    }
    topic = setOrRemove(topic, topicKey, value);
  }

  return topic;
}
