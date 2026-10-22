import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSupportedLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from '../src/i18n/localeRegistry';
import {
  formatLocaleDate,
  formatLocaleNumber,
  getTranslationKeys,
  hasOwnTranslation,
  translate,
} from '../src/i18n/translationService';

test('supported locale registry accepts canonical tags and safely resolves aliases', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['en-US', 'hi-IN', 'bn-IN']);
  assert.equal(isSupportedLocale('hi-IN'), true);
  assert.equal(isSupportedLocale('fr-FR'), false);
  assert.equal(resolveLocale('HI'), 'hi-IN');
  assert.equal(resolveLocale('bn'), 'bn-IN');
  assert.equal(resolveLocale(' en-us '), 'en-US');
  assert.equal(resolveLocale('fr-FR'), 'en-US');
  assert.equal(resolveLocale(null), 'en-US');
});

test('canonical English catalog contains non-empty copy for every registered key', () => {
  const keys = getTranslationKeys();
  assert.ok(keys.length >= 25);
  for (const key of keys) {
    assert.equal(hasOwnTranslation('en-US', key), true, 'Expected canonical copy for ' + key);
    assert.ok(translate('en-US', key).trim().length > 0, 'Expected non-empty copy for ' + key);
  }
});

test('partial translations fall back to English on a key-by-key basis', () => {
  const english = translate('en-US', 'ticket.intake.outsideHours', { nextOpening: '09:00 UTC' });
  const bengaliFallback = translate('bn-IN', 'ticket.intake.outsideHours', { nextOpening: '09:00 UTC' });
  assert.equal(bengaliFallback, english);
  assert.equal(translate('unknown-locale', 'ticket.created.title', { ticketNumber: 42 }), 'Ticket #42 created');
});

test('interpolation replaces supplied parameters once and preserves missing placeholders', () => {
  assert.equal(
    translate('en-US', 'ticket.claimed', {
      staffName: '{ticketNumber} $& $1',
      ticketNumber: 42,
    }),
    'This ticket has been claimed by {ticketNumber} $& $1.',
  );
  assert.equal(
    translate('hi-IN', 'ticket.created.title', {}),
    'टिकट #{ticketNumber} बनाया गया',
  );
});

test('locale-specific number formatting follows Intl grouping conventions', () => {
  assert.equal(formatLocaleNumber('en-US', 1234567.89), '1,234,567.89');
  assert.equal(formatLocaleNumber('hi-IN', 1234567.89), '12,34,567.89');
  assert.notEqual(formatLocaleNumber('bn-IN', 1234567), formatLocaleNumber('en-US', 1234567));
  assert.throws(() => formatLocaleNumber('en-US', Number.NaN), RangeError);
});

test('date formatting is locale-aware and refuses invalid dates', () => {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  };
  const english = formatLocaleDate('en-US', '2026-04-05T00:00:00.000Z', options);
  const hindi = formatLocaleDate('hi-IN', '2026-04-05T00:00:00.000Z', options);
  assert.equal(english, '04/05/2026');
  assert.notEqual(hindi, english);
  assert.throws(() => formatLocaleDate('en-US', 'not-a-date'), RangeError);
});
