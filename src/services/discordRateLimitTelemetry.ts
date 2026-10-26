export interface DiscordRateLimitObservation {
  method: string;
  route: string;
  scope: string;
  retryAfterMs: number;
  global: boolean;
  sublimitTimeoutMs?: number | null;
  observedAt?: number;
}

export interface DiscordRateLimitSummary {
  windowMinutes: number;
  eventCount: number;
  globalEventCount: number;
  longestRetryAfterMs: number;
  topRoutes: Array<{ route: string; count: number }>;
}

interface StoredRateLimitObservation {
  at: number;
  method: string;
  route: string;
  scope: string;
  retryAfterMs: number;
  global: boolean;
  sublimitTimeoutMs: number | null;
}

const WINDOW_MS = 15 * 60_000;
const MAX_RECORDED_EVENTS = 500;
const observations: StoredRateLimitObservation[] = [];

function cleanRoute(route: string): string {
  // Routes should already be normalized by discord.js. Remove any unexpected
  // raw snowflake IDs so the diagnostics report stays compact and low-sensitivity.
  return route
    .split('?')[0]
    .replace(/\d{17,20}/g, ':id')
    .slice(0, 140);
}

export function recordDiscordRateLimit(
  event: DiscordRateLimitObservation,
  now = Date.now(),
): void {
  if (!Number.isFinite(now)) return;
  const method = typeof event.method === 'string' ? event.method.toUpperCase().slice(0, 12) : 'UNKNOWN';
  const route = typeof event.route === 'string' ? cleanRoute(event.route) : 'unknown route';
  const scope = typeof event.scope === 'string' ? event.scope.slice(0, 40) : 'unknown';
  const retryAfterMs = Number.isFinite(event.retryAfterMs) ? Math.max(0, event.retryAfterMs) : 0;
  const sublimitTimeoutMs = Number.isFinite(event.sublimitTimeoutMs) ? Math.max(0, Number(event.sublimitTimeoutMs)) : null;

  observations.push({
    at: Number.isFinite(event.observedAt) ? Number(event.observedAt) : now,
    method,
    route,
    scope,
    retryAfterMs,
    global: event.global === true,
    sublimitTimeoutMs,
  });

  const cutoff = now - WINDOW_MS;
  while (observations.length && (observations[0]!.at < cutoff || observations.length > MAX_RECORDED_EVENTS)) {
    observations.shift();
  }
}

export function getDiscordRateLimitSummary(now = Date.now()): DiscordRateLimitSummary {
  const cutoff = now - WINDOW_MS;
  const recent = observations.filter((event) => event.at >= cutoff && event.at <= now);
  const counts = new Map<string, number>();
  for (const event of recent) {
    const key = event.method + ' ' + event.route;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return {
    windowMinutes: WINDOW_MS / 60_000,
    eventCount: recent.length,
    globalEventCount: recent.filter((event) => event.global).length,
    longestRetryAfterMs: recent.reduce((max, event) => Math.max(max, event.retryAfterMs, event.sublimitTimeoutMs ?? 0), 0),
    topRoutes: [...counts.entries()]
      .map(([route, count]) => ({ route, count }))
      .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route))
      .slice(0, 3),
  };
}

/** Test seam. Production code should never reset telemetry during normal operation. */
export function resetDiscordRateLimitTelemetryForTests(): void {
  observations.length = 0;
}
