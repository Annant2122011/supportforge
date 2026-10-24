import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCustomPanelComponents,
  buildCustomPanelEmbed,
  normalizePanelColor,
  normalizePanelUrl,
  parseCustomPanelButtons,
} from '../src/services/panelBuilderService';
import type { CustomSupportPanel, DepartmentConfig } from '../src/services/configService';
import type { TicketFormVersion } from '../src/services/ticketFormService';

const departments: Record<string, DepartmentConfig> = {
  billing: {
    id: 'billing',
    name: 'Billing',
    staffRoleId: null,
    tags: { refund: { id: 'refund', name: 'Refund', createdAt: '2026-10-01T00:00:00.000Z' } },
    createdAt: '2026-10-01T00:00:00.000Z',
  },
  technical: {
    id: 'technical',
    name: 'Technical',
    staffRoleId: null,
    tags: { bug: { id: 'bug', name: 'Bug', createdAt: '2026-10-01T00:00:00.000Z' } },
    createdAt: '2026-10-01T00:00:00.000Z',
  },
};

const examplePanel: CustomSupportPanel = {
  id: 'abc123def456',
  name: 'Customer Care',
  title: 'How can we help?',
  description: 'Choose a department to start a ticket.',
  footer: 'ResolvX Support',
  color: '22D3EE',
  iconUrl: null,
  thumbnailUrl: null,
  bannerUrl: null,
  allowedRoleIds: [],
  buttons: [
    { id: 'buttonbill1', targetType: 'department', departmentId: 'billing', formId: null, formVersion: null, tagId: null, label: 'Billing', emoji: '💳', style: 'primary', confirmationMessage: null, allowedRoleIds: [] },
    { id: 'buttontech1', targetType: 'department', departmentId: 'technical', formId: null, formVersion: null, tagId: null, label: 'Technical', emoji: '🛠️', style: 'success', confirmationMessage: null, allowedRoleIds: [] },
  ],
  publishedChannelId: null,
  publishedMessageId: null,
  publishedConfig: null,
  createdAt: '2026-10-18T10:00:00.000Z',
  updatedAt: '2026-10-18T10:00:00.000Z',
};

const exampleForm = {
  id: '12345678-1234-1234-1234-123456789abc',
  guildId: 'guild',
  name: 'Refund Request',
  departmentId: 'billing',
  tagId: null,
  currentVersion: 2,
  version: 2,
  active: true,
  createdBy: 'admin',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  fields: [],
  snapshot: {
    id: '12345678-1234-1234-1234-123456789abc',
    name: 'Refund Request',
    departmentId: 'billing',
    tagId: null,
    version: 2,
    fields: [],
  },
} satisfies TicketFormVersion;

test('custom panel button schema preserves order and supports existing department routing IDs', () => {
  const buttons = parseCustomPanelButtons(JSON.stringify([
    { departmentId: 'technical', label: 'Technical Help', emoji: '🛠️', style: 'success' },
    { departmentId: 'billing', label: 'Billing', style: 'secondary' },
  ]), departments);
  assert.deepEqual(buttons.map((button) => button.departmentId), ['technical', 'billing']);
  assert.equal(buttons[0]?.style, 'success');
  assert.equal(buttons[1]?.style, 'secondary');
  assert.equal(buttons[0]?.targetType, 'department');
  assert.ok(buttons[0]?.id);
});

test('custom panel buttons reject invalid emoji strings and preserve valid Unicode/custom emoji', () => {
  const unicode = parseCustomPanelButtons([
    { departmentId: 'billing', label: 'Tickets', emoji: '🎫' },
  ], departments);
  assert.equal(unicode[0]?.emoji, '🎫');

  const custom = parseCustomPanelButtons([
    { departmentId: 'billing', label: 'Tickets', emoji: '<:support:12345678901234567>' },
  ], departments);
  assert.equal(custom[0]?.emoji, '<:support:12345678901234567>');

  assert.throws(() => parseCustomPanelButtons([
    { departmentId: 'billing', label: 'Tickets', emoji: 'please' },
  ], departments), /Unicode emoji or Discord custom emoji/);
});

test('custom panel button validation rejects unknown departments and malformed input', () => {
  assert.throws(() => parseCustomPanelButtons([{ departmentId: 'missing', label: 'Help' }], departments), /unknown department/);
  assert.throws(() => parseCustomPanelButtons('{bad json', departments), /valid JSON/);
  assert.throws(() => parseCustomPanelButtons([], departments), /0–25 buttons/);
  assert.throws(() => parseCustomPanelButtons([{ departmentId: 'billing', label: 'x'.repeat(81) }], departments), /label/);
  assert.throws(() => parseCustomPanelButtons([{ departmentId: 'billing', label: 'Billing', style: 'link' }], departments), /style/);
  assert.throws(() => parseCustomPanelButtons([
    { id: 'duplicate1', departmentId: 'billing', label: 'Billing' },
    { id: 'duplicate1', departmentId: 'technical', label: 'Technical' },
  ], departments), /Button IDs must be unique/);
  assert.throws(() => parseCustomPanelButtons([{ targetType: 'department', departmentId: 'billing', tagId: 'missing', label: 'Refund' }], departments), /tagId/);
  assert.throws(() => parseCustomPanelButtons([{ targetType: 'department', departmentId: 'billing', label: 'Refund', allowedRoleIds: ['not-a-role-id'] }], departments), /invalid Discord role ID/);
});

test('custom panel image URLs allow HTTP(S) only and reject credential-bearing URLs', () => {
  assert.equal(normalizePanelUrl('https://cdn.example.com/banner.png', 'Banner URL'), 'https://cdn.example.com/banner.png');
  assert.throws(() => normalizePanelUrl('javascript:alert(1)', 'Banner URL'), /HTTP\(S\)/);
  assert.throws(() => normalizePanelUrl('https://user:pass@example.com/image.png', 'Banner URL'), /without embedded credentials/);
  assert.equal(normalizePanelUrl(undefined, 'Banner URL'), null);
});

test('custom panel colors normalize six-digit hex values', () => {
  assert.equal(normalizePanelColor('#22d3ee'), '22D3EE');
  assert.equal(normalizePanelColor(undefined), null);
  assert.throws(() => normalizePanelColor('red'), /six-digit hex/);
});

test('custom panel preview disables ticket buttons while published controls retain stable ticket custom IDs', () => {
  const preview = buildCustomPanelComponents(examplePanel, true);
  const published = buildCustomPanelComponents(examplePanel, false);
  const previewButtons = preview.flatMap((row) => row.components);
  const publishedButtons = published.flatMap((row) => row.components);
  assert.equal(previewButtons.length, 2);
  assert.equal(publishedButtons.length, 2);
  assert.equal(previewButtons.every((button) => button.data.disabled === true), true);
  assert.equal(publishedButtons.every((button) => button.data.disabled !== true), true);
  assert.equal(publishedButtons[0]?.data.custom_id, 'ticket:custom:abc123def456:buttonbill1');
  assert.equal(publishedButtons[1]?.data.custom_id, 'ticket:custom:abc123def456:buttontech1');
});

test('custom panels accept at most 25 ordered controls and publish within Discord row limits', () => {
  const buttons = Array.from({ length: 25 }, (_, index) => ({
    departmentId: index % 2 === 0 ? 'billing' : 'technical',
    label: 'Support option ' + (index + 1),
    style: 'primary',
  }));
  const parsed = parseCustomPanelButtons(buttons, departments);
  assert.equal(parsed.length, 25);
  const rows = buildCustomPanelComponents({ ...examplePanel, buttons: parsed }, false);
  assert.equal(rows.length, 5);
  assert.equal(rows.every((row) => row.components.length <= 5), true);
  assert.equal(rows.flatMap((row) => row.components).length, 25);
  assert.throws(() => parseCustomPanelButtons([...buttons, buttons[0]], departments), /0–25 buttons/);
});

test('custom panel embed renders its configured title, description, color, and banner', () => {
  const panel = { ...examplePanel, bannerUrl: 'https://cdn.example.com/banner.png' };
  const embed = buildCustomPanelEmbed(panel, 'Example Server', 0x5865f2, false).toJSON();
  assert.equal(embed.title, 'How can we help?');
  assert.equal(embed.description, 'Choose a department to start a ticket.');
  assert.equal(embed.color, 0x22d3ee);
  assert.equal(embed.image?.url, 'https://cdn.example.com/banner.png');
});

test('custom panel fallback and preview copy follows the selected server locale', () => {
  const panel = { ...examplePanel, description: '', footer: '', bannerUrl: undefined, thumbnailUrl: undefined };
  const hindi = buildCustomPanelEmbed(panel, 'Example Server', 0x5865f2, true, false, 'hi-IN').toJSON();
  assert.equal(hindi.description, 'सहायता अनुरोध शुरू करने के लिए नीचे दिया गया विकल्प चुनें।');
  assert.equal(hindi.footer?.text, 'QueryFixr • ग्राहक सहायता');
  assert.equal(hindi.fields?.[0]?.name, 'पूर्वावलोकन');
  const bengali = buildCustomPanelEmbed(panel, 'Example Server', 0x5865f2, false, false, 'bn-IN').toJSON();
  assert.equal(bengali.description, 'সাপোর্টের অনুরোধ শুরু করতে নিচের একটি বিকল্প বেছে নিন।');
  assert.equal(bengali.footer?.text, 'QueryFixr • গ্রাহক সহায়তা');
});

test('custom panel form buttons pin an active form version and concrete tag', () => {
  const buttons = parseCustomPanelButtons([{
    targetType: 'form',
    formId: exampleForm.id,
    tagId: 'refund',
    label: 'Open Refund Form',
    confirmationMessage: 'This opens a refund request. Continue?',
    allowedRoleIds: ['12345678901234567'],
  }], departments, [exampleForm]);
  assert.equal(buttons[0]?.targetType, 'form');
  assert.equal(buttons[0]?.formId, exampleForm.id);
  assert.equal(buttons[0]?.formVersion, 2);
  assert.equal(buttons[0]?.departmentId, 'billing');
  assert.equal(buttons[0]?.tagId, 'refund');
  assert.equal(buttons[0]?.confirmationMessage, 'This opens a refund request. Continue?');
  assert.deepEqual(buttons[0]?.allowedRoleIds, ['12345678901234567']);
});

test('custom panel form buttons reject disabled forms, mismatched tags and missing concrete tags', () => {
  assert.throws(() => parseCustomPanelButtons([{
    targetType: 'form', formId: exampleForm.id, tagId: 'refund', label: 'Refund',
  }], departments, [{ ...exampleForm, active: false }]), /missing or inactive/);
  assert.throws(() => parseCustomPanelButtons([{
    targetType: 'form', formId: exampleForm.id, label: 'Refund',
  }], departments, [exampleForm]), /concrete tag/);
  assert.throws(() => parseCustomPanelButtons([{
    targetType: 'form', formId: exampleForm.id, tagId: 'missing', label: 'Refund',
  }], departments, [exampleForm]), /not a tag/);
});

test('empty drafts are allowed only when explicitly requested and draft confirmations are bounded', () => {
  assert.deepEqual(parseCustomPanelButtons([], departments, [], true), []);
  assert.throws(() => parseCustomPanelButtons([], departments), /at least one button/);
  assert.throws(() => parseCustomPanelButtons([{
    departmentId: 'billing', label: 'Billing', confirmationMessage: 'x'.repeat(1001),
  }], departments), /confirmationMessage/);
});
