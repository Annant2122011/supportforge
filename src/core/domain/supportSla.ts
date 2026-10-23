export type SlaProgress = 'running' | 'warning' | 'paused' | 'met' | 'breached';

export interface SlaLifecycleEvent {
  type: string;
  occurredAt: string;
  payload?: Record<string, unknown>;
}

export interface SlaTargetInput {
  startedAt: string;
  observedAt: string;
  completedAt?: string | null;
  currentStatus: string;
  targetMinutes: number;
  warningRatio: number;
  pauseWhilePending: boolean;
  events: readonly SlaLifecycleEvent[];
}

export interface SlaTargetResult {
  progress: SlaProgress;
  elapsedMinutes: number;
  targetMinutes: number;
  remainingMinutes: number;
  warningAtMinutes: number;
  pausedMinutes: number;
  startedAt: string;
  completedAt: string | null;
}

/** Returns a validated timestamp or null; invalid DB/legacy values must not produce NaN reports. */
function timestamp(value: string | null | undefined): number | null {
  if (!value || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventChangesToPending(event: SlaLifecycleEvent): boolean {
  return event.type === 'ticket.pending' || event.payload?.to === 'pending';
}

function eventResumesFromPending(event: SlaLifecycleEvent): boolean {
  return event.type === 'ticket.resumed' ||
    (event.type === 'ticket.status_changed' && event.payload?.from === 'pending' && event.payload?.to !== 'pending') ||
    (event.type === 'ticket.reopened' && event.payload?.from === 'pending');
}

function pausedDurationMs(
  startMs: number,
  endMs: number,
  events: readonly SlaLifecycleEvent[],
  pauseWhilePending: boolean,
): number {
  if (!pauseWhilePending || endMs <= startMs) return 0;
  const ordered = events
    .map((event) => ({ event, at: timestamp(event.occurredAt) }))
    .filter((entry): entry is { event: SlaLifecycleEvent; at: number } =>
      entry.at !== null && entry.at >= startMs && entry.at <= endMs,
    )
    .sort((a, b) => a.at - b.at);
  let pauseStartedAt: number | null = null;
  let total = 0;
  for (const { event, at } of ordered) {
    if (eventChangesToPending(event)) {
      if (pauseStartedAt === null) pauseStartedAt = at;
      continue;
    }
    if (eventResumesFromPending(event) && pauseStartedAt !== null) {
      total += Math.max(0, at - pauseStartedAt);
      pauseStartedAt = null;
    }
  }
  if (pauseStartedAt !== null) total += Math.max(0, endMs - pauseStartedAt);
  return Math.min(Math.max(0, endMs - startMs), total);
}

function resolutionStart(input: SlaTargetInput): number | null {
  const created = timestamp(input.startedAt);
  if (created === null) return null;
  const reopened = input.events
    .map((event) => ({ event, at: timestamp(event.occurredAt) }))
    .filter((entry): entry is { event: SlaLifecycleEvent; at: number } =>
      entry.at !== null &&
      entry.at >= created &&
      entry.at <= (timestamp(input.completedAt ?? undefined) ?? timestamp(input.observedAt) ?? Number.MAX_SAFE_INTEGER) &&
      (entry.event.type === 'ticket.reopened' || entry.event.payload?.to === 'reopened'),
    )
    .sort((a, b) => b.at - a.at)[0];
  return reopened?.at ?? created;
}

/**
 * Deterministic elapsed-clock calculation for a first-response or resolution target.
 * Pending intervals pause the SLA when configured. Reopening resets the resolution clock.
 */
export function evaluateSlaTarget(input: SlaTargetInput): SlaTargetResult {
  const baseStart = timestamp(input.startedAt);
  const end = timestamp(input.completedAt ?? undefined) ?? timestamp(input.observedAt);
  const targetMinutes = Number.isFinite(input.targetMinutes)
    ? Math.min(43200, Math.max(1, Math.floor(input.targetMinutes)))
    : 1;
  const warningRatio = Number.isFinite(input.warningRatio)
    ? Math.min(0.99, Math.max(0.5, input.warningRatio))
    : 0.8;

  if (baseStart === null || end === null || end < baseStart) {
    return {
      progress: 'running',
      elapsedMinutes: 0,
      targetMinutes,
      remainingMinutes: targetMinutes,
      warningAtMinutes: Math.ceil(targetMinutes * warningRatio),
      pausedMinutes: 0,
      startedAt: input.startedAt,
      completedAt: input.completedAt ?? null,
    };
  }

  const start = input.completedAt !== undefined && input.completedAt !== null
    ? (resolutionStart(input) ?? baseStart)
    : input.currentStatus === 'closed' || input.currentStatus === 'archived'
      ? (resolutionStart(input) ?? baseStart)
      : baseStart;
  const safeStart = Math.min(end, Math.max(baseStart, start));
  const pausedMs = pausedDurationMs(safeStart, end, input.events, input.pauseWhilePending);
  const elapsedMinutes = Math.max(0, Math.floor((end - safeStart - pausedMs) / 60_000));
  const isPending = input.currentStatus === 'pending';
  const completed = input.completedAt !== undefined && input.completedAt !== null;
  const progress: SlaProgress = completed
    ? elapsedMinutes <= targetMinutes ? 'met' : 'breached'
    : isPending && input.pauseWhilePending
      ? 'paused'
      : elapsedMinutes >= targetMinutes
        ? 'breached'
        : elapsedMinutes >= targetMinutes * warningRatio
          ? 'warning'
          : 'running';

  return {
    progress,
    elapsedMinutes,
    targetMinutes,
    remainingMinutes: Math.max(0, targetMinutes - elapsedMinutes),
    warningAtMinutes: Math.ceil(targetMinutes * warningRatio),
    pausedMinutes: Math.floor(pausedMs / 60_000),
    startedAt: new Date(safeStart).toISOString(),
    completedAt: input.completedAt ?? null,
  };
}

export function isValidSlaScope(departmentId: string, priority: string): boolean {
  return (departmentId === '*' || /^[a-zA-Z0-9_-]{1,80}$/.test(departmentId)) &&
    (priority === '*' || ['low', 'normal', 'high', 'urgent', 'critical'].includes(priority));
}
