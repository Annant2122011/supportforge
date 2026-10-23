/**
 * Validate Discord snowflake IDs used in persisted configuration.
 *
 * IDs are intentionally handled as strings to avoid integer precision loss.
 * The helper is deliberately pure so configuration migrations can be tested
 * without a Discord network connection.
 */
export function normalizeDiscordSnowflakeIds(value: unknown, limit = 25): string[] {
  if (!Array.isArray(value) || !Number.isInteger(limit) || limit < 0) return [];
  return [...new Set(
    value.filter((id): id is string => typeof id === 'string' && /^\d{17,20}$/.test(id)),
  )].slice(0, limit);
}
