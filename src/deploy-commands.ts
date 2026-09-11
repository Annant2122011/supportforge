import 'dotenv/config';

import {
  REST,
  Routes,
} from 'discord.js';

import { setupCommand } from './commands/setup';
import { data as supportForgeCommand } from './commands/supportforge';

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `${name} is missing from environment variables.`,
    );
  }

  return value;
}

const token =
  requireEnv('DISCORD_TOKEN');

const clientId =
  requireEnv('CLIENT_ID');

const guildId =
  requireEnv('GUILD_ID');

const rest =
  new REST({
    version: '10',
  }).setToken(token);

async function deployCommands() {
  console.log(
    '🔄 Deploying SupportForge commands...',
  );

  await rest.put(
    Routes.applicationGuildCommands(
      clientId,
      guildId,
    ),
    {
      body: [
        setupCommand.data.toJSON(),
        supportForgeCommand.toJSON(),
      ],
    },
  );

  console.log(
    '✅ Commands deployed successfully.',
  );

  console.log(
    '   • /setup',
  );

  console.log(
    '   • /supportforge setup',
  );

  console.log(
    '   • /supportforge category add',
  );
}

deployCommands().catch((error) => {
  console.error(
    '❌ Command deployment failed:',
    error,
  );

  process.exit(1);
});