import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { data } from './commands/supportforge';
import { normalizeRequiredOptionOrder, type CommandOptionPayload } from './commands/optionOrdering';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing from .env`);
  return value;
}

const rest = new REST({ version: '10' }).setToken(required('DISCORD_TOKEN'));

async function deploy(): Promise<void> {
  const clientId = required('CLIENT_ID');
  const guildId = required('GUILD_ID');
  console.log('🔄 Deploying QueryFixr commands...');
  const command = normalizeRequiredOptionOrder(
    data.toJSON() as unknown as CommandOptionPayload,
  );
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: [command as unknown as ReturnType<typeof data.toJSON>],
  });
  console.log('✅ QueryFixr command deployed.');
}

deploy().catch((error) => {
  console.error('❌ Deployment failed:', error);
  process.exit(1);
});
