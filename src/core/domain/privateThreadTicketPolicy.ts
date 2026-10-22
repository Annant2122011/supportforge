import type { TicketStatus } from './ticketLifecycle';

export type TicketWorkspaceMode = 'text-channels' | 'private-threads';
export type PrivateThreadTicketAction = 'claim' | 'unclaim' | 'pending' | 'resume' | 'close' | 'reopen' | 'archive';

export function normalizeTicketWorkspaceMode(value: unknown): TicketWorkspaceMode {
  return value === 'private-threads' ? 'private-threads' : 'text-channels';
}

export function getPrivateThreadTicketActions(status: TicketStatus): readonly PrivateThreadTicketAction[] {
  switch (status) {
    case 'open':
    case 'reopened':
      return ['claim', 'pending', 'close'];
    case 'claimed':
      return ['claim', 'unclaim', 'pending', 'close'];
    case 'pending':
      return ['resume', 'close'];
    case 'closed':
      return ['reopen', 'archive'];
    case 'archived':
      return [];
    default:
      // Persisted state can outlive a code version. Unknown values must not
      // expose controls or make canPrivateThreadTicketAction throw at runtime.
      return [];
  }
}

export function canPrivateThreadTicketAction(
  status: TicketStatus,
  action: PrivateThreadTicketAction,
): boolean {
  return getPrivateThreadTicketActions(status).includes(action);
}
