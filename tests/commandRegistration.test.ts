import assert from 'node:assert/strict';
import test from 'node:test';

// The command declaration is built at module load. A placeholder token lets
// this check validate the builder without authenticating or calling Discord.
process.env.DISCORD_TOKEN ??= 'test-only-command-registration-token';

test('slash command declarations initialize within Discord option limits', async () => {
  const commandModule = await import('../src/commands/supportforge');
  assert.equal(typeof commandModule.execute, 'function');
});
