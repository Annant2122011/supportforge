import assert from 'node:assert/strict';
import test from 'node:test';

import { parseQuickReplyPage, quickReplyHasTag, renderQuickReply, validateQuickReplyInput, type QuickReply } from '../src/services/quickReplyService';

const validReply = (): QuickReply => ({
  id:'reply-1',guildId:'guild-1',name:'Refund update',body:'Hello {username}, ticket {ticket_number} is {priority}.',
  category:'Billing',tags:['refund'],allowedRoleIds:['12345678901234567'],enabled:true,version:2,
  createdBy:'admin',updatedBy:'admin',createdAt:'2026-10-23T00:00:00.000Z',updatedAt:'2026-10-23T00:00:00.000Z',
});

test('quick replies trim fields, deduplicate tags/roles, and bound content',()=>{
  const reply=validateQuickReplyInput({
    name:'  Refund   update ',body:'  Hello {user}.  ',category:'  Billing  ',
    tags:['refund','refund',' account '],allowedRoleIds:['12345678901234567','12345678901234567'],
  });
  assert.equal(reply.name,'Refund update');
  assert.equal(reply.body,'Hello {user}.');
  assert.deepEqual(reply.tags,['refund','account']);
  assert.deepEqual(reply.allowedRoleIds,['12345678901234567']);
});

test('quick replies reject unsupported interpolation and malformed role gates',()=>{
  assert.throws(()=>validateQuickReplyInput({name:'Bad reply',body:'Run {javascript} now'}),/Unsupported placeholder/);
  assert.throws(()=>validateQuickReplyInput({name:'Bad reply',body:'Run {user name} now'}),/Unsupported placeholder/);
  assert.throws(()=>validateQuickReplyInput({name:'Bad reply',body:'Run {{user}} now'}),/braces must be complete and non-nested/);
  assert.throws(()=>validateQuickReplyInput({name:'Bad reply',body:'Run {user now'}),/braces must be complete and non-nested/);
  assert.throws(()=>validateQuickReplyInput({name:'A',body:'Short'}),/2–80 characters/);
  assert.throws(()=>validateQuickReplyInput({name:'Valid',body:'Hello',allowedRoleIds:['everyone']}),/valid Discord role IDs/);
});

test('quick reply rendering replaces only allowlisted placeholders and ignores missing context',()=>{
  const output=renderQuickReply(validReply(),{
    user:'<@12345678901234567>',username:'Agent',ticketNumber:'42',priority:'urgent',
  });
  assert.equal(output,'Hello Agent, ticket 42 is urgent.');
  assert.ok(!output.includes('{ticket_number}'));
  assert.ok(!output.includes('undefined'));
});


test('quick reply tag filtering is normalized but matches complete tags only', () => {
  const tags = ['Billing Refund', 'return', 'account  access'];
  assert.equal(quickReplyHasTag(tags, ' BILLING   refund '), true);
  assert.equal(quickReplyHasTag(tags, 'RETURN'), true);
  assert.equal(quickReplyHasTag(tags, 'bill'), false);
  assert.equal(quickReplyHasTag(tags, 'access'), false);
  assert.equal(quickReplyHasTag(tags), true);
});


test('quick-reply select menu page tokens accept bounded decimal pages and reject malformed values',()=>{
  assert.equal(parseQuickReplyPage('0'),0);
  assert.equal(parseQuickReplyPage('1'),1);
  assert.equal(parseQuickReplyPage('99999'),99999);
  for (const value of ['', ' ', '-1', '+1', '1.0', '1e2', '100000', '1x', '\\d', '１２']) {
    assert.equal(parseQuickReplyPage(value),null,'Expected invalid page token: '+JSON.stringify(value));
  }
});
