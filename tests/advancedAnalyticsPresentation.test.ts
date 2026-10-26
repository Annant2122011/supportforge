import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdvancedAnalyticsReport } from '../src/services/advancedAnalyticsService';
import { buildAdvancedAnalyticsComponents, buildAdvancedAnalyticsEmbed } from '../src/interactions/advancedAnalyticsPresentation';

const cmp={current:12,previous:8,changePercent:50};
const summary={periodDays:7,periodStartAt:'2026-10-01T00:00:00.000Z',periodEndAt:'2026-10-08T00:00:00.000Z',generatedAt:'2026-10-08T12:30:00.000Z',
ticketsCreated:12,firstResolvedTickets:8,closeActions:10,reopenedTickets:2,reopenedAfterFirstClose:1,activeTickets:6,openTickets:2,claimedTickets:3,pendingTickets:1,urgentOrCriticalTickets:2,
oldestActiveCreatedAt:'2026-10-04T00:00:00.000Z',avgFirstResponseMinutes:25.5,avgResolutionMinutes:310,reopenRatePercent:12.5,firstResponseEligible:10,firstResponseSamples:8};
const report={summary,periodDays:7,periodStartAt:'2026-10-01T00:00:00.000Z',periodEndAt:'2026-10-08T00:00:00.000Z',
filters:{departmentId:null,tagId:null,priority:null,status:null},
comparisons:{ticketsCreated:cmp,firstResolvedTickets:cmp,closeActions:cmp,reopenedTickets:cmp,avgFirstResponseMinutes:cmp,avgResolutionMinutes:cmp,reopenRatePercent:cmp},
coverage:{periodTickets:12,ticketsWithCreatedEvent:12,messageEvents:42,attributedMessageEvents:36,unknownAuthorMessages:3,missingTimestampMessages:0,lifecycleEvents:18},
firstResponseCoveragePercent:75,departments:[],staff:[],tags:[],daily:[]} as unknown as AdvancedAnalyticsReport;

test('analytics dashboards localize content without changing stable component IDs',()=>{
 const en=buildAdvancedAnalyticsEmbed(report,'departments',0,0x5865f2,'en-US').toJSON();
 const hi=buildAdvancedAnalyticsEmbed(report,'departments',0,0x5865f2,'hi-IN').toJSON();
 assert.match(en.title??'',/Department Analytics/);
 assert.match(hi.title??'',/विभाग विश्लेषण/);
 assert.match(en.description??'',/Reporting window/);
 assert.match(hi.description??'',/रिपोर्टिंग अवधि/);
 const enRows=buildAdvancedAnalyticsComponents(report,'departments',0,'en-US');
 const hiRows=buildAdvancedAnalyticsComponents(report,'departments',0,'hi-IN');
 assert.equal(enRows[0]!.components[0]!.toJSON().label,'Last 7 days');
 assert.equal(hiRows[0]!.components[0]!.toJSON().label,'7 दिन');
 assert.equal(enRows[0]!.components[0]!.toJSON().custom_id,hiRows[0]!.components[0]!.toJSON().custom_id);
 assert.equal(enRows[1]!.components[0]!.toJSON().label,'Overview');
 assert.equal(hiRows[1]!.components[0]!.toJSON().label,'सारांश');
 assert.equal(enRows[1]!.components[0]!.toJSON().custom_id,hiRows[1]!.components[0]!.toJSON().custom_id);
});
test('analytics overview localizes field headings and retains explicit evidence limitations',()=>{
 const en=buildAdvancedAnalyticsEmbed(report,'overview',0,0x5865f2,'en-US').toJSON();
 const bn=buildAdvancedAnalyticsEmbed(report,'overview',0,0x5865f2,'bn-IN').toJSON();
 assert.ok((en.fields??[]).some(f=>f.name==='Activity during the period'));
 assert.ok((bn.fields??[]).some(f=>f.name==='এই সময়ের কার্যকলাপ'));
 assert.ok((bn.fields??[]).some(f=>f.name==='ডেটার সংজ্ঞা ও কভারেজ'));
 assert.ok((en.fields??[]).some(f=>f.value.includes('SLA compliance and customer satisfaction are not shown')));
 assert.ok((bn.fields??[]).some(f=>f.value.includes('SLA সম্মতি')));
});
