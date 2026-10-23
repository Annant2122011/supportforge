import assert from 'node:assert/strict';
import test from 'node:test';

import { getLocaleLabel, LOCALE_OPTIONS, isSupportedLocale } from '../src/i18n/localeRegistry';
import { translate } from '../src/i18n/translationService';
import { buildSettingsDashboardComponents } from '../src/services/settingsChannelService';

process.env.DISCORD_TOKEN ??= 'test-only-command-registration-token';

interface CommandOption {
  name?: string;
  type?: number;
  options?: CommandOption[];
  choices?: Array<{ value: string }>;
}

test('Stage H2 exposes exactly the supported locale set through the Settings slash command', async () => {
  const { data } = await import('../src/commands/supportforge');
  const root = data.toJSON().options as unknown as CommandOption[];
  const settings = root.find((option) => option.name === 'settings' && option.type === 2);
  assert.ok(settings, 'Expected the Settings command group');

  const language = settings.options?.find((option) => option.name === 'language' && option.type === 1);
  assert.ok(language, 'Expected /supportforge settings language');

  const locale = language.options?.find((option) => option.name === 'locale' && option.type === 3);
  assert.ok(locale, 'Expected the optional locale selector');
  assert.deepEqual(locale.choices?.map((choice) => choice.value), LOCALE_OPTIONS.map((option) => option.value));
  assert.equal(LOCALE_OPTIONS.every((option) => isSupportedLocale(option.value)), true);

  const dashboardHasLanguage = buildSettingsDashboardComponents().some((row) =>
    row.components.some((button) => button.data.custom_id === 'sf:settings:language'),
  );
  assert.equal(dashboardHasLanguage, true, 'The Settings dashboard must expose the same locale capability');
});

test('locale labels and language-control copy are safe for all supported locales', () => {
  assert.equal(getLocaleLabel('en-US'), 'English (United States)');
  assert.match(getLocaleLabel('hi-IN'), /हिन्दी/);
  assert.match(getLocaleLabel('bn-IN'), /বাংলা/);
  assert.equal(translate('hi-IN', 'settings.locale.current', { locale: getLocaleLabel('hi-IN') }).includes('{locale}'), false);
  assert.equal(translate('bn-IN', 'settings.locale.prompt').length > 0, true);
  assert.equal(translate('hi-IN', 'ticket.created.title', { ticketNumber: 42 }), 'टिकट #42 बनाया गया');
  assert.equal(translate('hi-IN', 'ticket.status.reopened'), 'फिर से खोला गया');
  assert.equal(
    translate('hi-IN', 'ticket.status.commandSuccess', { ticketNumber: 42, status: translate('hi-IN', 'ticket.status.pending') }),
    'टिकट #42 अब लंबित है।',
  );
  assert.equal(
    translate('bn-IN', 'ticket.priority.commandSuccess', { ticketNumber: 17, priority: translate('bn-IN', 'priority.urgent') }),
    'টিকিট #17-এর অগ্রাধিকার এখন জরুরি।',
  );
  assert.equal(translate('hi-IN', 'forms.expired').includes('समय-सीमा समाप्त'), true);
  assert.equal(translate('bn-IN', 'forms.continuation.invalid').includes('আবার খুলে'), true);
  const outsideHours = translate('hi-IN', 'ticket.intake.outsideHours', {
    timezone: 'Asia/Kolkata',
    nextOpening: translate('hi-IN', 'ticket.intake.nextOpening', { nextOpening: '9:00 AM' }),
  });
  assert.match(outsideHours, /Asia\/Kolkata/);
  assert.equal(outsideHours.includes('{timezone}'), false);
  assert.equal(translate('invalid-locale', 'settings.locale.unknown'), 'That language is not supported. Choose one of the available options.');
});
