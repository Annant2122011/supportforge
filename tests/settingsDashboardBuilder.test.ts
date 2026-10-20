import assert from 'node:assert/strict';
import { ButtonStyle } from 'discord.js';
import test from 'node:test';
import {
  SETTINGS_DASHBOARD_BUTTON_KEYS,
  type AdvancedGuildSettings,
} from '../src/services/advancedSettingsService';
import { buildSettingsDashboardComponents } from '../src/services/settingsChannelService';

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
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(rows.length, Math.ceil(SETTINGS_DASHBOARD_BUTTON_KEYS.length / 5));
  assert.equal(rows.every((row) => row.components.length > 0 && row.components.length <= 5), true);
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
