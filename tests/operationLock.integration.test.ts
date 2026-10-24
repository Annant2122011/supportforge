import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { withPostgresAdvisoryLock } from '../src/core/persistence/operationLock';

const hasPostgres =
  process.env.SUPPORTFORGE_POSTGRES_TEST === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DATABASE_URL_UNPOOLED);
const isLocalPostgres = /@(localhost|127\.0\.0\.1)(:\d+)?\//i.test(process.env.DATABASE_URL ?? '');
const integrationEnabled = hasPostgres && isLocalPostgres;

if (hasPostgres && !isLocalPostgres) {
  throw new Error('Refusing advisory-lock integration tests against a non-local database.');
}

test('PostgreSQL advisory operation locks reject overlap, release after success, and release after failure', { skip: !integrationEnabled }, async () => {
  const key = 'resolvx-lock-test:' + randomUUID();
  let markAcquired!: () => void;
  let releaseFirst!: () => void;
  const acquired = new Promise<void>((resolve) => { markAcquired = resolve; });
  const hold = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = withPostgresAdvisoryLock(key, 'already running', async () => {
    markAcquired();
    await hold;
    return 'first';
  });
  await acquired;

  await assert.rejects(
    withPostgresAdvisoryLock(key, 'already running', async () => 'should not run'),
    /already running/,
  );
  releaseFirst();
  assert.equal(await first, 'first');

  assert.equal(
    await withPostgresAdvisoryLock(key, 'already running', async () => 'after success'),
    'after success',
  );

  await assert.rejects(
    withPostgresAdvisoryLock(key, 'already running', async () => { throw new Error('simulated operation failure'); }),
    /simulated operation failure/,
  );
  assert.equal(
    await withPostgresAdvisoryLock(key, 'already running', async () => 'after failure'),
    'after failure',
  );
});
