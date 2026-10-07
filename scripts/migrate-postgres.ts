import 'dotenv/config';

import { migrateAndVerifyPostgres } from '../src/core/persistence/migrationRunner';

migrateAndVerifyPostgres()
  .then((result) => {
    console.log(
      `✅ PostgreSQL migrations complete. Applied ${result.applied} migration(s).`,
    );
  })
  .catch((error) => {
    console.error('❌ PostgreSQL migration failed:', error);
    process.exitCode = 1;
  });
