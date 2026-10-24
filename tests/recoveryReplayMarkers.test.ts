import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractRecoverySegmentMarkers,
  recoverySegmentMarker,
} from '../src/core/domain/recoveryReplayMarkers';

test('recovery segment markers are deterministic for the same replay segment', () => {
  const first = recoverySegmentMarker('event-1', 'message-1', 'content:0');
  const retry = recoverySegmentMarker('event-1', 'message-1', 'content:0');
  assert.equal(first, retry);
  assert.equal(first.length, 66);
  assert.deepEqual(extractRecoverySegmentMarkers(['prefix' + first + 'suffix']), [first]);
});

test('recovery segment markers isolate event, message and segment identity', () => {
  const a = recoverySegmentMarker('event-1', 'message-1', 'header');
  const b = recoverySegmentMarker('event-2', 'message-1', 'header');
  const c = recoverySegmentMarker('event-1', 'message-2', 'header');
  const d = recoverySegmentMarker('event-1', 'message-1', 'content:0');
  assert.equal(new Set([a,b,c,d]).size, 4);
});

test('recovery marker extraction finds multiple markers across message content and embed footers', () => {
  const header = recoverySegmentMarker('event-1', 'message-1', 'header');
  const part = recoverySegmentMarker('event-1', 'message-1', 'content:0');
  const attachment = recoverySegmentMarker('event-1', 'message-2', 'attachment:file-1');
  assert.deepEqual(
    extractRecoverySegmentMarkers([
      'restored text ' + part,
      'unrelated content',
      'archive footer ' + header + ' extra ' + attachment,
    ]),
    [part, header, attachment],
  );
});

test('recovery marker extraction ignores ordinary invisible characters and malformed markers', () => {
  assert.deepEqual(
    extractRecoverySegmentMarkers(['\u200B\u2063' + '\u200B'.repeat(63) + '\u2063']),
    [],
  );
});
