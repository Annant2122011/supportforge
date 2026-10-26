import {
  PostgresAnalyticsRepository,
  type AnalyticsRollup,
} from '../repositories/postgresAnalyticsRepository';

export const ANALYTICS_PERIODS = [7, 30, 90] as const;
export type AnalyticsPeriodDays = (typeof ANALYTICS_PERIODS)[number];

export interface GuildAnalyticsSummary extends AnalyticsRollup {
  guildId: string;
  periodDays: AnalyticsPeriodDays;
  periodStartAt: string;
  periodEndAt: string;
  generatedAt: string;
  reopenRatePercent: number | null;
}

function isAnalyticsPeriod(value: number): value is AnalyticsPeriodDays {
  return (ANALYTICS_PERIODS as readonly number[]).includes(value);
}

export async function getGuildAnalyticsSummary(
  guildId: string,
  periodDays: AnalyticsPeriodDays,
  now = new Date(),
  repository = new PostgresAnalyticsRepository(),
  filters: import('../repositories/postgresAnalyticsRepository').AnalyticsFilters = {},
): Promise<GuildAnalyticsSummary> {
  if (!guildId.trim()) {
    throw new Error('A guild ID is required to generate analytics.');
  }
  if (!isAnalyticsPeriod(periodDays)) {
    throw new Error('Analytics period must be 7, 30, or 90 days.');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Analytics report time must be a valid date.');
  }

  const end = new Date(now.getTime());
  const start = new Date(end.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const periodStartAt = start.toISOString();
  const periodEndAt = end.toISOString();
  const rollup = await repository.getGuildRollup(
    guildId,
    periodStartAt,
    periodEndAt,
    filters,
  );

  const reopenRatePercent = rollup.firstResolvedTickets > 0
    ? Math.round(
        (rollup.reopenedAfterFirstClose / rollup.firstResolvedTickets) * 10_000,
      ) / 100
    : null;

  return {
    ...rollup,
    guildId,
    periodDays,
    periodStartAt,
    periodEndAt,
    generatedAt: end.toISOString(),
    reopenRatePercent,
  };
}

export function parseAnalyticsPeriod(value: string | null | undefined): AnalyticsPeriodDays {
  if (value === undefined || value === null || value === '7d') return 7;
  if (value === '30d') return 30;
  if (value === '90d') return 90;
  throw new Error('Analytics period must be 7d, 30d, or 90d.');
}
