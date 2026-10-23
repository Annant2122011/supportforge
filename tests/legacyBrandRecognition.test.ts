import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isManagedDepartmentCategoryName,
  isRecoveryArchiveFooter,
  isTicketPanelTitle,
} from '../src/core/domain/legacyBrandRecognition';

test('ticket panel recovery recognizes current and historical product names', () => {
  for (const brand of ['QueryFixr', 'Resolv' + 'X', 'Resolve' + 'X', 'Support' + 'Forge']) {
    assert.equal(isTicketPanelTitle('🎫 ' + brand + ' Ticket #123'), true, brand);
  }
  assert.equal(isTicketPanelTitle('🎫 QueryFixr settings'), false);
  assert.equal(isTicketPanelTitle(null), false);
});

test('recovered archive messages remain recognizable after branding changes', () => {
  for (const brand of ['QueryFixr', 'Resolv' + 'X', 'Resolve' + 'X', 'Support' + 'Forge']) {
    assert.equal(isRecoveryArchiveFooter(brand + ' Recovery Archive • Original message ID 123'), true, brand);
  }
  assert.equal(isRecoveryArchiveFooter('QueryFixr • Audit Panel'), false);
  assert.equal(isRecoveryArchiveFooter(undefined), false);
});

test('only product-managed department category prefixes are normalized', () => {
  for (const brand of ['QueryFixr', 'Resolv' + 'X', 'Resolve' + 'X', 'Support' + 'Forge']) {
    assert.equal(isManagedDepartmentCategoryName(brand + '.Technical Support'), true, brand);
  }
  assert.equal(isManagedDepartmentCategoryName('Customer Support'), false);
});
