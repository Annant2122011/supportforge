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

test('all fifteen supported locales and common aliases resolve safely', () => {
  assert.deepEqual(SUPPORTED_LOCALES, [
    'en-US', 'hi-IN', 'bn-IN', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR', 'ar', 'ja-JP',
    'it-IT', 'id-ID', 'ko-KR', 'ru-RU', 'zh-CN', 'tr-TR',
  ]);
  for (const locale of SUPPORTED_LOCALES) assert.equal(isSupportedLocale(locale), true);
  assert.equal(isSupportedLocale('zh-CN'), true);
  assert.equal(resolveLocale('HI'), 'hi-IN');
  assert.equal(resolveLocale('bn'), 'bn-IN');
  assert.equal(resolveLocale('ES'), 'es-ES');
  assert.equal(resolveLocale('fr-fr'), 'fr-FR');
  assert.equal(resolveLocale('de'), 'de-DE');
  assert.equal(resolveLocale('pt'), 'pt-BR');
  assert.equal(resolveLocale('ar-sa'), 'ar');
  assert.equal(resolveLocale('ja'), 'ja-JP');
  assert.equal(resolveLocale(' en-us '), 'en-US');
  assert.equal(resolveLocale('zh-CN'), 'zh-CN');
  assert.equal(resolveLocale('it'), 'it-IT');
  assert.equal(resolveLocale('id'), 'id-ID');
  assert.equal(resolveLocale('ko'), 'ko-KR');
  assert.equal(resolveLocale('ru'), 'ru-RU');
  assert.equal(resolveLocale('zh-hans'), 'zh-CN');
  assert.equal(resolveLocale('tr'), 'tr-TR');
  assert.equal(resolveLocale('unknown-language'), 'en-US');
  assert.equal(resolveLocale(null), 'en-US');
});

test('every language dictionary contains non-empty text for every canonical key', () => {
  const keys = getTranslationKeys();
  assert.ok(keys.length >= 100);
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of keys) {
      assert.equal(hasOwnTranslation(locale, key), true, 'Expected ' + locale + ' to translate ' + key);
      assert.ok(translate(locale, key).trim().length > 0, 'Expected non-empty copy for ' + locale + '/' + key);
    }
  }
});

test('new locales translate the expanded common and ticket vocabulary', () => {
  assert.equal(translate('it-IT', 'common.close'), 'Chiudi');
  assert.equal(translate('id-ID', 'ticket.created.title', { ticketNumber: 8 }), 'Tiket #8 dibuat');
  assert.equal(translate('ko-KR', 'ticket.access.userAdded', { userName: 'Min' }), 'Min님이 이 티켓에 추가되었습니다.');
  assert.equal(translate('ru-RU', 'errors.databaseUnavailable'), 'ResolvX не удалось подключиться к базе данных. Повторите попытку немного позже.');
  assert.equal(translate('zh-CN', 'settings.locale.languageChanged', { locale: '简体中文' }), '服务器语言现在为 简体中文。');
  assert.equal(translate('tr-TR', 'retention.reviewRequired'), 'Silmeyi onaylamadan önce uygun biletleri inceleyin.');
});

test('unknown locale values safely fall back to canonical English', () => {
  assert.equal(
    translate('zh-CN', 'ticket.created.title', { ticketNumber: 42 }),
    'Ticket #42 created',
  );
  assert.equal(
    translate('es-ES', 'ticket.created.title', { ticketNumber: 42 }),
    'Ticket #42 creado',
  );
});

test('interpolation replaces parameters once and keeps inserted text literal', () => {
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
  assert.equal(
    translate('ja-JP', 'ticket.created.title', { ticketNumber: 42 }),
    'チケット #42 を作成しました',
  );
});

test('placeholder contracts are consistent across every locale', () => {
  const keys = getTranslationKeys();
  const placeholders = (value: string) =>
    [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort().join('|');
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of keys) {
      assert.equal(
        placeholders(translate(locale, key)),
        placeholders(translate('en-US', key)),
        'Placeholder mismatch for ' + locale + '/' + key,
      );
    }
  }
});

test('locale-specific numbers use locale conventions', () => {
  assert.equal(formatLocaleNumber('en-US', 1234567.89), '1,234,567.89');
  assert.equal(formatLocaleNumber('hi-IN', 1234567.89), '12,34,567.89');
  assert.notEqual(formatLocaleNumber('bn-IN', 1234567), formatLocaleNumber('en-US', 1234567));
  assert.notEqual(formatLocaleNumber('de-DE', 1234567.89), formatLocaleNumber('en-US', 1234567.89));
  assert.throws(() => formatLocaleNumber('en-US', Number.NaN), RangeError);
});

test('date formatting is locale-aware and rejects invalid dates', () => {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  };
  const english = formatLocaleDate('en-US', '2026-04-05T00:00:00.000Z', options);
  const hindi = formatLocaleDate('hi-IN', '2026-04-05T00:00:00.000Z', options);
  const japanese = formatLocaleDate('ja-JP', '2026-04-05T00:00:00.000Z', options);
  assert.equal(english, '04/05/2026');
  assert.notEqual(hindi, english);
  assert.notEqual(japanese, english);
  assert.throws(() => formatLocaleDate('en-US', 'not-a-date'), RangeError);
});
