import {
  ChannelType,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { getGuildConfig, resetConfigState } from './configService';
import { getAdvancedSettings, resetAdvancedSettingsState } from './advancedSettingsService';
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

const resettingGuilds = new Set<string>();

export function isFactoryResetInProgress(guildId: string): boolean {
  return resettingGuilds.has(guildId);
}

const TOPIC_PREFIXES = [
  'supportforge:ticket',
  'supportforge:panel',
  'supportforge:transcript',
  'supportforge:audit',
  'supportforge:settings',
];

function isSupportForgeChannel(channel: GuildBasedChannel, configuredIds: Set<string>, configuredCategoryIds: Set<string>): boolean {
  if (configuredIds.has(channel.id) || configuredCategoryIds.has(channel.id)) return true;

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
  resettingGuilds.add(guild.id);

  try {
    const config = await getGuildConfig(guild.id);
    const settings = await getAdvancedSettings(guild.id);

    const configuredCategoryIds = new Set(
      [
        config.supportCategoryId,
        config.openCategoryId,
        settings.closedCategoryId,
        settings.archiveCategoryId,
        settings.statusCategories.claimedCategoryId,
        settings.statusCategories.pendingCategoryId,
        ...Object.values(config.departments).map((department) => department.categoryId ?? null),
      ].filter((id): id is string => Boolean(id)),
    );

    const configuredIds = new Set(
      [
        ...configuredCategoryIds,
        config.panelChannelId,
        config.transcriptChannelId,
        config.auditChannelId,
        settings.settingsChannelId,
      ].filter((id): id is string => Boolean(id)),
    );

    /*
     * Snapshot the entire managed scope before deleting anything. This is
     * intentionally ID/config driven, so renaming a SupportForge category or
     * its Settings/Audit channel cannot make it escape the reset.
     */
    const targets = [...guild.channels.cache.values()].filter((channel) =>
      isSupportForgeChannel(channel, configuredIds, configuredCategoryIds),
    );

  // Delete child channels first, then the categories containing them.
  const childChannels = targets.filter(
    (channel) => channel.type !== ChannelType.GuildCategory,
  );

  const categories = targets.filter(
    (channel) => channel.type === ChannelType.GuildCategory,
  );

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
  /*
   * Keep the audit database intact. A factory reset removes the Discord
   * surface and configuration, but historical audit evidence is useful for
   * recovery and must survive so a later /supportforge setup can rebuild the
   * audit channel and its summaries.
   */
  /*
   * Audit history is deliberately NOT reset. The Discord audit channel is
   * deleted with the rest of SupportForge, but data/audit-log.json and its
   * backup remain intact for future restoration and historical review.
   */

  for (const filename of [
    'config.json',
    'advanced-settings.json',
    'tickets.json',
  ]) {
    await unlink(join(DATA_DIR, filename)).catch(() => undefined);
  }
  } finally {
    resettingGuilds.delete(guild.id);
  }
}
