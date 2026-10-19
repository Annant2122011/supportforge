export type CustomPanelInteractionAction = 'start' | 'confirm' | 'cancel';

export interface ParsedCustomPanelInteractionId {
  action: CustomPanelInteractionAction;
  panelId: string;
  buttonId: string;
  /** Published public message that the click originated from. Required for confirm/cancel. */
  sourceMessageId?: string;
  /** User who initiated the ephemeral confirmation. Required for confirm/cancel. */
  promptOwnerId?: string;
}

const PANEL_ID = /^[a-f0-9]{12}$/i;
const BUTTON_ID = /^[a-zA-Z0-9_-]{4,40}$/;
const DISCORD_ID = /^\d{17,20}$/;

/**
 * Parse and validate a custom panel component ID. Confirmation IDs carry the
 * original public message and initiating user so a private confirmation cannot
 * be replayed against another published panel or by another user.
 */
export function parseCustomPanelInteractionId(customId: string): ParsedCustomPanelInteractionId | null {
  const parts = customId.split(':');
  if (parts[0] !== 'ticket' || parts[1] !== 'custom') return null;

  const action = parts[2] ?? '';
  if (action === 'confirm' || action === 'cancel') {
    if (parts.length !== 7) return null;
    const panelId = parts[3] ?? '';
    const buttonId = parts[4] ?? '';
    const sourceMessageId = parts[5] ?? '';
    const promptOwnerId = parts[6] ?? '';
    if (!PANEL_ID.test(panelId) || !BUTTON_ID.test(buttonId) ||
        !DISCORD_ID.test(sourceMessageId) || !DISCORD_ID.test(promptOwnerId)) {
      return null;
    }
    return { action, panelId, buttonId, sourceMessageId, promptOwnerId };
  }

  // Public panel buttons contain no action segment: ticket:custom:<panel>:<button>
  if (parts.length !== 4) return null;
  const panelId = parts[2] ?? '';
  const buttonId = parts[3] ?? '';
  if (!PANEL_ID.test(panelId) || !BUTTON_ID.test(buttonId)) return null;
  return { action: 'start', panelId, buttonId };
}
