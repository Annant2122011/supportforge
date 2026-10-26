import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbedBuilder } from 'discord.js';

import {
  applyQueryFixrBranding,
  QUERYFIXR_ACCENT_COLOR,
  queryFixrFooter,
} from '../src/interactions/brandPresentation';

test('QueryFixr embed branding is consistent and preserves the supplied accent color', () => {
  const embed = applyQueryFixrBranding(new EmbedBuilder().setTitle('Analytics'), 'Support Analytics', 0x168aad);
  const json = embed.toJSON();
  assert.equal(json.color, 0x168aad);
  assert.equal(json.author?.name, 'QueryFixr · Support Analytics');
  assert.match(json.author?.icon_url ?? '', /^https:\/\/i\.ibb\.co\//);
});

test('brand helper uses the product accent by default and bounds the footer', () => {
  const embed = applyQueryFixrBranding(new EmbedBuilder(), 'Reports');
  assert.equal(embed.toJSON().color, QUERYFIXR_ACCENT_COLOR);
  const footer = queryFixrFooter('Analytics', 'Daily UTC buckets');
  assert.equal(footer, 'QueryFixr • Analytics • Daily UTC buckets');
  assert.ok(queryFixrFooter('X'.repeat(3000)).length <= 2048);
});
