export type TicketRoutingComponentRoute =
  | 'department-select'
  | 'department-navigation'
  | 'routing-tag-select'
  | 'routing-tag-navigation'
  | 'none';

/**
 * Classifies the department/tag selector custom IDs so the interaction
 * dispatcher cannot accidentally leave these controls unacknowledged.
 */
export function classifyTicketRoutingComponent(customId: string): TicketRoutingComponentRoute {
  if (customId === 'ticket:department:select') return 'department-select';

  if (
    customId === 'ticket:department:cancel' ||
    /^ticket:department:page:-?\d+$/.test(customId)
  ) {
    return 'department-navigation';
  }

  if (customId.startsWith('ticket:routing-tag:select:')) {
    return 'routing-tag-select';
  }

  if (
    customId === 'ticket:routing-tag:cancel' ||
    /^ticket:routing-tag:page:-?\d+:[^:]+$/.test(customId)
  ) {
    return 'routing-tag-navigation';
  }

  return 'none';
}
