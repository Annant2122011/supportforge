import type { TicketStatus } from './ticketLifecycle';

export type TicketAuthorizationAction =
  | 'claim' | 'unclaim' | 'pending' | 'resume' | 'close'
  | 'reopen' | 'archive' | 'manage' | 'delete';

export interface TicketAuthorizationContext {
  actorId: string;
  ownerId?: string | null;
  isConfiguredStaff: boolean;
  isAdministrator: boolean;
  canManageGuild?: boolean;
  canManageChannels?: boolean;
}

export function isTicketManager(context: TicketAuthorizationContext): boolean {
  return context.isConfiguredStaff || context.isAdministrator || Boolean(context.canManageGuild);
}

/** Shared authorization rules for text-channel and private-thread lifecycle actions. */
export function canPerformTicketAction(
  context: TicketAuthorizationContext,
  action: TicketAuthorizationAction,
  currentStatus?: TicketStatus,
): boolean {
  const manager = isTicketManager(context);
  if (action === 'delete') return manager || Boolean(context.canManageChannels);
  if (action === 'close') return manager || Boolean(context.ownerId && context.ownerId === context.actorId);
  if (action === 'resume') {
    return manager || Boolean(
      currentStatus === 'pending' && context.ownerId && context.ownerId === context.actorId,
    );
  }
  return manager;
}
