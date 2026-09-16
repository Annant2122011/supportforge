import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { data } from './commands/supportforge';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing from .env`);
  return value;
}

const rest = new REST({ version: '10' }).setToken(required('DISCORD_TOKEN'));

async function deploy(): Promise<void> {
  const clientId = required('CLIENT_ID');
  const guildId = required('GUILD_ID');
  console.log('🔄 Deploying SupportForge commands...');
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: [data.toJSON()],
  });
  console.log('✅ SupportForge command deployed.');
}

deploy().catch((error) => {
  console.error('❌ Deployment failed:', error);
  process.exit(1);
});
