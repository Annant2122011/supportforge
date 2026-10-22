import type { TicketStatus } from './ticketLifecycle';

export interface TicketInactivitySettings {
  enabled: boolean;
  idleHours: number;
  graceHours: number;
}

export interface TicketInactivityState {
  status: TicketStatus;
  priority?: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface HumanActivityCandidate {
  createdAt: string;
  messageId: string;
  authorId: string;
  authorIsBot: boolean;
}

export interface LatestHumanActivity {
  at: string;
  messageId: string;
  authorId: string;
}

/** Find human activity newer than a persisted anchor; bot/system messages never reset inactivity. */
export function findLatestHumanActivityAfter(
  anchorAt: string,
  candidates: readonly HumanActivityCandidate[],
): LatestHumanActivity | null {
  const anchorMs = Date.parse(anchorAt);
  if (!Number.isFinite(anchorMs)) return null;

  let latest: LatestHumanActivity | null = null;
  let latestMs = anchorMs;
  for (const candidate of candidates) {
    if (candidate.authorIsBot) continue;
    const timestamp = Date.parse(candidate.createdAt);
    if (!Number.isFinite(timestamp) || timestamp <= anchorMs) continue;
    if (
      timestamp > latestMs ||
      (timestamp === latestMs && candidate.messageId > (latest?.messageId ?? ''))
    ) {
      latestMs = timestamp;
      latest = {
        at: new Date(timestamp).toISOString(),
        messageId: candidate.messageId,
        authorId: candidate.authorId,
      };
    }
  }
  return latest;
}

export type TicketInactivityDecision =
  | { action: 'skip'; reason: 'disabled' | 'deleted' | 'terminal' | 'invalid-anchor' | 'exempt' }
  | { action: 'wait'; anchorAt: string; warningAt: number }
  | { action: 'warn'; anchorAt: string }
  | { action: 'grace'; anchorAt: string; deadlineAt: string }
  | { action: 'close'; anchorAt: string; deadlineAt: string };

export const ACTIVE_INACTIVITY_STATUSES: readonly TicketStatus[] = [
  'open',
  'claimed',
  'pending',
  'reopened',
];

export function normalizeInactivitySettings(value: Partial<TicketInactivitySettings> | null | undefined): TicketInactivitySettings {
  const integerInRange = (candidate: unknown, fallback: number, min: number, max: number): number => {
    const number = Number(candidate);
    return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  return {
    enabled: value?.enabled === true,
    idleHours: integerInRange(value?.idleHours, 72, 1, 720),
    graceHours: integerInRange(value?.graceHours, 24, 1, 168),
  };
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Activity timestamps are immutable comparison keys for the warning/grace state. */
export function getTicketInactivityAnchor(ticket: Pick<TicketInactivityState, 'createdAt' | 'updatedAt' | 'metadata'>): string | null {
  return canonicalTimestamp(ticket.metadata.lastActivityAt)
    ?? canonicalTimestamp(ticket.updatedAt)
    ?? canonicalTimestamp(ticket.createdAt);
}

export function evaluateTicketInactivity(
  ticket: TicketInactivityState,
  settingsInput: Partial<TicketInactivitySettings> | null | undefined,
  nowMs = Date.now(),
): TicketInactivityDecision {
  const settings = normalizeInactivitySettings(settingsInput);
  if (!settings.enabled) return { action: 'skip', reason: 'disabled' };
  if (ticket.deletedAt) return { action: 'skip', reason: 'deleted' };
  if (!ACTIVE_INACTIVITY_STATUSES.includes(ticket.status)) return { action: 'skip', reason: 'terminal' };
  // Critical tickets and explicitly escalated/staff-exempt tickets must never
  // be closed by inactivity automation.
  if (
    ticket.priority === 'critical' ||
    ticket.metadata.inactivityExempt === true ||
    ticket.metadata.activeEscalation === true ||
    ticket.metadata.vip === true
  ) return { action: 'skip', reason: 'exempt' };

  const anchorAt = getTicketInactivityAnchor(ticket);
  if (!anchorAt) return { action: 'skip', reason: 'invalid-anchor' };
  const anchorMs = Date.parse(anchorAt);
  const warningAt = anchorMs + settings.idleHours * 60 * 60 * 1000;
  if (nowMs < warningAt) return { action: 'wait', anchorAt, warningAt };

  const warningAnchorAt = canonicalTimestamp(ticket.metadata.inactivityWarningAnchorAt);
  const deadlineAt = canonicalTimestamp(ticket.metadata.inactivityWarningDeadlineAt);
  if (warningAnchorAt !== anchorAt || !deadlineAt) return { action: 'warn', anchorAt };

  return nowMs >= Date.parse(deadlineAt)
    ? { action: 'close', anchorAt, deadlineAt }
    : { action: 'grace', anchorAt, deadlineAt };
}
