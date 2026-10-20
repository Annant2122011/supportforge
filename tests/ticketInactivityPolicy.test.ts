import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateTicketInactivity,
  getTicketInactivityAnchor,
  normalizeInactivitySettings,
  type TicketInactivityState,
} from '../src/core/domain/ticketInactivityPolicy';

const now = Date.parse('2026-10-20T12:00:00.000Z');
const activeTicket = (overrides: Partial<TicketInactivityState> = {}): TicketInactivityState => ({
  status: 'open',
  deletedAt: null,
  createdAt: '2026-10-16T12:00:00.000Z',
  updatedAt: '2026-10-16T12:00:00.000Z',
  metadata: { lastActivityAt: '2026-10-16T12:00:00.000Z' },
  ...overrides,
});

const policy = { enabled: true, idleHours: 72, graceHours: 24 };

test('inactivity automation is off by default and durations are bounded', () => {
  assert.deepEqual(normalizeInactivitySettings(undefined), { enabled: false, idleHours: 72, graceHours: 24 });
  assert.deepEqual(normalizeInactivitySettings({ enabled: true, idleHours: 0, graceHours: 999 }), {
    enabled: true, idleHours: 1, graceHours: 168,
  });
  assert.equal(evaluateTicketInactivity(activeTicket(), undefined, now).action, 'skip');
});

test('warning starts only after the configured idle threshold', () => {
  assert.deepEqual(evaluateTicketInactivity(activeTicket(), policy, now - 1), {
    action: 'wait',
    anchorAt: '2026-10-16T12:00:00.000Z',
    warningAt: Date.parse('2026-10-19T12:00:00.000Z'),
  });
  assert.equal(evaluateTicketInactivity(activeTicket(), policy, Date.parse('2026-10-19T12:00:00.000Z')).action, 'warn');
});

test('grace deadline is durable across restarts and closure is inclusive at the deadline', () => {
  const warned = activeTicket({
    metadata: {
      lastActivityAt: '2026-10-16T12:00:00.000Z',
      inactivityWarningAnchorAt: '2026-10-16T12:00:00.000Z',
      inactivityWarningDeadlineAt: '2026-10-20T11:59:59.000Z',
      inactivityWarningMessageId: '123',
    },
  });
  assert.deepEqual(evaluateTicketInactivity(warned, policy, now), {
    action: 'close',
    anchorAt: '2026-10-16T12:00:00.000Z',
    deadlineAt: '2026-10-20T11:59:59.000Z',
  });
  assert.equal(evaluateTicketInactivity({ ...warned, metadata: { ...warned.metadata, inactivityWarningDeadlineAt: '2026-10-20T12:00:01.000Z' } }, policy, now).action, 'grace');
});

test('new activity invalidates the prior warning and grace period', () => {
  const active = activeTicket({
    metadata: {
      lastActivityAt: '2026-10-20T11:00:00.000Z',
      inactivityWarningAnchorAt: '2026-10-16T12:00:00.000Z',
      inactivityWarningDeadlineAt: '2026-10-17T12:00:00.000Z',
    },
  });
  assert.equal(evaluateTicketInactivity(active, policy, now).action, 'wait');
  assert.equal(getTicketInactivityAnchor(active), '2026-10-20T11:00:00.000Z');
});

test('deleted and terminal tickets can never be auto-closed', () => {
  assert.equal(evaluateTicketInactivity(activeTicket({ deletedAt: now.toString() }), policy, now).action, 'skip');
  assert.equal(evaluateTicketInactivity(activeTicket({ status: 'closed' }), policy, now).action, 'skip');
  assert.equal(evaluateTicketInactivity(activeTicket({ status: 'archived' }), policy, now).action, 'skip');
});

test('invalid timestamps fall back to the next durable timestamp or skip safely', () => {
  const ticket = activeTicket({ metadata: { lastActivityAt: 'not-a-date' }, updatedAt: 'not-a-date', createdAt: '2026-10-17T00:00:00.000Z' });
  assert.equal(getTicketInactivityAnchor(ticket), '2026-10-17T00:00:00.000Z');
  assert.equal(evaluateTicketInactivity(activeTicket({ metadata: {}, updatedAt: 'bad', createdAt: 'bad' }), policy, now).action, 'skip');
});
