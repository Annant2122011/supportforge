import assert from 'node:assert/strict';
import { ButtonStyle } from 'discord.js';
import test from 'node:test';
import {
  SETTINGS_DASHBOARD_BUTTON_KEYS,
  normalizeSettingsDashboardButtonOrder,
  type AdvancedGuildSettings,
} from '../src/services/advancedSettingsService';
import {
  buildSettingsDashboardComponents,
  buildSettingsDashboardEmbed,
} from '../src/services/settingsChannelService';

test('Settings dashboard layout preserves server order while retaining every built-in control', () => {
  const partial = {
    settingsDashboard: {
      buttonOrder: ['reset', 'repair', 'dashboard-builder'],
    },
  } as unknown as AdvancedGuildSettings;
  const rows = buildSettingsDashboardComponents(partial);
  const ids = rows.flatMap((row) => row.components.map((button) => button.data.custom_id as string));

  assert.equal(ids[0], 'sf:settings:reset');
  assert.equal(ids[1], 'sf:settings:repair');
  assert.equal(ids[2], 'sf:settings:dashboard-builder');
  assert.equal(ids.length, SETTINGS_DASHBOARD_BUTTON_KEYS.length);
  assert.ok(ids.includes('sf:settings:inactivity'));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(rows.length, Math.ceil(SETTINGS_DASHBOARD_BUTTON_KEYS.length / 5));
  assert.equal(rows.every((row) => row.components.length > 0 && row.components.length <= 5), true);
});

test('default Settings layout groups navigation and leaves destructive reset at the end', () => {
  const rows = buildSettingsDashboardComponents();
  const ids = rows.map((row) => row.components.map((button) => button.data.custom_id as string));
  assert.deepEqual(ids[0], [
    'sf:settings:panel',
    'sf:settings:panels:home',
    'sf:settings:forms:home',
    'sf:settings:defaults',
    'sf:settings:tags',
  ]);
  assert.equal(ids[2]?.[0], 'sf:settings:sla');
  assert.equal(ids[2]?.[1], 'sf:settings:analytics');
  assert.equal(ids.at(-1)?.at(-1), 'sf:settings:reset');
  assert.equal(rows.at(-1)?.components.find((button) => button.data.custom_id === 'sf:settings:reset')?.data.style, ButtonStyle.Danger);
});

test('Settings dashboard preview disables every action without removing controls', () => {
  const partial = {
    settingsDashboard: {
      buttonOrder: ['theme', 'panels', 'dashboard-builder'],
    },
  } as unknown as AdvancedGuildSettings;
  const rows = buildSettingsDashboardComponents(partial, true);
  const buttons = rows.flatMap((row) => row.components);

  assert.equal(buttons.length, SETTINGS_DASHBOARD_BUTTON_KEYS.length);
  assert.equal(buttons.every((button) => button.data.disabled === true), true);
  assert.equal(buttons[0]?.data.custom_id, 'sf:settings:theme');
  assert.equal(buttons[1]?.data.custom_id, 'sf:settings:panels:home');
  assert.equal(buttons[2]?.data.custom_id, 'sf:settings:dashboard-builder');
});

test('Settings dashboard repairs partial and duplicate control orders deterministically', () => {
  const partial = {
    settingsDashboard: {
      buttonOrder: ['forms', 'forms', 'untrusted', 'reset'],
    },
  } as unknown as AdvancedGuildSettings;
  const rows = buildSettingsDashboardComponents(partial);
  const ids = rows.flatMap((row) => row.components.map((button) => button.data.custom_id as string));

  assert.equal(ids[0], 'sf:settings:forms:home');
  assert.equal(ids[1], 'sf:settings:reset');
  assert.equal(ids.length, SETTINGS_DASHBOARD_BUTTON_KEYS.length);
  assert.equal(new Set(ids).size, SETTINGS_DASHBOARD_BUTTON_KEYS.length);
});


test('Settings dashboard custom labels and emojis override presentation but keep semantic styles', () => {
  const partial = {
    settingsDashboard: {
      buttonOrder: ['reset', 'repair'],
      buttonCustomizations: {
        reset: { label: 'Danger Zone', emoji: null },
        repair: { label: 'System Tools', emoji: '🧰' },
      },
    },
  } as unknown as AdvancedGuildSettings;
  const buttons = buildSettingsDashboardComponents(partial).flatMap((row) => row.components);
  const reset = buttons.find((button) => button.data.custom_id === 'sf:settings:reset');
  const repair = buttons.find((button) => button.data.custom_id === 'sf:settings:repair');

  assert.equal(reset?.data.label, 'Danger Zone');
  assert.equal(reset?.data.style, ButtonStyle.Danger);
  assert.equal(reset?.data.emoji, undefined);
  assert.equal(repair?.data.label, 'System Tools');
  assert.equal(repair?.data.emoji?.name, '🧰');
  assert.equal(buttons.length, SETTINGS_DASHBOARD_BUTTON_KEYS.length);
});


test('Settings dashboard summarizes inactivity/workspace policy and explains retention limits', () => {
  const partial = {
    settingsDashboard: {
      title: 'ResolveX Settings',
      description: 'Server settings',
      footer: 'ResolveX',
    },
    priorityRoles: {},
    retention: { closedDays: 0, archiveDays: 7 },
    statusCategories: { claimedCategoryId: null, pendingCategoryId: null },
    panelActivity: {
      enabled: true,
      visualLineBudget: 18,
      messageBudget: 12,
      minimumMessagesBeforeMove: 6,
    },
    ticketDefaults: { priority: 'normal', maxClaimedModerators: 2 },
    inactivity: { enabled: true, idleHours: 72, graceHours: 24, generation: 1 },
    ticketWorkspace: { mode: 'private-threads' },
    appearance: {
      panelTitle: 'Support center',
      panelDescription: 'Open a support ticket.',
      panelFooter: 'ResolveX',
    },
  } as unknown as AdvancedGuildSettings;

  const embed = buildSettingsDashboardEmbed(partial, 3, 8, 'midnight').toJSON();
  assert.ok(embed.description?.includes('\n\nButton-driven configuration'));
  assert.ok(embed.fields?.some((field) =>
    field.name === '⏳ Inactivity automation' &&
    field.value.includes('Enabled') &&
    field.value.includes('72 h') &&
    field.value.includes('24 h'),
  ));
  assert.ok(embed.fields?.some((field) =>
    field.name === '🧵 Ticket workspace' && field.value === 'Private threads',
  ));
  assert.ok(embed.fields?.some((field) =>
    field.name === '🧹 Retention' && field.value.includes('No timer (365-day maximum)'),
  ));
  assert.equal(embed.fields?.some((field) => field.value.includes('Unlimited/forever')), false);
});


test('Settings layout migration groups the untouched legacy default but preserves customized order', () => {
  const legacyDefault = [
    'panel', 'defaults', 'tags', 'usecases', 'reports', 'retention', 'appearance',
    'storage', 'rules', 'repair', 'team', 'manual', 'forms', 'refresh', 'reset',
    'theme', 'premium', 'panels', 'dashboard-builder', 'support-hours', 'ticket-workspace',
  ];
  assert.deepEqual(
    normalizeSettingsDashboardButtonOrder(legacyDefault),
    [...SETTINGS_DASHBOARD_BUTTON_KEYS],
  );

  const customOrder = ['reset', 'repair', 'forms', 'panel'];
  const migratedCustom = normalizeSettingsDashboardButtonOrder(customOrder);
  assert.deepEqual(migratedCustom.slice(0, customOrder.length), customOrder);
  assert.equal(migratedCustom.length, SETTINGS_DASHBOARD_BUTTON_KEYS.length);
  assert.equal(new Set(migratedCustom).size, SETTINGS_DASHBOARD_BUTTON_KEYS.length);
});


test('Settings dashboard localizes built-in copy while preserving per-server custom text', () => {
  const defaultDescription = 'Configure your server' + String.fromCharCode(0x2019) +
    's ticket system, support panels and retention policies.';
  const partial = {
    locale: 'hi-IN',
    settingsDashboard: {
      title: '⚙️ ResolvX Settings',
      description: defaultDescription,
      footer: 'Settings for this server',
    },
    priorityRoles: {},
    retention: { closedDays: 0, archiveDays: 7 },
    statusCategories: { claimedCategoryId: null, pendingCategoryId: null },
    panelActivity: { enabled: true, visualLineBudget: 18, messageBudget: 12, minimumMessagesBeforeMove: 6 },
    ticketDefaults: { priority: 'normal', maxClaimedModerators: 2 },
    inactivity: { enabled: true, idleHours: 72, graceHours: 24, generation: 1 },
    ticketWorkspace: { mode: 'private-threads' },
    appearance: { panelTitle: 'Support center', panelDescription: 'Open a support ticket.', panelFooter: 'ResolveX' },
  } as unknown as AdvancedGuildSettings;

  const embed = buildSettingsDashboardEmbed(partial, 3, 8, 'midnight').toJSON();
  assert.ok(embed.title?.includes('सेटिंग्स'));
  assert.ok(embed.description?.includes('अपने सर्वर'));
  assert.equal(embed.description?.includes('Configure your server'), false);
  assert.ok(embed.fields?.some((field) =>
    field.name === '⏳ निष्क्रियता स्वचालन' &&
    field.value.includes('चालू') &&
    field.value.includes('72'),
  ));
});
