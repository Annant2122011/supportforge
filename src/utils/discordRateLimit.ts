/**
 * Normalize Discord's rate-limit cooldown values to milliseconds.
 *
 * discord.js exposes RateLimitError.retryAfter in milliseconds; raw Discord
 * payloads and Retry-After headers express the duration in seconds. Keep those
 * units explicit so a long cooldown is never accidentally shortened.
 */
export function getDiscordRetryAfterMs(error: unknown): number | null {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;

    const milliseconds = Number(record.retryAfter);
    if (record.retryAfter !== undefined && Number.isFinite(milliseconds) && milliseconds > 0) {
      return Math.ceil(milliseconds);
    }

    const data = record.data as Record<string, unknown> | undefined;
    const rawError = record.rawError as Record<string, unknown> | undefined;
    const secondsCandidates = [
      record.retry_after,
      data?.retry_after,
      rawError?.retry_after,
    ];

    for (const candidate of secondsCandidates) {
      const seconds = Number(candidate);
      if (candidate !== undefined && Number.isFinite(seconds) && seconds > 0) {
        return Math.ceil(seconds * 1000);
      }
    }

    const headers = record.headers as { get?: (name: string) => string | null } | undefined;
    if (headers && typeof headers.get === 'function') {
      const headerSeconds = Number(headers.get('retry-after'));
      if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
        return Math.ceil(headerSeconds * 1000);
      }
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const milliseconds = message.match(/retry(?:\s+after|After)[=: ]+\s*(\d+(?:\.\d+)?)\s*ms/i);
  if (milliseconds) {
    const value = Number(milliseconds[1]);
    return Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
  }

  const seconds = message.match(/(?:retry(?:\s+after|After)[=: ]+|another\s+)(\d+(?:\.\d+)?)\s*s\b/i);
  if (seconds) {
    const value = Number(seconds[1]) * 1000;
    return Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
  }

  return null;
}
