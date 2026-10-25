import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import type { GuildAnalyticsSummary } from '../services/analyticsService';

function utc(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function formatMinutes(value: number | null): string {
  if (value === null) return 'Not enough reliable data yet';
  if (value < 60) return value.toFixed(1) + ' min';
  if (value < 60 * 24) {
    const hours = value / 60;
    return hours.toFixed(1) + ' hr';
  }
  return (value / (60 * 24)).toFixed(1) + ' days';
}

function formatAge(createdAt: string | null, now: string): string {
  if (!createdAt) return 'No active tickets';
  const elapsedMinutes = Math.max(
    0,
    (Date.parse(now) - Date.parse(createdAt)) / 60_000,
  );
  return formatMinutes(Math.round(elapsedMinutes * 10) / 10);
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function periodLabel(days: number): string {
  return 'Last ' + days + ' days';
}

export function buildAnalyticsEmbed(summary: GuildAnalyticsSummary): EmbedBuilder {
  const reopenRate = summary.reopenRatePercent === null
    ? 'Not available (no first closures in this period)'
    : summary.reopenRatePercent.toFixed(1) + '%';
  const responseCoverage = summary.firstResponseEligible > 0
    ? count(summary.firstResponseSamples) + ' responded / ' +
      count(summary.firstResponseEligible) + ' tickets with a recorded customer message'
    : 'No customer-message events with a known author type in this ticket cohort';

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📊 Ticket Analytics · ' + periodLabel(summary.periodDays))
    .setDescription(
      '**Reporting window:** ' + utc(summary.periodStartAt) + ' to ' + utc(summary.periodEndAt) +
      '\n**Generated:** ' + utc(summary.generatedAt) +
      '\nThe live queue is a current snapshot. Period totals use persisted ticket and domain-event records.',
    )
    .addFields(
      {
        name: 'Activity during the period',
        value:
          '🎫 Created: **' + count(summary.ticketsCreated) + '**\n' +
          '✅ First resolved: **' + count(summary.firstResolvedTickets) + '**\n' +
          '🔒 Close actions: **' + count(summary.closeActions) + '**\n' +
          '↩️ Tickets reopened: **' + count(summary.reopenedTickets) + '**',
        inline: true,
      },
      {
        name: 'Current live queue',
        value:
          '📥 Active backlog: **' + count(summary.activeTickets) + '**\n' +
          '🟢 Open / reopened: **' + count(summary.openTickets) + '**\n' +
          '👤 Claimed: **' + count(summary.claimedTickets) + '**\n' +
          '⏳ Pending: **' + count(summary.pendingTickets) + '**\n' +
          '🔴 Urgent / critical: **' + count(summary.urgentOrCriticalTickets) + '**\n' +
          '⌛ Oldest active ticket age: **' + formatAge(summary.oldestActiveCreatedAt, summary.generatedAt) + '**',
        inline: true,
      },
      {
        name: 'First response',
        value:
          '**Average:** ' + formatMinutes(summary.avgFirstResponseMinutes) + '\n' +
          '**Coverage:** ' + responseCoverage +
          '\nMeasured from the first recorded customer message to the first later staff message, for tickets created in this period.',
        inline: false,
      },
      {
        name: 'Resolution and reopen rate',
        value:
          '**Average first-resolution time:** ' + formatMinutes(summary.avgResolutionMinutes) + '\n' +
          '**Tickets first resolved in period:** ' + count(summary.firstResolvedTickets) + '\n' +
          '**Reopen rate:** ' + reopenRate + '\n' +
          '**Reopened after a first closure in this period:** ' + count(summary.reopenedAfterFirstClose),
        inline: false,
      },
      {
        name: 'Data definitions and coverage',
        value:
          'First-resolution time uses the earliest durable ticket.closed event for each ticket. Reopen rate counts those first-closed tickets with a later reopen event before this report window ends. First-response samples require explicit customer/staff message attribution; unknown events are excluded rather than guessed. Historical tickets without durable events may be absent from time-based metrics. SLA compliance and customer satisfaction are not shown until their source data is implemented.',
        inline: false,
      },
    )
    .setFooter({ text: 'Operational ticket analytics • PostgreSQL source of truth' });
}

export function buildAnalyticsPeriodButtons(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('sf:settings:analytics:7d')
        .setLabel('Last 7 days')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('sf:settings:analytics:30d')
        .setLabel('Last 30 days')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('sf:settings:analytics:90d')
        .setLabel('Last 90 days')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('sf:settings:home')
        .setLabel('Settings Home')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}
