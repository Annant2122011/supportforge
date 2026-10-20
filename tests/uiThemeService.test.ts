import assert from 'node:assert/strict';
import test from 'node:test';

import { getThemeColor, getThemeDefinition, isGuildTheme, UI_THEMES } from '../src/services/uiThemeService';

test('theme keys are unique and every theme has a valid Discord embed color', () => {
  const ids = UI_THEMES.map((theme) => theme.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const theme of UI_THEMES) {
    assert.ok(theme.color >= 0 && theme.color <= 0xffffff);
    assert.ok(theme.label.length > 0);
  }
  assert.equal(isGuildTheme('cyber-neon'), true);
  assert.equal(isGuildTheme('not-a-theme'), false);
});

test('unknown legacy theme values fall back to the default palette', () => {
  assert.equal(getThemeDefinition('unknown-theme').id, 'midnight');
  assert.equal(getThemeColor('unknown-theme'), getThemeColor('midnight'));
});
