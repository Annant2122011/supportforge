import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { GuildAnalyticsSummary } from '../services/analyticsService';
import { translate, formatLocaleNumber, formatLocaleDate } from '../i18n/translationService';
import { applyQueryFixrBranding, QUERYFIXR_ACCENT_COLOR, queryFixrFooter } from './brandPresentation';

function utc(locale:string,value:string):string {
 const date=new Date(value); if(!Number.isFinite(date.getTime()))throw new RangeError('Cannot format an invalid analytics timestamp.');
 const d=formatLocaleDate(locale,date,{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'UTC'});
 const tm=new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'UTC'}).format(date);
 return d+' '+tm+' UTC';
}
function decimal(locale:string,value:number):string{return formatLocaleNumber(locale,value,{minimumFractionDigits:1,maximumFractionDigits:1});}
function count(locale:string,value:number):string{return formatLocaleNumber(locale,value);}
function formatMinutes(locale:string,value:number|null):string {
 if(value===null)return translate(locale,'analytics.notEnoughData');
 if(value<60)return translate(locale,'analytics.minutes',{value:decimal(locale,value)});
 if(value<1440)return translate(locale,'analytics.hours',{value:decimal(locale,value/60)});
 return translate(locale,'analytics.days',{value:decimal(locale,value/(60*24))});
}
function formatAge(locale:string,createdAt:string|null,now:string):string {
 if(!createdAt)return translate(locale,'analytics.noActiveTickets');
 const elapsed=Math.max(0,(Date.parse(now)-Date.parse(createdAt))/60000);
 return formatMinutes(locale,Math.round(elapsed*10)/10);
}
export function buildAnalyticsEmbed(summary:GuildAnalyticsSummary,themeColor=QUERYFIXR_ACCENT_COLOR,locale='en-US'):EmbedBuilder {
 const reopenRate=summary.reopenRatePercent===null?translate(locale,'analytics.reopenRateUnavailable'):decimal(locale,summary.reopenRatePercent)+'%';
 const responseCoverage=summary.firstResponseEligible>0
 ?translate(locale,'analytics.coverage.recorded',{responded:count(locale,summary.firstResponseSamples),eligible:count(locale,summary.firstResponseEligible)})
 :translate(locale,'analytics.coverage.none');
 return applyQueryFixrBranding(new EmbedBuilder(),'Support Analytics',themeColor)
 .setTitle(translate(locale,'analytics.title',{period:translate(locale,'analytics.period',{days:count(locale,summary.periodDays)})}))
 .setDescription(translate(locale,'analytics.reportingWindow',{start:utc(locale,summary.periodStartAt),end:utc(locale,summary.periodEndAt)})+
 '\n'+translate(locale,'analytics.generated',{time:utc(locale,summary.generatedAt)})+'\n'+translate(locale,'analytics.snapshotNote'))
 .addFields(
 {name:translate(locale,'analytics.field.activity'),value:translate(locale,'analytics.value.activity',{created:count(locale,summary.ticketsCreated),firstResolved:count(locale,summary.firstResolvedTickets),closeActions:count(locale,summary.closeActions),reopened:count(locale,summary.reopenedTickets)}),inline:true},
 {name:translate(locale,'analytics.field.queue'),value:translate(locale,'analytics.value.queue',{active:count(locale,summary.activeTickets),open:count(locale,summary.openTickets),claimed:count(locale,summary.claimedTickets),pending:count(locale,summary.pendingTickets),urgent:count(locale,summary.urgentOrCriticalTickets),age:formatAge(locale,summary.oldestActiveCreatedAt,summary.generatedAt)}),inline:true},
 {name:translate(locale,'analytics.field.firstResponse'),value:translate(locale,'analytics.value.firstResponse',{average:formatMinutes(locale,summary.avgFirstResponseMinutes),coverage:responseCoverage,methodNote:translate(locale,'analytics.methodNote')}),inline:false},
 {name:translate(locale,'analytics.field.resolution'),value:translate(locale,'analytics.value.resolution',{average:formatMinutes(locale,summary.avgResolutionMinutes),firstResolved:count(locale,summary.firstResolvedTickets),reopenRate,reopened:count(locale,summary.reopenedAfterFirstClose)}),inline:false},
 {name:translate(locale,'analytics.field.definitions'),value:translate(locale,'analytics.value.definitions'),inline:false})
 .setFooter({text:queryFixrFooter(translate(locale,'analytics.advanced.footer.analytics'),translate(locale,'analytics.footer.source'))});
}
export function buildAnalyticsPeriodButtons(locale='en-US'):ActionRowBuilder<ButtonBuilder>[] {
 return [new ActionRowBuilder<ButtonBuilder>().addComponents(
 new ButtonBuilder().setCustomId('sf:settings:analytics:7d').setLabel(translate(locale,'analytics.button.period',{days:count(locale,7)})).setStyle(ButtonStyle.Primary),
 new ButtonBuilder().setCustomId('sf:settings:analytics:30d').setLabel(translate(locale,'analytics.button.period',{days:count(locale,30)})).setStyle(ButtonStyle.Secondary),
 new ButtonBuilder().setCustomId('sf:settings:analytics:90d').setLabel(translate(locale,'analytics.button.period',{days:count(locale,90)})).setStyle(ButtonStyle.Secondary),
 new ButtonBuilder().setCustomId('sf:settings:home').setLabel(translate(locale,'analytics.button.settingsHome')).setStyle(ButtonStyle.Secondary))];
}
