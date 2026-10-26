import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { AdvancedAnalyticsReport } from '../services/advancedAnalyticsService';
import { translate, formatLocaleNumber, formatLocaleDate } from '../i18n/translationService';
import type { TranslationKey } from '../i18n/locales/en-US';
import { buildAnalyticsEmbed } from './analyticsPresentation';
import { applyQueryFixrBranding, QUERYFIXR_ACCENT_COLOR, queryFixrFooter } from './brandPresentation';
export type AnalyticsView='overview'|'departments'|'staff'|'tags'|'trends';
export const ANALYTICS_PAGE_SIZE=10;
function t(locale:string,key:TranslationKey,params:Readonly<Record<string,string|number|boolean|null|undefined>>={}):string{return translate(locale,key,params);}
function count(locale:string,value:number):string{return formatLocaleNumber(locale,value);}
function decimal(locale:string,value:number):string{return formatLocaleNumber(locale,value,{minimumFractionDigits:1,maximumFractionDigits:1});}
function formatMinutes(locale:string,value:number|null):string {
 if(value===null)return t(locale,'analytics.notEnoughData');
 if(value<60)return t(locale,'analytics.minutes',{value:decimal(locale,value)});
 if(value<1440)return t(locale,'analytics.hours',{value:decimal(locale,value/60)});
 return t(locale,'analytics.days',{value:decimal(locale,value/1440)});
}
function utc(locale:string,value:string):string {
 const date=new Date(value);if(!Number.isFinite(date.getTime()))throw new RangeError('Cannot format an invalid analytics timestamp.');
 return formatLocaleDate(locale,date,{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'UTC'})+' '+
 new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'UTC'}).format(date)+' UTC';
}
function utcDate(locale:string,value:string):string{return formatLocaleDate(locale,value,{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'UTC'});}
function changeLine(locale:string,label:string,v:{current:number|null;previous:number|null;changePercent:number|null}):string {
 const current=v.current===null?t(locale,'analytics.advanced.na'):count(locale,v.current);
 const previous=v.previous===null?t(locale,'analytics.advanced.na'):count(locale,v.previous);
 const change=v.changePercent===null?t(locale,'analytics.advanced.changeUnavailable'):(v.changePercent>0?'+':'')+decimal(locale,v.changePercent)+'%';
 return t(locale,'analytics.advanced.changeLine',{label,current,previous,change});
}
function filterDescription(locale:string,report:AdvancedAnalyticsReport):string {
 const filters:string[]=[];
 if(report.filters.departmentId)filters.push(t(locale,'analytics.advanced.filter.department',{value:report.filters.departmentId}));
 if(report.filters.tagId)filters.push(t(locale,'analytics.advanced.filter.tag',{value:report.filters.tagId}));
 if(report.filters.priority)filters.push(t(locale,'analytics.advanced.filter.priority',{value:report.filters.priority}));
 if(report.filters.status)filters.push(t(locale,'analytics.advanced.filter.status',{value:report.filters.status}));
 return t(locale,'analytics.reportingWindow',{start:utc(locale,report.periodStartAt),end:utc(locale,report.periodEndAt)})+
 '\n'+t(locale,'analytics.advanced.filters',{filters:filters.length?filters.join(' · '):t(locale,'analytics.advanced.filtersNone')})+
 '\n'+t(locale,'analytics.advanced.snapshotNote');
}
function overview(report:AdvancedAnalyticsReport,locale:string):EmbedBuilder {
 return buildAnalyticsEmbed(report.summary,QUERYFIXR_ACCENT_COLOR,locale).setDescription(filterDescription(locale,report)).addFields(
 {name:t(locale,'analytics.advanced.previousPeriod'),value:[
 changeLine(locale,t(locale,'analytics.advanced.metric.created'),report.comparisons.ticketsCreated),
 changeLine(locale,t(locale,'analytics.advanced.metric.firstResolved'),report.comparisons.firstResolvedTickets),
 changeLine(locale,t(locale,'analytics.advanced.metric.closeActions'),report.comparisons.closeActions),
 changeLine(locale,t(locale,'analytics.advanced.metric.reopened'),report.comparisons.reopenedTickets),
 changeLine(locale,t(locale,'analytics.advanced.metric.avgFirstResponse'),report.comparisons.avgFirstResponseMinutes),
 changeLine(locale,t(locale,'analytics.advanced.metric.avgResolution'),report.comparisons.avgResolutionMinutes),
 changeLine(locale,t(locale,'analytics.advanced.metric.reopenRate'),report.comparisons.reopenRatePercent)].join('\n'),inline:false},
 {name:t(locale,'analytics.advanced.sourceCoverage'),value:
 t(locale,'analytics.advanced.coverage.cohort',{periodTickets:count(locale,report.coverage.periodTickets),createdEvents:count(locale,report.coverage.ticketsWithCreatedEvent)})+'\n'+
 t(locale,'analytics.advanced.coverage.messages',{events:count(locale,report.coverage.messageEvents),attributed:count(locale,report.coverage.attributedMessageEvents),unknown:count(locale,report.coverage.unknownAuthorMessages)})+'\n'+
 t(locale,'analytics.advanced.coverage.timestamps',{missing:count(locale,report.coverage.missingTimestampMessages),lifecycle:count(locale,report.coverage.lifecycleEvents)})+'\n'+
 t(locale,'analytics.advanced.coverage.response',{coverage:report.firstResponseCoveragePercent===null?t(locale,'analytics.advanced.na'):decimal(locale,report.firstResponseCoveragePercent)+'%'}),inline:false});
}
function pageInfo(locale:string,page:number,length:number):string {
 return t(locale,'analytics.advanced.pageInfo',{page:count(locale,Math.min(Math.max(page,0),Math.max(1,Math.ceil(length/ANALYTICS_PAGE_SIZE))-1)+1),pages:count(locale,Math.max(1,Math.ceil(length/ANALYTICS_PAGE_SIZE))),count:count(locale,length)});
}
function departments(report:AdvancedAnalyticsReport,page:number,locale:string):EmbedBuilder {
 const total=report.departments.length,pages=Math.max(1,Math.ceil(total/ANALYTICS_PAGE_SIZE)),idx=Math.min(Math.max(page,0),pages-1),subset=report.departments.slice(idx*ANALYTICS_PAGE_SIZE,(idx+1)*ANALYTICS_PAGE_SIZE);
 const embed=new EmbedBuilder().setColor(0x5865f2).setTitle(t(locale,'analytics.advanced.department.title',{period:t(locale,'analytics.period',{days:count(locale,report.periodDays)})})).setDescription(filterDescription(locale,report)+'\n'+pageInfo(locale,idx,total));
 if(!subset.length)embed.addFields({name:t(locale,'analytics.advanced.department.emptyTitle'),value:t(locale,'analytics.advanced.department.emptyDescription')});
 else embed.addFields(subset.map(x=>({name:x.departmentName.slice(0,256),value:
 t(locale,'analytics.advanced.department.createdLine',{created:count(locale,x.ticketsCreated),active:count(locale,x.activeTickets),resolved:count(locale,x.firstResolvedTickets)})+'\n'+
 t(locale,'analytics.advanced.department.stateLine',{open:count(locale,x.openTickets),claimed:count(locale,x.claimedTickets),pending:count(locale,x.pendingTickets)})+'\n'+
 t(locale,'analytics.advanced.department.riskLine',{urgent:count(locale,x.urgentOrCriticalTickets),reopened:count(locale,x.reopenedTickets)})+'\n'+
 t(locale,'analytics.advanced.department.responseLine',{value:formatMinutes(locale,x.avgFirstResponseMinutes),samples:count(locale,x.firstResponseSamples),eligible:count(locale,x.firstResponseEligible)})+'\n'+
 t(locale,'analytics.advanced.department.resolutionLine',{value:formatMinutes(locale,x.avgResolutionMinutes)}),inline:false})));
 return embed.setFooter({text:t(locale,'analytics.advanced.department.footer',{pageInfo:pageInfo(locale,idx,total)})});
}
function staffView(report:AdvancedAnalyticsReport,page:number,locale:string):EmbedBuilder {
 const total=report.staff.length,pages=Math.max(1,Math.ceil(total/ANALYTICS_PAGE_SIZE)),idx=Math.min(Math.max(page,0),pages-1),subset=report.staff.slice(idx*ANALYTICS_PAGE_SIZE,(idx+1)*ANALYTICS_PAGE_SIZE);
 const embed=new EmbedBuilder().setColor(0x5865f2).setTitle(t(locale,'analytics.advanced.staff.title',{period:t(locale,'analytics.period',{days:count(locale,report.periodDays)})})).setDescription(filterDescription(locale,report)+'\n'+t(locale,'analytics.advanced.staff.description'));
 if(!subset.length)embed.addFields({name:t(locale,'analytics.advanced.staff.emptyTitle'),value:t(locale,'analytics.advanced.staff.emptyDescription')});
 else embed.addFields(subset.map(x=>({name:t(locale,'analytics.advanced.staff.id',{id:x.staffId}).slice(0,256),value:
 t(locale,'analytics.advanced.staff.workloadLine',{active:count(locale,x.activeWorkload),claimed:count(locale,x.ticketsClaimed),closed:count(locale,x.ticketsClosed)})+'\n'+
 t(locale,'analytics.advanced.staff.replyLine',{replies:count(locale,x.staffReplies),responses:count(locale,x.firstResponses),average:formatMinutes(locale,x.avgFirstResponseMinutes)}),inline:false})));
 return embed.setFooter({text:t(locale,'analytics.advanced.staff.footer',{pageInfo:pageInfo(locale,idx,total)})});
}
function tagsView(report:AdvancedAnalyticsReport,page:number,locale:string):EmbedBuilder {
 const total=report.tags.length,pages=Math.max(1,Math.ceil(total/ANALYTICS_PAGE_SIZE)),idx=Math.min(Math.max(page,0),pages-1),subset=report.tags.slice(idx*ANALYTICS_PAGE_SIZE,(idx+1)*ANALYTICS_PAGE_SIZE);
 const embed=new EmbedBuilder().setColor(0x5865f2).setTitle(t(locale,'analytics.advanced.tags.title',{period:t(locale,'analytics.period',{days:count(locale,report.periodDays)})})).setDescription(filterDescription(locale,report)+'\n'+pageInfo(locale,idx,total));
 if(!subset.length)embed.addFields({name:t(locale,'analytics.advanced.tags.emptyTitle'),value:t(locale,'analytics.advanced.tags.emptyDescription')});
 else embed.addFields(subset.map(x=>({name:x.tagName.slice(0,256),value:t(locale,'analytics.advanced.tags.metricsLine',{created:count(locale,x.ticketsCreated),active:count(locale,x.activeTickets),resolved:count(locale,x.firstResolvedTickets),urgent:count(locale,x.urgentOrCriticalTickets)}),inline:false})));
 return embed.setFooter({text:t(locale,'analytics.advanced.tags.footer',{pageInfo:pageInfo(locale,idx,total)})});
}
interface TrendBucket{label:string;created:number;resolved:number;}
function weekStart(day:string):string{const d=new Date(day+'T00:00:00.000Z');d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);}
function makeBuckets(rows:AdvancedAnalyticsReport['daily'],weekly:boolean):TrendBucket[]{
 if(!weekly)return rows.map(r=>({label:r.day,created:r.ticketsCreated,resolved:r.firstResolvedTickets}));
 const buckets=new Map<string,TrendBucket>();
 for(const r of rows){const label=weekStart(r.day),current=buckets.get(label)??{label,created:0,resolved:0};current.created+=r.ticketsCreated;current.resolved+=r.firstResolvedTickets;buckets.set(label,current);}
 return [...buckets.values()].sort((a,b)=>a.label.localeCompare(b.label));
}
function bar(value:number,peak:number):string{const n=peak>0?Math.min(12,Math.round(value/peak*12)):0;return n?'█'.repeat(n):'·';}
function trendsView(report:AdvancedAnalyticsReport,locale:string):EmbedBuilder{
 const weekly=report.periodDays>14,buckets=makeBuckets(report.daily,weekly),peak=Math.max(0,...buckets.map(x=>x.created),...buckets.map(x=>x.resolved));
 const lines=buckets.map(x=>utcDate(locale,x.label)+'  C '+String(x.created).padStart(3,' ')+' '+bar(x.created,peak)+'  R '+String(x.resolved).padStart(3,' ')+' '+bar(x.resolved,peak));
 const e=new EmbedBuilder().setColor(0x5865f2).setTitle(t(locale,'analytics.advanced.trends.title',{period:t(locale,'analytics.period',{days:count(locale,report.periodDays)})})).setDescription(filterDescription(locale,report)+'\n'+t(locale,weekly?'analytics.advanced.trends.weekly':'analytics.advanced.trends.daily')+'\n'+t(locale,'analytics.advanced.trends.legend')+'\n'+(lines.join('\n')||t(locale,'analytics.advanced.trends.noData'))).setFooter({text:t(locale,'analytics.advanced.trends.footer')});
 return e.addFields({name:t(locale,'analytics.advanced.previousPeriod'),value:[changeLine(locale,t(locale,'analytics.advanced.metric.created'),report.comparisons.ticketsCreated),changeLine(locale,t(locale,'analytics.advanced.metric.firstResolved'),report.comparisons.firstResolvedTickets),changeLine(locale,t(locale,'analytics.advanced.metric.reopened'),report.comparisons.reopenedTickets)].join('\n')});
}
export function analyticsItemCount(report:AdvancedAnalyticsReport,view:AnalyticsView):number{if(view==='departments')return report.departments.length;if(view==='staff')return report.staff.length;if(view==='tags')return report.tags.length;if(view==='trends')return report.daily.length;return 1;}
const VIEW_KEYS:Record<AnalyticsView,TranslationKey>={overview:'analytics.advanced.view.overview',departments:'analytics.advanced.view.departments',staff:'analytics.advanced.view.staff',tags:'analytics.advanced.view.tags',trends:'analytics.advanced.view.trends'};
export function buildAdvancedAnalyticsEmbed(report:AdvancedAnalyticsReport,view:AnalyticsView='overview',page=0,themeColor=QUERYFIXR_ACCENT_COLOR,locale='en-US'):EmbedBuilder{
 let embed:EmbedBuilder;switch(view){case 'departments':embed=departments(report,page,locale);break;case 'staff':embed=staffView(report,page,locale);break;case 'tags':embed=tagsView(report,page,locale);break;case 'trends':embed=trendsView(report,locale);break;default:embed=overview(report,locale);break;}
 const label=t(locale,VIEW_KEYS[view]),existing=(embed.toJSON().footer?.text??'').replace(/^QueryFixr • Analytics • /,'').slice(0,300);
 return applyQueryFixrBranding(embed,label,themeColor).setFooter({text:queryFixrFooter(t(locale,'analytics.advanced.footer.analytics'),existing||t(locale,'analytics.advanced.footer.metrics'))});
}
function viewButton(view:AnalyticsView,active:AnalyticsView,period:number,locale:string):ButtonBuilder{return new ButtonBuilder().setCustomId('sf:settings:analytics:view:'+view+':'+period+'d:0').setLabel(t(locale,VIEW_KEYS[view])).setStyle(view===active?ButtonStyle.Primary:ButtonStyle.Secondary);}
export function buildAdvancedAnalyticsComponents(report:AdvancedAnalyticsReport,view:AnalyticsView,page=0,locale='en-US'):ActionRowBuilder<ButtonBuilder>[] {
 const period=report.periodDays,pageCount=Math.max(1,Math.ceil(analyticsItemCount(report,view)/ANALYTICS_PAGE_SIZE)),safe=Math.min(Math.max(page,0),pageCount-1);
 const periods=new ActionRowBuilder<ButtonBuilder>().addComponents(
 new ButtonBuilder().setCustomId('sf:settings:analytics:view:'+view+':7d:0').setLabel(t(locale,'analytics.advanced.button.days',{days:count(locale,7)})).setStyle(period===7?ButtonStyle.Primary:ButtonStyle.Secondary),
 new ButtonBuilder().setCustomId('sf:settings:analytics:view:'+view+':30d:0').setLabel(t(locale,'analytics.advanced.button.days',{days:count(locale,30)})).setStyle(period===30?ButtonStyle.Primary:ButtonStyle.Secondary),
 new ButtonBuilder().setCustomId('sf:settings:analytics:view:'+view+':90d:0').setLabel(t(locale,'analytics.advanced.button.days',{days:count(locale,90)})).setStyle(period===90?ButtonStyle.Primary:ButtonStyle.Secondary),
 new ButtonBuilder().setCustomId('sf:settings:home').setLabel(t(locale,'analytics.button.settingsHome')).setStyle(ButtonStyle.Secondary));
 const views=new ActionRowBuilder<ButtonBuilder>().addComponents(viewButton('overview',view,period,locale),viewButton('departments',view,period,locale),viewButton('staff',view,period,locale),viewButton('tags',view,period,locale),viewButton('trends',view,period,locale));
 const navigation=new ActionRowBuilder<ButtonBuilder>().addComponents(
 new ButtonBuilder().setCustomId('sf:settings:analytics:export:'+period+'d').setLabel(t(locale,'analytics.advanced.button.export')).setEmoji('📄').setStyle(ButtonStyle.Success),
 new ButtonBuilder().setCustomId('sf:settings:analytics:page:'+view+':'+period+'d:'+(safe-1)).setLabel(t(locale,'analytics.advanced.button.previous')).setStyle(ButtonStyle.Secondary).setDisabled(safe<=0||view==='overview'||view==='trends'),
 new ButtonBuilder().setCustomId('sf:settings:analytics:page:'+view+':'+period+'d:'+(safe+1)).setLabel(t(locale,'analytics.advanced.button.next')).setStyle(ButtonStyle.Secondary).setDisabled(safe>=pageCount-1||view==='overview'||view==='trends'));
 return [periods,views,navigation];
}
