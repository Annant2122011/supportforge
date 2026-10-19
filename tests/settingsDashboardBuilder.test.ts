import assert from 'node:assert/strict';
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
  assert.equal(rows.length, 4);
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
