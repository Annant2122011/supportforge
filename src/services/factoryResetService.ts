import {
  ChannelType,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { resetConfigState } from './configService';
import { resetAdvancedSettingsState } from './advancedSettingsService';
import { resetTicketPersistenceState } from './ticketPersistenceService';
import { resetAuditLogState } from './auditLogService';

const DATA_DIR = join(process.cwd(), 'data');

const KNOWN_NAMES = new Set([
  'Support Forge',
  'support-panel',
  '📄 support-transcripts',
  '📒 supportforge-audit-log',
  'supportforge-settings',
]);

const SUPPORTFORGE_CATEGORY_PREFIXES = [
  'SupportForge.',
  'SupportForge • Closed',
  'SupportForge • Archive',
];

const TOPIC_PREFIXES = [
  'supportforge:ticket',
  'supportforge:panel',
  'supportforge:transcript',
  'supportforge:audit',
  'supportforge:settings',
];

function isSupportForgeChannel(channel: GuildBasedChannel): boolean {
  if (KNOWN_NAMES.has(channel.name)) return true;

  if (
    channel.type === ChannelType.GuildText &&
    TOPIC_PREFIXES.some((prefix) => channel.topic?.startsWith(prefix))
  ) {
    return true;
  }

  if (
    channel.type === ChannelType.GuildCategory &&
    SUPPORTFORGE_CATEGORY_PREFIXES.some((prefix) =>
      channel.name.toLowerCase().startsWith(prefix.toLowerCase()),
    )
  ) {
    return true;
  }

  return false;
}

export async function performFactoryReset(guild: Guild): Promise<void> {
  const targets = [...guild.channels.cache.values()].filter(isSupportForgeChannel);

  // Delete child channels first, then the categories containing them.
  const childChannels = targets
    .filter((channel) => channel.type !== ChannelType.GuildCategory)
    .sort((a, b) => b.position - a.position);

  const categories = targets
    .filter((channel) => channel.type === ChannelType.GuildCategory)
    .sort((a, b) => b.position - a.position);

  for (const channel of [...childChannels, ...categories]) {
    await channel
      .delete('SupportForge factory reset: remove all SupportForge channels and messages')
      .catch((error) => {
        console.warn(`⚠️ Factory reset could not delete ${channel.name} (${channel.id}):`, error);
      });
  }

  await resetConfigState();
  await resetAdvancedSettingsState();
  await resetTicketPersistenceState();
  await resetAuditLogState();

  for (const filename of [
    'config.json',
    'advanced-settings.json',
    'tickets.json',
    'audit-log.json',
  ]) {
    await unlink(join(DATA_DIR, filename)).catch(() => undefined);
  }
}

