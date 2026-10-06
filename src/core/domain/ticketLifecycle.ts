export type TicketStatus =
  | 'open'
  | 'claimed'
  | 'pending'
  | 'reopened'
  | 'closed'
  | 'archived';

const VALID_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  open: ['claimed', 'pending', 'closed'],
  claimed: ['open', 'pending', 'closed'],
  pending: ['open', 'claimed', 'closed'],
  reopened: ['open', 'claimed', 'pending', 'closed'],
  closed: ['reopened', 'archived'],
  archived: [],
};

export function canTransitionTicketStatus(
  from: TicketStatus,
  to: TicketStatus,
): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function assertTicketStatusTransition(
  from: TicketStatus,
  to: TicketStatus,
): void {
  if (canTransitionTicketStatus(from, to)) {
    return;
  }

  throw new Error(
    `Invalid SupportForge ticket lifecycle transition: ${from} -> ${to}.`,
  );
}

export function getAllowedTicketStatusTransitions(
  from: TicketStatus,
): readonly TicketStatus[] {
  return VALID_TRANSITIONS[from];
}
