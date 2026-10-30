import { EmbedBuilder } from 'discord.js';

import type { CsatInsightsReport } from '../core/domain/csatReporting';
import { translate } from '../i18n/translationService';

function pct(value: number | null): string {
  return value === null ? 'N/A (no denominator)' : value.toFixed(1) + '%';
}

function metric(value: number | null): string {
  return value === null ? 'Suppressed / not available' : value.toFixed(2) + '/5';
}

function delta(value: number | null, suffix = ''): string {
  if (value === null) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return sign + value.toFixed(1) + suffix;
}

/** Manager-facing aggregate view. It intentionally never renders customer names, IDs or comments. */
export function buildCsatInsightsEmbed(
  report: CsatInsightsReport,
  color: number,
  locale: unknown = 'en-US',
): EmbedBuilder {
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(locale, key, values);
  const current = report.current.counts;
  const previous = report.previous.counts;
  const dateRange = report.current.startAt.slice(0, 10) + ' → ' + report.current.endAt.slice(0, 10);
  const lines = [
    '**' + t('csat.report.window') + ':** ' + dateRange + ' (' + report.days + ' days)',
    '**' + t('csat.report.eligible') + ':** ' + current.eligibleTickets,
    '**' + t('csat.report.delivery') + ':** ' + current.invitationsSent + ' / ' +
      current.eligibleTickets + ' (' + pct(current.coveragePercent) + ')',
    '**' + t('csat.report.responses') + ':** ' + current.surveyResponses + ' / ' +
      current.invitationsSent + ' (' + pct(current.responseRatePercent) + ')',
    '**' + t('csat.report.ratings') + ':** ' + current.ratings,
    '**' + t('csat.report.average') + ':** ' + metric(current.averageRating),
    '**' + t('csat.report.distribution') + ':** ' +
      t('csat.report.positive') + ': ' + (current.positive ?? '—') + ' • ' +
      t('csat.report.neutral') + ': ' + (current.neutral ?? '—') + ' • ' +
      t('csat.report.negative') + ': ' + (current.negative ?? '—'),
    '**' + t('csat.report.queue') + ':** ' +
      current.queued + ' / ' + current.failed + ' / ' + current.retryExhausted + ' / ' + current.expired,
    '',
    '**' + t('csat.report.previous') + ':** average ' +
      delta(report.comparison.averageRatingChange) + ' • survey responses ' +
      delta(report.comparison.surveyResponsesChange) + ' • response rate ' +
      delta(report.comparison.responseRateChange, ' pp'),
    '',
    t('csat.report.privacy', { minimum: report.minimumCohortSize }),
  ];
  if (report.groupBy && report.groups.length) {
    lines.push('', '**' + t('csat.report.group') + ' • ' + report.groupBy + '**');
    for (const group of report.groups.slice(0, 6)) {
      lines.push('• **' + group.label.slice(0, 80) + '**: ' +
        group.surveyResponses + '/' + group.invitationsSent + ' responses (' +
        pct(group.responseRatePercent) + '), ' + metric(group.averageRating));
    }
  } else if (report.groupBy) {
    lines.push('', t('csat.report.suppressed'));
  }
  const description = lines.join('\n').slice(0, 3900);
  return new EmbedBuilder()
    .setColor(color)
    .setTitle('⭐ ' + t('csat.report.title'))
    .setDescription(description)
    .setFooter({ text: 'QueryFixr • Delivered-response rate = survey responses ÷ invitations sent. Coverage = invitations sent ÷ eligible closures.' })
    .setTimestamp(new Date(report.generatedAt));
}
