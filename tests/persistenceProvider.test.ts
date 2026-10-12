import assert from 'node:assert/strict';
import test from 'node:test';

import { getPersistenceProvider } from '../src/core/persistence/provider';

function withProvider(
  value: string | undefined,
  callback: () => void,
): void {
  const previous = process.env.SUPPORTFORGE_DATABASE_PROVIDER;
  if (value === undefined) {
    delete process.env.SUPPORTFORGE_DATABASE_PROVIDER;
  } else {
    process.env.SUPPORTFORGE_DATABASE_PROVIDER = value;
  }

  try {
    callback();
  } finally {
    if (previous === undefined) {
      delete process.env.SUPPORTFORGE_DATABASE_PROVIDER;
    } else {
      process.env.SUPPORTFORGE_DATABASE_PROVIDER = previous;
    }
  }
}

test('live persistence defaults to Neon/PostgreSQL when provider is omitted', () => {
  withProvider(undefined, () => {
    assert.equal(getPersistenceProvider(), 'postgres');
  });
});

test('SQLite cannot silently become the live persistence provider', () => {
  withProvider('sqlite', () => {
    assert.throws(
      () => getPersistenceProvider(),
      /SQLite is disabled for live SupportForge persistence/,
    );
  });
});

test('PostgreSQL and Neon provider aliases select the durable live datastore', () => {
  for (const provider of ['postgres', 'postgresql', 'neon']) {
    withProvider(provider, () => {
      assert.equal(getPersistenceProvider(), 'postgres');
    });
  }
});
