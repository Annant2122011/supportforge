
export const TICKET_PREFIX = 'supportforge:ticket';

export type TicketStatus =
  | 'open'
  | 'claimed'
  | 'pending'
  | 'closed'
  | 'reopened'
  | 'archived';

export interface TicketFields {
  status: TicketStatus;
  ownerId?: string;
  departmentId?: string;
  staffRoleId?: string;
  priority: string;
  tags: string[];
  users: string[];
  claimedBy?: string;
  pendingSince?: string;
  claimedAt?: string;
  assignedAt?: string;
  previousAssignee?: string;
  closedAt?: string;
  reopenedAt?: string;
  archivedAt?: string;
  subject?: string;
  number?: string;
  messageId?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getField(
  topic: string,
  key: string,
): string | undefined {
  const escapedKey = escapeRegExp(key);

  const match = topic.match(
    new RegExp(`(?:^|\\s)${escapedKey}=([^\\s]*)`),
  );

  if (match?.[1]) {
    return match[1];
  }

  // Pre-v2 tickets used camelCase for the claimant field.
  // Read it as a compatibility alias, while all new writes
  // use the canonical snake_case field.
  if (key === 'claimed_by') {
    const legacy = topic.match(
      /(?:^|\s)claimedBy=([^\s]*)/,
    );

    return legacy?.[1] || undefined;
  }

  return undefined;
}

export function setField(
  topic: string,
  key: string,
  value: string,
): string {
  const token = `${key}=`;

  const parts = topic
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const index = parts.findIndex(
    (part) => part.startsWith(token),
  );

  if (index >= 0) {
    parts[index] = `${token}${value}`;
  } else {
    parts.push(`${token}${value}`);
  }

  return parts.join(' ');
}

export function removeField(
  topic: string,
  key: string,
): string {
  const escapedKey = escapeRegExp(key);

  let result = topic.replace(
    new RegExp(
      `(?:^|\\s)${escapedKey}=[^\\s]*`,
    ),
    '',
  );

  // Remove the legacy camelCase claimant field too.
  if (key === 'claimed_by') {
    result = result.replace(
      /(?:^|\s)claimedBy=[^\s]*/,
      '',
    );
  }

  return result
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function isTicketTopic(
  topic: string,
): boolean {
  return topic.startsWith(TICKET_PREFIX);
}

export function isTicketStatus(
  value: string | undefined,
): value is TicketStatus {
  return (
    value === 'open' ||
    value === 'claimed' ||
    value === 'pending' ||
    value === 'closed' ||
    value === 'reopened' ||
    value === 'archived'
  );
}

export function getTicketStatus(
  topic: string,
): TicketStatus {
  const status = getField(
    topic,
    'status',
  );

  return isTicketStatus(status)
    ? status
    : 'open';
}

export function parseTicketFields(
  topic: string,
): TicketFields {
  return {
    status: getTicketStatus(topic),

    ownerId: getField(
      topic,
      'owner',
    ),

    departmentId: getField(
      topic,
      'department',
    ),

    staffRoleId: getField(
      topic,
      'staff',
    ),

    priority:
      getField(
        topic,
        'priority',
      ) ?? 'normal',

    tags: (
      getField(
        topic,
        'tags',
      ) ?? ''
    )
      .split(',')
      .filter(Boolean),

    users: (
      getField(
        topic,
        'users',
      ) ?? ''
    )
      .split(',')
      .filter(Boolean),

    claimedBy: getField(
      topic,
      'claimed_by',
    ),

    pendingSince: getField(
      topic,
      'pending_since',
    ),

    claimedAt: getField(
      topic,
      'claimed_at',
    ),

    assignedAt: getField(
      topic,
      'assigned_at',
    ),

    previousAssignee: getField(
      topic,
      'previous_assignee',
    ),

    closedAt: getField(
      topic,
      'closed_at',
    ),

    reopenedAt: getField(
      topic,
      'reopened_at',
    ),

    archivedAt: getField(
      topic,
      'archived_at',
    ),

    subject: getField(
      topic,
      'subject',
    ),

    number: getField(
      topic,
      'number',
    ),

    messageId: getField(
      topic,
      'message',
    ),
  };
}
