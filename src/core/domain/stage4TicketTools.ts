export interface TicketToolsAuthorizationInput {
  isAdmin: boolean;
  isAnyDepartmentStaff: boolean;
  isCurrentDepartmentStaff: boolean;
  ticketIsActive: boolean;
  ticketIsDeleted: boolean;
}

export interface TicketToolsAuthorization {
  canSearchPublicKnowledge: boolean;
  canSearchStaffKnowledge: boolean;
  canUseQuickReplies: boolean;
  canManageRelatedTickets: boolean;
  canInspectWorkflowHistory: boolean;
}

/**
 * Keep public self-service available without granting staff tools to ticket owners.
 * All menu actions must be evaluated again against current persisted ticket state.
 */
export function evaluateTicketToolsAuthorization(input: TicketToolsAuthorizationInput): TicketToolsAuthorization {
  const ticketAvailable = input.ticketIsActive && !input.ticketIsDeleted;
  const staff = ticketAvailable && (input.isAdmin || input.isAnyDepartmentStaff);
  const ticketStaff = ticketAvailable && (input.isAdmin || input.isCurrentDepartmentStaff);
  const admin = ticketAvailable && input.isAdmin;
  return {
    canSearchPublicKnowledge: ticketAvailable,
    canSearchStaffKnowledge: staff,
    canUseQuickReplies: ticketStaff,
    canManageRelatedTickets: admin,
    canInspectWorkflowHistory: admin,
  };
}

export function isStage4TicketToolsCustomId(customId: string): boolean {
  return customId === 'ticket:stage4:tools' || customId.startsWith('ticket:stage4:tools:');
}
