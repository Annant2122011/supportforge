import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRequiredOptionOrder, type CommandOptionPayload } from '../src/commands/optionOrdering';

test('orders required arguments before optional arguments at every nested command depth', () => {
  const input: CommandOptionPayload = {
    name: 'supportforge',
    options: [
      {
        name: 'ticket',
        options: [
          {
            name: 'report',
            options: [
              { name: 'target', required: true },
              { name: 'category-id', required: true },
              { name: 'subcategory-id', required: true },
              { name: 'description', required: false },
              { name: 'flag', required: true },
            ],
          },
        ],
      },
      {
        name: 'diagnostics',
        options: [
          {
            name: 'sla-set',
            options: [
              { name: 'department-id', required: false },
              { name: 'priority', required: false },
              { name: 'first-response-minutes', required: true },
              { name: 'claim-minutes', required: false },
              { name: 'resolution-minutes', required: true },
            ],
          },
        ],
      },
    ],
  };

  const normalized = normalizeRequiredOptionOrder(input);
  const ticketOptions = normalized.options?.[0].options?.[0].options ?? [];
  assert.deepEqual(ticketOptions.map((option) => option.name), [
    'target', 'category-id', 'subcategory-id', 'flag', 'description',
  ]);
  const slaOptions = normalized.options?.[1].options?.[0].options ?? [];
  assert.deepEqual(slaOptions.map((option) => option.name), [
    'first-response-minutes', 'resolution-minutes',
    'department-id', 'priority', 'claim-minutes',
  ]);

  assert.deepEqual(input.options?.[0].options?.[0].options?.map((option) => option.name), [
    'target', 'category-id', 'subcategory-id', 'description', 'flag',
  ]);
});

test('preserves top-level group and subcommand ordering', () => {
  const input: CommandOptionPayload = {
    options: [
      { name: 'first-group', options: [{ name: 'first-subcommand' }] },
      { name: 'second-group', options: [{ name: 'second-subcommand' }] },
    ],
  };

  const normalized = normalizeRequiredOptionOrder(input);
  assert.deepEqual(normalized.options?.map((option) => option.name), ['first-group', 'second-group']);
  assert.deepEqual(normalized.options?.[0].options?.map((option) => option.name), ['first-subcommand']);
});
