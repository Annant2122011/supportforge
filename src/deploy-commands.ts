import 'dotenv/config';

import {
  REST,
  Routes,
} from 'discord.js';

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

const token = requireEnv('DISCORD_TOKEN');
const clientId = requireEnv('CLIENT_ID');
const guildId = requireEnv('GUILD_ID');

const rest = new REST({
  version: '10',
}).setToken(token);

async function deployCommands() {
  try {
    console.log('🔄 Deploying SupportForge commands...');

    await rest.put(
      Routes.applicationGuildCommands(
        clientId,
        guildId,
      ),
      {
        body: [
          supportForgeCommand.toJSON(),
        ],
      },
    );

    console.log('✅ Commands deployed successfully.');
    console.log('   • /supportforge setup');
    console.log('   • /supportforge category add');
    console.log('   • /supportforge premium status');
    console.log('   • /supportforge premium toggle-demo');
    console.log('   • /supportforge ticket priority | tag | note | add-user | remove-user');
  } catch (error) {
    console.error(
      '❌ Command deployment failed:',
      error,
    );

    process.exit(1);
  }
}

deployCommands();
