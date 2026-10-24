import assert from 'node:assert/strict';
import test from 'node:test';

import { localizeFormSettingsMessage, localizeFormSettingsText } from '../src/i18n/formSettingsCopy';
import { translate } from '../src/i18n/translationService';

test('Stage H form settings maps static UI copy without rewriting server-authored names', () => {
  const home = localizeFormSettingsMessage(
    'hi-IN',
    '**Ticket Forms & Templates**\n\nManage the same versioned forms available through /supportforge form commands. Both the slash commands and this Settings panel use the same validation and Neon PostgreSQL records.',
  );
  assert.match(home, /टिकट फ़ॉर्म और टेम्पलेट/);
  assert.match(home, /स्लैश कमांड और यह Settings पैनल/);
  assert.equal(localizeFormSettingsText('hi-IN', 'List & Manage Forms'), 'फ़ॉर्म सूची और प्रबंधन');
  assert.equal(localizeFormSettingsText('bn-IN', 'Choose a form to manage'), 'পরিচালনার জন্য ফর্ম বেছে নিন');
  assert.equal(localizeFormSettingsText('hi-IN', 'Customer Support'), 'Customer Support');
});

test('Stage H form settings formats dynamic page, department, and status text safely', () => {
  assert.equal(
    localizeFormSettingsText('hi-IN', '**Ticket Forms · Page 2 / 4**'),
    '**टिकट फ़ॉर्म · पृष्ठ 2 / 4**',
  );
  assert.equal(
    localizeFormSettingsText('bn-IN', 'Department: **Billing**'),
    'বিভাগ: **Billing**',
  );
  assert.equal(
    localizeFormSettingsText('hi-IN', 'Version: **3** · Status: **ACTIVE**'),
    'संस्करण: **3** · स्थिति: **सक्रिय**',
  );
  assert.equal(
    localizeFormSettingsText('bn-IN', 'Version: **2** · Status: **Inactive**'),
    'সংস্করণ: **2** · অবস্থা: **নিষ্ক্রিয়**',
  );
});

test('Stage H report flow has complete translated category and review copy', () => {
  for (const locale of ['en-US', 'hi-IN', 'bn-IN']) {
    for (const key of [
      'ticket.report.category.title',
      'ticket.report.category.description',
      'ticket.report.category.placeholder',
      'ticket.report.subcategory.title',
      'ticket.report.subcategory.placeholder',
      'ticket.report.review.description',
      'ticket.report.review.flagButton',
      'ticket.report.review.recordOnlyButton',
    ] as const) {
      assert.ok(translate(locale, key).trim().length > 0, locale + ' is missing ' + key);
    }
  }
  assert.equal(
    translate('hi-IN', 'ticket.report.page', { page: 2, pages: 5 }),
    'पृष्ठ 2 / 5',
  );
  assert.equal(
    translate('bn-IN', 'ticket.report.page', { page: 1, pages: 3 }),
    'পৃষ্ঠা 1 / 3',
  );
});
