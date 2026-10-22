import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasExemptInactivityRole,
  isDepartmentExemptFromInactivity,
  normalizeInactivityExemptionIds,
  MAX_INACTIVITY_EXEMPTIONS,
} from '../src/core/domain/ticketInactivityExemptions';

test('normalizes malformed, duplicate and oversized exemption lists safely', () => {
  assert.deepEqual(normalizeInactivityExemptionIds(null), []);
  assert.deepEqual(normalizeInactivityExemptionIds([' role-a ', 'role-a', '', 3, 'role-b']), ['role-a', 'role-b']);
  assert.equal(normalizeInactivityExemptionIds(Array.from({ length: 35 }, (_, index) => 'role-' + index)).length, MAX_INACTIVITY_EXEMPTIONS);
  assert.deepEqual(normalizeInactivityExemptionIds(['x'.repeat(101)]), []);
});

test('department exemptions match exact configured department IDs only', () => {
  assert.equal(isDepartmentExemptFromInactivity('billing', ['billing', 'returns']), true);
  assert.equal(isDepartmentExemptFromInactivity('billing-old', ['billing', 'returns']), false);
  assert.equal(isDepartmentExemptFromInactivity(null, ['billing']), false);
});

test('role exemptions match the owner or assigned staff role set by exact ID', () => {
  assert.equal(hasExemptInactivityRole(['staff', 'vip'], ['vip']), true);
  assert.equal(hasExemptInactivityRole(['staff'], ['vip']), false);
  assert.equal(hasExemptInactivityRole(['staff'], []), false);
});
