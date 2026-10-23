export type OperationalTaskId =
  | 'outbox-processor'
  | 'ticket-retention'
  | 'ticket-inactivity'
  | 'audit-daily-summary'
  | 'github-update-monitor'
  | 'ticket-form-cache-refresh'
  | 'ticket-form-submission-recovery'
  | 'ticket-archive-backfill'
  | 'startup-reconciliation'
  | 'developer-audit-reconciliation';

export type OperationalTaskSeverity = 'ok' | 'info' | 'warning' | 'error';

export interface OperationalTaskFinding {
  area: string;
  severity: OperationalTaskSeverity;
  title: string;
  detail: string;
  remedy?: string;
}

interface OperationalTaskDefinition {
  label: string;
  scope: 'process' | 'guild';
  staleAfterMs: number | null;
  intervalHint: string;
  remedy: string;
}

interface OperationalTaskState {
  running: boolean;
  startedAt: number | null;
  lastFinishedAt: number | null;
  lastSucceededAt: number | null;
  lastFailedAt: number | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  lastErrorType: string | null;
  lastOutcome: 'success' | 'failure' | 'skipped' | null;
  skipReason: string | null;
}

const DEFINITIONS: Record<OperationalTaskId, OperationalTaskDefinition> = {
  'outbox-processor': {
    label: 'Durable outbox processor',
    scope: 'process',
    staleAfterMs: 60_000,
    intervalHint: 'about every 5 seconds',
    remedy: 'Inspect the outbox worker and PostgreSQL logs, then use the existing retry/reconciliation workflow. Do not delete outbox rows to clear an alert.',
  },
  'ticket-retention': {
    label: 'Ticket retention sweep',
    scope: 'guild',
    staleAfterMs: 3 * 60 * 60_000,
    intervalHint: 'about hourly',
    remedy: 'Inspect the retention scheduler logs and policy approval state. Do not run deletion manually without reviewing the pending approval.',
  },
  'ticket-inactivity': {
    label: 'Ticket inactivity sweep',
    scope: 'guild',
    staleAfterMs: 30 * 60_000,
    intervalHint: 'periodically while the bot is ready',
    remedy: 'Inspect the inactivity scheduler and database/Discord errors. Verify the durable warning anchor and exemptions before attempting closure.',
  },
  'audit-daily-summary': {
    label: 'Daily audit-summary reconciliation',
    scope: 'guild',
    staleAfterMs: 27 * 60 * 60_000,
    intervalHint: 'at startup and after completed UTC days',
    remedy: 'Inspect the audit scheduler and destination permissions; only completed UTC days should be published.',
  },
  'github-update-monitor': {
    label: 'GitHub update monitor',
    scope: 'process',
    staleAfterMs: 45 * 60_000,
    intervalHint: 'about every 15 minutes',
    remedy: 'Check network access to the repository commits endpoint and the push-triggered deployment workflow. UI refresh alone does not deploy new code.',
  },
  'ticket-form-cache-refresh': {
    label: 'Active ticket-form cache refresh',
    scope: 'process',
    staleAfterMs: 2 * 60_000,
    intervalHint: 'about every 30 seconds',
    remedy: 'Inspect PostgreSQL form catalog/schema state and cache refresh logs. The last-known-good cache is retained on refresh failure.',
  },
  'ticket-form-submission-recovery': {
    label: 'Pending ticket-form submission recovery',
    scope: 'process',
    staleAfterMs: 5 * 60_000,
    intervalHint: 'about every 60 seconds',
    remedy: 'Inspect pending/failed form submissions and ticket reconstruction logs; retain answers and status until recovery is verified.',
  },
  'ticket-archive-backfill': {
    label: 'Ticket archive backfill',
    scope: 'process',
    staleAfterMs: 2 * 60_000,
    intervalHint: 'about every 15 seconds',
    remedy: 'Inspect archive cursors, Discord message-history permissions and PostgreSQL logs. Do not mark a backfill complete manually.',
  },
  'startup-reconciliation': {
    label: 'Managed-resource startup reconciliation',
    scope: 'guild',
    staleAfterMs: null,
    intervalHint: 'once per process startup for previously configured guilds',
    remedy: 'Inspect the startup reconciliation log and run the existing Setup/Repair workflow after reviewing resource ownership.',
  },
  'developer-audit-reconciliation': {
    label: 'Developer-audit infrastructure reconciliation',
    scope: 'guild',
    staleAfterMs: null,
    intervalHint: 'once per process startup when developer-audit setup exists',
    remedy: 'Inspect the developer-audit configuration and its managed parent/category references; do not adopt or rename unrelated channels.',
  },
};

const states = new Map<string, OperationalTaskState>();

function stateKey(task: OperationalTaskId, guildId?: string | null): string {
  const definition = DEFINITIONS[task];
  return task + ':' + (definition.scope === 'guild' ? (guildId ?? 'unknown-guild') : 'process');
}

function stateFor(task: OperationalTaskId, guildId?: string | null): OperationalTaskState {
  const key = stateKey(task, guildId);
  let state = states.get(key);
  if (!state) {
    state = {
      running: false,
      startedAt: null,
      lastFinishedAt: null,
      lastSucceededAt: null,
      lastFailedAt: null,
      lastDurationMs: null,
      consecutiveFailures: 0,
      lastErrorType: null,
      lastOutcome: null,
      skipReason: null,
    };
    states.set(key, state);
  }
  return state;
}

export function recordOperationalTaskStarted(
  task: OperationalTaskId,
  guildId?: string | null,
  now = Date.now(),
): void {
  if (!Number.isFinite(now)) return;
  const state = stateFor(task, guildId);
  state.running = true;
  state.startedAt = now;
  state.skipReason = null;
  state.lastOutcome = null;
}

export function recordOperationalTaskSucceeded(
  task: OperationalTaskId,
  guildId?: string | null,
  now = Date.now(),
): void {
  if (!Number.isFinite(now)) return;
  const state = stateFor(task, guildId);
  const start = state.startedAt ?? now;
  state.running = false;
  state.lastFinishedAt = now;
  state.lastSucceededAt = now;
  state.lastDurationMs = Math.max(0, now - start);
  state.consecutiveFailures = 0;
  state.lastErrorType = null;
  state.lastOutcome = 'success';
  state.skipReason = null;
}

export function recordOperationalTaskFailed(
  task: OperationalTaskId,
  guildId?: string | null,
  error?: unknown,
  now = Date.now(),
): void {
  if (!Number.isFinite(now)) return;
  const state = stateFor(task, guildId);
  const start = state.startedAt ?? now;
  state.running = false;
  state.lastFinishedAt = now;
  state.lastFailedAt = now;
  state.lastDurationMs = Math.max(0, now - start);
  state.consecutiveFailures += 1;
  // Store only the class/name, never a raw database/API error that may contain secrets.
  state.lastErrorType = error instanceof Error ? error.name.slice(0, 60) : 'UnknownError';
  state.lastOutcome = 'failure';
  state.skipReason = null;
}

export function recordOperationalTaskSkipped(
  task: OperationalTaskId,
  guildId: string | null,
  reason: string,
  now = Date.now(),
): void {
  if (!Number.isFinite(now)) return;
  const state = stateFor(task, guildId);
  state.running = false;
  state.startedAt = null;
  state.lastFinishedAt = now;
  state.lastOutcome = 'skipped';
  state.skipReason = reason.trim().slice(0, 120) || 'Not required for this guild';
}

export async function runTrackedOperationalTask<T>(
  task: OperationalTaskId,
  guildId: string | null,
  operation: () => Promise<T>,
): Promise<T> {
  recordOperationalTaskStarted(task, guildId);
  try {
    const result = await operation();
    recordOperationalTaskSucceeded(task, guildId);
    return result;
  } catch (error) {
    recordOperationalTaskFailed(task, guildId, error);
    throw error;
  }
}

export function getOperationalTaskFindings(
  guildId: string,
  now = Date.now(),
): OperationalTaskFinding[] {
  const findings: OperationalTaskFinding[] = [];
  for (const [task, definition] of Object.entries(DEFINITIONS) as Array<[OperationalTaskId, OperationalTaskDefinition]>) {
    if (definition.scope === 'guild' && !guildId) continue;
    const state = states.get(stateKey(task, guildId));
    const remedy = definition.remedy;
    if (!state || state.lastOutcome === null) {
      findings.push({
        area: 'Operational tasks',
        severity: 'info',
        title: definition.label + ' has no observed run',
        detail: 'Expected ' + definition.intervalHint + '. Task telemetry is process-local and resets after restart; absence is unknown, not proof that the task is broken or healthy.',
        remedy,
      });
      continue;
    }

    if (state.lastOutcome === 'skipped') {
      findings.push({
        area: 'Operational tasks',
        severity: 'info',
        title: definition.label + ' was not required',
        detail: 'The last startup check skipped this task: ' + (state.skipReason ?? 'not applicable') + '.',
        remedy: undefined,
      });
      continue;
    }

    const runAgeMs = state.lastFinishedAt === null ? null : Math.max(0, now - state.lastFinishedAt);
    if (state.running) {
      const runningAgeMs = state.startedAt === null ? 0 : Math.max(0, now - state.startedAt);
      const stale = definition.staleAfterMs !== null && runningAgeMs > definition.staleAfterMs;
      findings.push({
        area: 'Operational tasks',
        severity: stale ? 'warning' : state.consecutiveFailures >= 3 ? 'error' : 'info',
        title: definition.label + (stale ? ' may be stuck' : ' is running'),
        detail: 'Current run age is about ' + Math.floor(runningAgeMs / 1000) + ' second(s); last successful run ' +
          (state.lastSucceededAt === null ? 'has not been observed' : Math.floor(Math.max(0, now - state.lastSucceededAt) / 1000) + ' second(s) ago') + '.',
        remedy,
      });
      continue;
    }

    if (state.consecutiveFailures > 0) {
      findings.push({
        area: 'Operational tasks',
        severity: state.consecutiveFailures >= 3 ? 'error' : 'warning',
        title: definition.label + ' recently failed',
        detail: state.consecutiveFailures + ' consecutive failure(s); last failure ' +
          (state.lastFailedAt === null ? 'time unknown' : Math.floor(Math.max(0, now - state.lastFailedAt) / 1000) + ' second(s) ago') +
          '; error type=' + (state.lastErrorType ?? 'UnknownError') + '. Raw error text is intentionally not retained.',
        remedy,
      });
      continue;
    }

    const stale = definition.staleAfterMs !== null && runAgeMs !== null && runAgeMs > definition.staleAfterMs;
    findings.push({
      area: 'Operational tasks',
      severity: stale ? 'warning' : 'ok',
      title: definition.label + (stale ? ' is overdue' : ' is responding'),
      detail: 'Last outcome was successful ' + (runAgeMs === null ? 'at an unknown time' : Math.floor(runAgeMs / 1000) + ' second(s) ago') +
        '; duration was ' + (state.lastDurationMs === null ? 'unknown' : state.lastDurationMs + ' ms') +
        '. Expected ' + definition.intervalHint + '.',
      remedy: stale ? remedy : undefined,
    });
  }
  return findings;
}

/** Deterministic test seam; never called by normal runtime code. */
export function resetOperationalTaskTelemetryForTests(): void {
  states.clear();
}
