export type CsatInsightGroupBy = 'department' | 'tag' | 'priority';

export interface CsatInsightFilters {
  departmentId?: string;
  tagId?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent' | 'critical';
}

export interface CsatInsightCounts {
  eligibleTickets: number;
  surveyLedgerEntries: number;
  invitationsSent: number;
  queued: number;
  failed: number;
  retryExhausted: number;
  expired: number;
  ratings: number;
  surveyResponses: number;
  averageRating: number | null;
  positive: number | null;
  neutral: number | null;
  negative: number | null;
  responseRatePercent: number | null;
  coveragePercent: number | null;
  ratingsSuppressed: boolean;
}

export interface CsatInsightGroup extends CsatInsightCounts {
  id: string;
  label: string;
}

export interface CsatInsightPeriod {
  startAt: string;
  endAt: string;
  counts: CsatInsightCounts;
}

export interface CsatInsightsReport {
  guildId: string;
  days: number;
  generatedAt: string;
  filters: CsatInsightFilters;
  groupBy: CsatInsightGroupBy | null;
  minimumCohortSize: number;
  current: CsatInsightPeriod;
  previous: CsatInsightPeriod;
  comparison: {
    averageRatingChange: number | null;
    surveyResponsesChange: number | null;
    responseRateChange: number | null;
  };
  groups: CsatInsightGroup[];
  suppressedGroupCount: number;
}

export function calculateCsatPercentage(numerator: number, denominator: number): number | null {
  if (!Number.isSafeInteger(numerator) || numerator < 0 ||
      !Number.isSafeInteger(denominator) || denominator < 0 || numerator > denominator && denominator > 0) {
    throw new Error('CSAT percentages require non-negative whole counts and a valid denominator.');
  }
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function isCsatCohortVisible(responseCount: number, minimumCohortSize: number): boolean {
  if (!Number.isSafeInteger(responseCount) || responseCount < 0 ||
      !Number.isSafeInteger(minimumCohortSize) || minimumCohortSize < 1 || minimumCohortSize > 100) {
    throw new Error('CSAT cohort sizes must be whole numbers; the privacy threshold must be from 1 to 100.');
  }
  return responseCount >= minimumCohortSize;
}

export function compareCsatMetric(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return Math.round((current - previous) * 10) / 10;
}

export function neutralizeCsatCsvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[\\t\\r\\n ]*[=+\\-@]/.test(text)) text = "'" + text;
  if (/[",\\r\\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

export const MAX_CSAT_EXPORT_ROWS = 1_000;
export const MAX_CSAT_EXPORT_CHARACTERS = 1_000_000;
