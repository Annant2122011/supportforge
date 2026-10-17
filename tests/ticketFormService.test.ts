import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildQuickTicketFormFields,
  getTicketFormStepCount,
  getVisibleTicketFormFields,
  parseTicketFormFields,
  validateTicketFormAnswers,
} from '../src/services/ticketFormService';

test('normalizes a valid schema and preserves optional field constraints', () => {
  const fields = parseTicketFormFields([
    {
      id: 'order_id',
      label: 'Order ID',
      type: 'short_text',
      required: true,
      minLength: 4,
      maxLength: 24,
      pattern: '^[A-Z0-9-]+$',
    },
  ]);

  assert.equal(fields[0].id, 'order_id');
  assert.equal(fields[0].minLength, 4);
  assert.equal(fields[0].maxLength, 24);
  assert.equal(fields[0].required, true);
});

test('stored normalized schemas can be validated and loaded again', () => {
  const initial = parseTicketFormFields([
    { id: 'reason', label: 'Reason', type: 'short_text', required: true, minLength: 2, maxLength: 120 },
    { id: 'payment', label: 'Payment', type: 'dropdown', required: true, choices: ['Card', 'UPI'] },
    { id: 'verified', label: 'Verified', type: 'checkbox', required: false },
  ]);

  const persistedShape = JSON.stringify({ fields: initial });
  const loaded = parseTicketFormFields(JSON.parse(persistedShape));

  assert.deepEqual(loaded, initial);
  assert.deepEqual(
    validateTicketFormAnswers(loaded, { reason: 'Help', payment: ['UPI'], verified: [] }),
    { reason: 'Help', payment: 'UPI' },
  );
});

test('rejects duplicate ids, oversized schemas and unsafe regex expressions', () => {
  assert.throws(
    () => parseTicketFormFields([
      { id: 'issue', label: 'Issue', type: 'short_text' },
      { id: 'issue', label: 'Issue 2', type: 'short_text' },
    ]),
    /Duplicate form field id/,
  );

  assert.throws(
    () => parseTicketFormFields(
      Array.from({ length: 26 }, (_, index) => ({
        id: 'field_' + index,
        label: 'Field ' + index,
        type: 'short_text',
      })),
    ),
    /between 1 and 25 custom fields/,
  );

  assert.throws(
    () => parseTicketFormFields([
      { id: 'a', label: 'A', type: 'short_text', step: 1 },
      { id: 'b', label: 'B', type: 'short_text', step: 1 },
      { id: 'c', label: 'C', type: 'short_text', step: 1 },
      { id: 'd', label: 'D', type: 'short_text', step: 1 },
    ]),
    /Step 1 contains 4 fields/,
  );

  assert.throws(
    () => parseTicketFormFields([
      { id: 'pattern', label: 'Pattern', type: 'short_text', pattern: '(a|aa)+' },
    ]),
    /potentially unsafe repetition/,
  );
});

test('conditional fields are shown only when earlier-step conditions match', () => {
  const fields = parseTicketFormFields([
    { id: 'reason', label: 'Reason', type: 'dropdown', required: true, choices: ['Question', 'Refund'] },
    { id: 'order', label: 'Order ID', type: 'short_text', required: false },
    { id: 'details', label: 'Additional details', type: 'short_text', required: false },
    {
      id: 'refund_amount',
      label: 'Refund amount',
      type: 'decimal',
      required: true,
      min: 0.01,
      step: 2,
      condition: { fieldId: 'reason', operator: 'equals', value: 'Refund' },
    },
  ]);

  assert.equal(getTicketFormStepCount(fields), 2);
  assert.deepEqual(
    getVisibleTicketFormFields(fields, 2, { reason: 'Question' }).map((field) => field.id),
    [],
  );
  assert.deepEqual(
    getVisibleTicketFormFields(fields, 2, { reason: 'Refund' }).map((field) => field.id),
    ['refund_amount'],
  );
  assert.deepEqual(
    getVisibleTicketFormFields(fields, 2, {}).map((field) => field.id),
    [],
    'a missing controller must never reveal a negative or positive condition',
  );

  assert.throws(
    () => parseTicketFormFields([
      { id: 'reason', label: 'Reason', type: 'dropdown', choices: ['Question', 'Refund'], step: 1 },
      { id: 'amount', label: 'Amount', type: 'number', step: 1, condition: { fieldId: 'reason', operator: 'equals', value: 'Refund' } },
    ]),
    /earlier step/,
  );
});

test('validates text patterns and numeric boundaries server-side', () => {
  const fields = parseTicketFormFields([
    { id: 'order', label: 'Order code', type: 'short_text', required: true, pattern: '^[A-Z]{2}-[0-9]+$' },
    { id: 'amount', label: 'Amount', type: 'decimal', required: true, min: 0.01, max: 1000 },
  ]);

  assert.deepEqual(
    validateTicketFormAnswers(fields, { order: 'AB-123', amount: '19.95' }),
    { order: 'AB-123', amount: 19.95 },
  );
  assert.throws(() => validateTicketFormAnswers(fields, { order: 'ab-123', amount: '19.95' }), /does not match/);
  assert.throws(() => validateTicketFormAnswers(fields, { order: 'AB-123', amount: '1000.01' }), /at most 1000/);
});

test('rejects impossible dates without leaking a RangeError', () => {
  const fields = parseTicketFormFields([
    { id: 'purchase_date', label: 'Purchase date', type: 'date', required: true },
  ]);

  assert.throws(
    () => validateTicketFormAnswers(fields, { purchase_date: '2025-02-30' }),
    /real date in YYYY-MM-DD/,
  );
});

test('validates single- and multi-select answers against the current choices', () => {
  const fields = parseTicketFormFields([
    { id: 'payment', label: 'Payment', type: 'dropdown', required: true, choices: ['Card', 'Crypto'] },
    { id: 'symptoms', label: 'Symptoms', type: 'multi_select', required: true, choices: ['Timeout', 'Crash', 'Other'] },
  ]);

  assert.deepEqual(
    validateTicketFormAnswers(fields, { payment: ['crypto'], symptoms: ['Crash', 'Other'] }),
    { payment: 'Crypto', symptoms: ['Crash', 'Other'] },
  );
  assert.throws(() => validateTicketFormAnswers(fields, { payment: ['Unknown'], symptoms: ['Crash'] }), /configured options/);
  assert.throws(() => validateTicketFormAnswers(fields, { payment: ['Card'], symptoms: ['Crash', 'Crash'] }), /duplicate options/);
});

test('normalizes checkbox values and leaves blank optional fields out of stored answers', () => {
  const fields = parseTicketFormFields([
    { id: 'consent', label: 'I confirm the details are correct', type: 'checkbox', required: true },
    { id: 'optional', label: 'Extra detail', type: 'short_text', required: false },
  ]);

  assert.deepEqual(
    validateTicketFormAnswers(fields, { consent: ['checked'], optional: '' }),
    { consent: true },
  );
  assert.throws(() => validateTicketFormAnswers(fields, { consent: [], optional: '' }), /is required/);
});

test('validates real uploaded attachment size, MIME type and source host', () => {
  const fields = parseTicketFormFields([
    {
      id: 'evidence',
      label: 'Evidence',
      type: 'attachment',
      required: true,
      maxBytes: 1024,
      allowedMimeTypes: ['image/png'],
    },
  ]);
  const file = {
    id: '123456789012345678',
    url: 'https://cdn.discordapp.com/attachments/123456789012345678/123456789012345678/evidence.png',
    name: 'evidence.png',
    size: 900,
    contentType: 'image/png',
  };

  assert.deepEqual(validateTicketFormAnswers(fields, { evidence: [file] }), { evidence: file });
  assert.throws(() => validateTicketFormAnswers(fields, { evidence: [{ ...file, size: 2048 }] }), /no larger than 1 KiB/);
  assert.throws(() => validateTicketFormAnswers(fields, { evidence: [{ ...file, contentType: 'application/x-msdownload' }] }), /file type .* is not allowed/);
  assert.throws(() => validateTicketFormAnswers(fields, { evidence: [{ ...file, url: 'https://example.com/evidence.png' }] }), /trusted Discord attachment host/);
});


test('guided form builder creates valid readable text questions without JSON authoring', () => {
  const fields = buildQuickTicketFormFields([' Order ID ', 'What happened?', 'Order ID']);
  assert.deepEqual(fields.map((field) => field.label), ['Order ID', 'What happened?', 'Order ID']);
  assert.deepEqual(fields.map((field) => field.id), ['order_id', 'what_happened', 'order_id_3']);
  assert.ok(fields.every((field) => field.type === 'short_text' && field.required && field.step === 1));
  assert.throws(() => buildQuickTicketFormFields(['']), /one to three/);
  assert.throws(() => buildQuickTicketFormFields(['x'.repeat(46)]), /45 characters or fewer/);
});
