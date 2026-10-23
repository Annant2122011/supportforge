import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeManagedBrandDefault } from '../src/core/domain/managedBrandDefaults';

const CURRENT_DEFAULT = 'ResolvX • Customer Support';

test('managed brand migration updates only an exact historical default', () => {
  assert.equal(normalizeManagedBrandDefault('SupportForge • Customer Support', CURRENT_DEFAULT), CURRENT_DEFAULT);
  assert.equal(normalizeManagedBrandDefault('ResolveX • Customer Support', CURRENT_DEFAULT), CURRENT_DEFAULT);
  assert.equal(normalizeManagedBrandDefault('SUPPORTFORGE • Customer Support', CURRENT_DEFAULT), CURRENT_DEFAULT);
  assert.equal(normalizeManagedBrandDefault(CURRENT_DEFAULT, CURRENT_DEFAULT), CURRENT_DEFAULT);
});

test('managed brand migration preserves administrator-authored content', () => {
  const customTexts = [
    'SupportForge Premium Help',
    'Contact ResolveX SupportForge customers',
    'SUPPORTFORGE migration notes',
    'My custom footer',
    '',
  ];

  for (const text of customTexts) {
    assert.equal(
      normalizeManagedBrandDefault(text, CURRENT_DEFAULT),
      text,
      'Custom server content must not be rewritten: ' + text,
    );
  }
});

test('managed brand migration leaves non-text and unrelated defaults untouched', () => {
  assert.equal(normalizeManagedBrandDefault(null, CURRENT_DEFAULT), null);
  assert.equal(normalizeManagedBrandDefault(42, CURRENT_DEFAULT), 42);
  assert.equal(normalizeManagedBrandDefault('SupportForge', 'Customer Support'), 'SupportForge');
});
