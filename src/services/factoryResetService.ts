import {
  ChannelType,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { getGuildConfig, resetConfigState } from './configService';
import { prepareFactoryResetAuditRetention } from './auditLogService';
import { getAdvancedSettings, resetAdvancedSettingsState } from './advancedSettingsService';
import { resetTicketPersistenceState } from './ticketPersistenceService';
import { resetReportState } from './reportService';

const DATA_DIR = join(process.cwd(), 'data');

/*
 * Factory reset must only delete resources SupportForge can positively
 * identify through persisted IDs, managed topics, or managed-category ancestry.
 * Names alone are never ownership proof because Discord users can create
 * unrelated resources with identical names.
 */

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
  'supportforge:audit-dev',
  'supportforge:settings',
];

function isSupportForgeChannel(channel: GuildBasedChannel, configuredIds: Set<string>, configuredCategoryIds: Set<string>): boolean {
  if (configuredIds.has(channel.id) || configuredCategoryIds.has(channel.id)) return true;

  if (
    channel.type === ChannelType.GuildText &&
    TOPIC_PREFIXES.some((prefix) => channel.topic?.startsWith(prefix))
  ) {
    return true;
  }

  if (channel.parentId && configuredCategoryIds.has(channel.parentId)) return true;

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

export async function performFactoryReset(guild: Guild, accumulateAuditData = false): Promise<void> {
  resettingGuilds.add(guild.id);

  try {
    await prepareFactoryResetAuditRetention(guild, accumulateAuditData);

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
        config.auditDevChannelId,
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

    /*
     * Priority roles are SupportForge-managed infrastructure too. Remove them
     * before resetting advanced settings so a factory reset cannot leave
     * orphaned "SupportForge • ... Tickets" roles behind.
     */
    const configuredPriorityRoleIds = new Set(
      Object.values(settings.priorityRoles).filter(
        (id): id is string => Boolean(id),
      ),
    );

    const managedPriorityRoles = [
      ...guild.roles.cache.values(),
    ].filter(
      (role) =>
        !role.managed &&
        (
          configuredPriorityRoleIds.has(role.id) ||
          role.id === config.auditDeveloperRoleId
        ),
    );

    for (const role of managedPriorityRoles) {
      await role
        .delete('SupportForge factory reset: remove managed priority role')
        .catch((error) => {
          console.warn(
            `⚠️ Factory reset could not delete SupportForge role ${role.name} (${role.id}):`,
            error,
          );
        });
    }

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
    await resetReportState();
  /*
   * Audit history is deliberately NOT reset. The Discord audit channel is
   * deleted with the rest of SupportForge, but data/audit-log.json and its
   * backup remain intact for future restoration and historical review.
   */

    for (const filename of [
    'config.json',
    'advanced-settings.json',
    'tickets.json',
    'reports.json',
  ]) {
    await unlink(join(DATA_DIR, filename)).catch(() => undefined);
  }
  } finally {
    resettingGuilds.delete(guild.id);
  }
}
