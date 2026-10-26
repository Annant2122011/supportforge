import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import type { AdvancedAnalyticsReport } from '../services/advancedAnalyticsService';
import { buildAnalyticsEmbed } from './analyticsPresentation';

export type AnalyticsView = 'overview' | 'departments' | 'staff' | 'tags' | 'trends';
export const ANALYTICS_PAGE_SIZE = 10;

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function formatMinutes(value: number | null): string {
  if (value === null) return 'Not enough reliable data yet';
  if (value < 60) return value.toFixed(1) + ' min';
  if (value < 1440) return (value / 60).toFixed(1) + ' hr';
  return (value / 1440).toFixed(1) + ' days';
}

function utc(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function changeLine(label: string, value: { current: number | null; previous: number | null; changePercent: number | null }): string {
  const current = value.current === null ? 'n/a' : String(value.current);
  const previous = value.previous === null ? 'n/a' : String(value.previous);
  const change = value.changePercent === null
    ? 'change unavailable'
    : (value.changePercent > 0 ? '+' : '') + value.changePercent.toFixed(1) + '%';
  return label + ': **' + current + '** vs **' + previous + '** (' + change + ')';
}

function filterDescription(report: AdvancedAnalyticsReport): string {
  const filters: string[] = [];
  if (report.filters.departmentId) filters.push('department=' + report.filters.departmentId);
  if (report.filters.tagId) filters.push('tag=' + report.filters.tagId);
  if (report.filters.priority) filters.push('priority=' + report.filters.priority);
  if (report.filters.status) filters.push('status=' + report.filters.status);
  return '**Window:** ' + utc(report.periodStartAt) + ' to ' + utc(report.periodEndAt) +
    '\n**Filters:** ' + (filters.length ? filters.join(' · ') : 'none') +
    '\nCurrent queue status is a live snapshot; time-based totals use persisted events.';
}

function overview(report: AdvancedAnalyticsReport): EmbedBuilder {
  return buildAnalyticsEmbed(report.summary)
    .setDescription(filterDescription(report))
    .addFields(
      {
        name: 'Previous equal-length period',
        value: [
          changeLine('Created', report.comparisons.ticketsCreated),
          changeLine('First resolved', report.comparisons.firstResolvedTickets),
          changeLine('Close actions', report.comparisons.closeActions),
          changeLine('Reopened', report.comparisons.reopenedTickets),
          changeLine('Average first response (minutes)', report.comparisons.avgFirstResponseMinutes),
          changeLine('Average first-resolution time (minutes)', report.comparisons.avgResolutionMinutes),
          changeLine('Reopen rate', report.comparisons.reopenRatePercent),
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Source-data coverage',
        value:
          'Tickets in cohort **' + count(report.coverage.periodTickets) + '** · Durable creation event **' +
          count(report.coverage.ticketsWithCreatedEvent) + '**\nMessage events **' +
          count(report.coverage.messageEvents) + '** · Attributed **' + count(report.coverage.attributedMessageEvents) +
          '** · Unknown author **' + count(report.coverage.unknownAuthorMessages) + '**\n' +
          'Missing/invalid timestamp **' + count(report.coverage.missingTimestampMessages) +
          '** · Lifecycle events **' + count(report.coverage.lifecycleEvents) + '**\n' +
          'First-response coverage: **' + (report.firstResponseCoveragePercent === null ? 'n/a' : report.firstResponseCoveragePercent.toFixed(1) + '%') + '**',
        inline: false,
      },
    );
}

function pageInfo(page: number, length: number): string {
  const pages = Math.max(1, Math.ceil(length / ANALYTICS_PAGE_SIZE));
  return 'Page ' + (Math.min(Math.max(page, 0), pages - 1) + 1) + '/' + pages + ' · ' + count(length) + ' rows';
}

function departments(report: AdvancedAnalyticsReport, page: number): EmbedBuilder {
  const total = report.departments.length;
  const pages = Math.max(1, Math.ceil(total / ANALYTICS_PAGE_SIZE));
  const index = Math.min(Math.max(page, 0), pages - 1);
  const subset = report.departments.slice(index * ANALYTICS_PAGE_SIZE, (index + 1) * ANALYTICS_PAGE_SIZE);
  const embed = new EmbedBuilder().setColor(0x5865f2)
    .setTitle('🏢 Department Analytics · Last ' + report.periodDays + ' days')
    .setDescription(filterDescription(report) + '\n' + pageInfo(index, total));
  if (!subset.length) embed.addFields({ name: 'No department data', value: 'No matching tickets or durable events were found.' });
  else embed.addFields(subset.map((item) => ({
    name: item.departmentName.slice(0, 256),
    value:
      'Created **' + count(item.ticketsCreated) + '** · Active **' + count(item.activeTickets) +
      '** · First resolved **' + count(item.firstResolvedTickets) + '**\n' +
      'Open **' + count(item.openTickets) + '** · Claimed **' + count(item.claimedTickets) +
      '** · Pending **' + count(item.pendingTickets) + '\n' +
      'Urgent/critical **' + count(item.urgentOrCriticalTickets) + '** · Reopened **' + count(item.reopenedTickets) + '\n' +
      'First response **' + formatMinutes(item.avgFirstResponseMinutes) + '** (' +
      count(item.firstResponseSamples) + '/' + count(item.firstResponseEligible) + ' samples)\n' +
      'Average first resolution **' + formatMinutes(item.avgResolutionMinutes) + '**',
    inline: false,
  })));
  return embed.setFooter({ text: 'Metrics group tickets using their current department mapping. ' + pageInfo(index, total) });
}

function staffView(report: AdvancedAnalyticsReport, page: number): EmbedBuilder {
  const total = report.staff.length;
  const pages = Math.max(1, Math.ceil(total / ANALYTICS_PAGE_SIZE));
  const index = Math.min(Math.max(page, 0), pages - 1);
  const subset = report.staff.slice(index * ANALYTICS_PAGE_SIZE, (index + 1) * ANALYTICS_PAGE_SIZE);
  const embed = new EmbedBuilder().setColor(0x5865f2)
    .setTitle('👥 Staff Workload · Last ' + report.periodDays + ' days')
    .setDescription(filterDescription(report) +
      '\nThis is an operational workload view, **not a staff performance ranking**. Ticket complexity and role coverage differ.');
  if (!subset.length) embed.addFields({ name: 'No attributable staff activity', value: 'No high-confidence staff claim, close, reply, first-response or active-workload records were found.' });
  else embed.addFields(subset.map((item) => ({
    name: ('Staff ID ' + item.staffId).slice(0, 256),
    value:
      'Active workload **' + count(item.activeWorkload) + '** · Claimed **' + count(item.ticketsClaimed) +
      '** · Closed **' + count(item.ticketsClosed) + '**\n' +
      'Replies **' + count(item.staffReplies) + '** · First responses **' + count(item.firstResponses) +
      '** · Average first response **' + formatMinutes(item.avgFirstResponseMinutes) + '**',
    inline: false,
  })));
  return embed.setFooter({ text: 'Only explicitly attributed, high-confidence staff actions are included. ' + pageInfo(index, total) });
}

function tagsView(report: AdvancedAnalyticsReport, page: number): EmbedBuilder {
  const total = report.tags.length;
  const pages = Math.max(1, Math.ceil(total / ANALYTICS_PAGE_SIZE));
  const index = Math.min(Math.max(page, 0), pages - 1);
  const subset = report.tags.slice(index * ANALYTICS_PAGE_SIZE, (index + 1) * ANALYTICS_PAGE_SIZE);
  const embed = new EmbedBuilder().setColor(0x5865f2)
    .setTitle('🏷️ Tag Analytics · Last ' + report.periodDays + ' days')
    .setDescription(filterDescription(report) + '\n' + pageInfo(index, total));
  if (!subset.length) embed.addFields({ name: 'No tag data', value: 'No matching ticket/tag records were found.' });
  else embed.addFields(subset.map((item) => ({
    name: item.tagName.slice(0, 256),
    value: 'Created **' + count(item.ticketsCreated) + '** · Active **' + count(item.activeTickets) +
      '** · First resolved **' + count(item.firstResolvedTickets) +
      '** · Active urgent/critical **' + count(item.urgentOrCriticalTickets) + '**',
    inline: false,
  })));
  return embed.setFooter({ text: pageInfo(index, total) + ' · Counts use the persisted tag mapping.' });
}

interface TrendBucket {
  label: string;
  created: number;
  resolved: number;
}

function weekStart(day: string): string {
  const date = new Date(day + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function makeBuckets(rows: AdvancedAnalyticsReport['daily'], weekly: boolean): TrendBucket[] {
  if (!weekly) return rows.map((r) => ({ label: r.day, created: r.ticketsCreated, resolved: r.firstResolvedTickets }));
  const buckets = new Map<string, TrendBucket>();
  for (const row of rows) {
    const label = weekStart(row.day);
    const current = buckets.get(label) ?? { label, created: 0, resolved: 0 };
    current.created += row.ticketsCreated;
    current.resolved += row.firstResolvedTickets;
    buckets.set(label, current);
  }
  return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function bar(value: number, peak: number): string {
  const length = peak > 0 ? Math.min(12, Math.round((value / peak) * 12)) : 0;
  return length ? '█'.repeat(length) : '·';
}

function trendsView(report: AdvancedAnalyticsReport): EmbedBuilder {
  const weekly = report.periodDays > 14;
  const buckets = makeBuckets(report.daily, weekly);
  const peak = Math.max(0, ...buckets.map((item) => item.created), ...buckets.map((item) => item.resolved));
  const lines = buckets.map((item) =>
    item.label + '  C ' + String(item.created).padStart(3, ' ') + ' ' + bar(item.created, peak) +
    '  R ' + String(item.resolved).padStart(3, ' ') + ' ' + bar(item.resolved, peak),
  );
  const embed = new EmbedBuilder().setColor(0x5865f2)
    .setTitle('📈 Ticket Trends · Last ' + report.periodDays + ' days')
    .setDescription(filterDescription(report) + '\n' + (weekly ? 'Weekly UTC buckets' : 'Daily UTC buckets') +
      '\nC = created · R = first resolved\n' + (lines.join('\n') || 'No data'))
    .setFooter({ text: 'Bars are relative within this view. Observed values only; not a forecast.' });
  return embed.addFields({
    name: 'Previous equal-length period',
    value: [
      changeLine('Created', report.comparisons.ticketsCreated),
      changeLine('First resolved', report.comparisons.firstResolvedTickets),
      changeLine('Reopened', report.comparisons.reopenedTickets),
    ].join('\n'),
  });
}

export function analyticsItemCount(report: AdvancedAnalyticsReport, view: AnalyticsView): number {
  if (view === 'departments') return report.departments.length;
  if (view === 'staff') return report.staff.length;
  if (view === 'tags') return report.tags.length;
  if (view === 'trends') return report.daily.length;
  return 1;
}

export function buildAdvancedAnalyticsEmbed(report: AdvancedAnalyticsReport, view: AnalyticsView = 'overview', page = 0): EmbedBuilder {
  switch (view) {
    case 'departments': return departments(report, page);
    case 'staff': return staffView(report, page);
    case 'tags': return tagsView(report, page);
    case 'trends': return trendsView(report);
    default: return overview(report);
  }
}

function viewButton(view: AnalyticsView, active: AnalyticsView, period: number): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId('sf:settings:analytics:view:' + view + ':' + period + 'd:0')
    .setLabel(view === 'overview' ? 'Overview' : view[0]!.toUpperCase() + view.slice(1))
    .setStyle(view === active ? ButtonStyle.Primary : ButtonStyle.Secondary);
}

export function buildAdvancedAnalyticsComponents(report: AdvancedAnalyticsReport, view: AnalyticsView, page = 0): ActionRowBuilder<ButtonBuilder>[] {
  const period = report.periodDays;
  const pageCount = Math.max(1, Math.ceil(analyticsItemCount(report, view) / ANALYTICS_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const periodRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sf:settings:analytics:view:' + view + ':7d:0').setLabel('7 days').setStyle(period === 7 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sf:settings:analytics:view:' + view + ':30d:0').setLabel('30 days').setStyle(period === 30 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sf:settings:analytics:view:' + view + ':90d:0').setLabel('90 days').setStyle(period === 90 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sf:settings:home').setLabel('Settings Home').setStyle(ButtonStyle.Secondary),
  );
  const views = new ActionRowBuilder<ButtonBuilder>().addComponents(
    viewButton('overview', view, period),
    viewButton('departments', view, period),
    viewButton('staff', view, period),
    viewButton('tags', view, period),
    viewButton('trends', view, period),
  );
  const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sf:settings:analytics:export:' + period + 'd').setLabel('Export CSV').setEmoji('📄').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('sf:settings:analytics:page:' + view + ':' + period + 'd:' + (safePage - 1)).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 0 || view === 'overview' || view === 'trends'),
    new ButtonBuilder().setCustomId('sf:settings:analytics:page:' + view + ':' + period + 'd:' + (safePage + 1)).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pageCount - 1 || view === 'overview' || view === 'trends'),
  );
  return [periodRow, views, navigation];
}
