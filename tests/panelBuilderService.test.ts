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
  footer: 'ResolveX Support',
  color: '22D3EE',
  thumbnailUrl: null,
  bannerUrl: null,
  buttons: [
    { departmentId: 'billing', label: 'Billing', emoji: '💳', style: 'primary' },
    { departmentId: 'technical', label: 'Technical', emoji: '🛠️', style: 'success' },
  ],
  publishedChannelId: null,
  publishedMessageId: null,
  createdAt: '2026-10-18T10:00:00.000Z',
  updatedAt: '2026-10-18T10:00:00.000Z',
};

test('custom panel button schema preserves order and supports existing department routing IDs', () => {
  const buttons = parseCustomPanelButtons(JSON.stringify([
    { departmentId: 'technical', label: 'Technical Help', emoji: '🛠️', style: 'success' },
    { departmentId: 'billing', label: 'Billing', style: 'secondary' },
  ]), departments);
  assert.deepEqual(buttons.map((button) => button.departmentId), ['technical', 'billing']);
  assert.equal(buttons[0]?.style, 'success');
  assert.equal(buttons[1]?.style, 'secondary');
});

test('custom panel button validation rejects unknown departments and malformed input', () => {
  assert.throws(() => parseCustomPanelButtons([{ departmentId: 'missing', label: 'Help' }], departments), /unknown department/);
  assert.throws(() => parseCustomPanelButtons('{bad json', departments), /valid JSON/);
  assert.throws(() => parseCustomPanelButtons([], departments), /between 1 and 25/);
  assert.throws(() => parseCustomPanelButtons([{ departmentId: 'billing', label: 'x'.repeat(81) }], departments), /label/);
  assert.throws(() => parseCustomPanelButtons([{ departmentId: 'billing', label: 'Billing', style: 'link' }], departments), /style/);
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
  assert.equal(publishedButtons[0]?.data.custom_id, 'ticket:create:billing');
  assert.equal(publishedButtons[1]?.data.custom_id, 'ticket:create:technical');
});

test('custom panel embed renders its configured title, description, color, and banner', () => {
  const panel = { ...examplePanel, bannerUrl: 'https://cdn.example.com/banner.png' };
  const embed = buildCustomPanelEmbed(panel, 'Example Server', 0x5865f2, false).toJSON();
  assert.equal(embed.title, 'How can we help?');
  assert.equal(embed.description, 'Choose a department to start a ticket.');
  assert.equal(embed.color, 0x22d3ee);
  assert.equal(embed.image?.url, 'https://cdn.example.com/banner.png');
});
