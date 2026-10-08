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

const resettingGuilds = new Set<string>();

export interface FactoryResetFailure {
  id: string;
  name: string;
  kind: 'channel' | 'role';
  error: string;
}

export interface FactoryResetResult {
  complete: boolean;
  deletedChannels: number;
  deletedRoles: number;
  failed: FactoryResetFailure[];
}

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

function hasPermission(
  overwrite: { allow: { has(permission: bigint): boolean }; deny: { has(permission: bigint): boolean } } | undefined,
  permission: bigint,
  mode: 'allow' | 'deny',
): boolean {
  return Boolean(overwrite?.[mode].has(permission));
}

function looksLikeManagedCategory(
  channel: GuildBasedChannel,
  guild: Guild,
): boolean {
  if (channel.type !== ChannelType.GuildCategory) return false;

  const botId = guild.members.me?.id;
  if (!botId) return false;

  const everyoneOverwrite = channel.permissionOverwrites.cache.get(
    guild.roles.everyone.id,
  );
  const botOverwrite = channel.permissionOverwrites.cache.get(botId);

  /*
   * Names alone are deliberately insufficient. The category must also carry
   * the permission fingerprint SupportForge gives its managed categories.
   */
  const hasBotControl =
    hasPermission(botOverwrite, PermissionFlagsBits.ViewChannel, 'allow') &&
    hasPermission(botOverwrite, PermissionFlagsBits.ManageChannels, 'allow') &&
    hasPermission(botOverwrite, PermissionFlagsBits.ManageMessages, 'allow');

  if (!hasBotControl) return false;

  const name = channel.name.trim().toLowerCase();

  if (name === 'support forge') {
    return (
      hasPermission(everyoneOverwrite, PermissionFlagsBits.ViewChannel, 'allow') &&
      hasPermission(everyoneOverwrite, PermissionFlagsBits.ReadMessageHistory, 'allow') &&
      hasPermission(everyoneOverwrite, PermissionFlagsBits.SendMessages, 'deny')
    );
  }

  /*
   * All other SupportForge categories are private containers. This covers:
   * Open, department categories, Closed, Archive, and optional status buckets.
   */
  const looksLikeSupportForgeName =
    name === 'open' ||
    name === 'supportforge • closed' ||
    name === 'supportforge • archive' ||
    name === 'supportforge.claimed tickets' ||
    name === 'supportforge.pending tickets' ||
    name.startsWith('supportforge.');

  return (
    looksLikeSupportForgeName &&
    hasPermission(
      everyoneOverwrite,
      PermissionFlagsBits.ViewChannel,
      'deny',
    )
  );
}

function isSupportForgeChannel(
  channel: GuildBasedChannel,
  configuredIds: Set<string>,
  configuredCategoryIds: Set<string>,
  guild: Guild,
): boolean {
  if (
    configuredIds.has(channel.id) ||
    configuredCategoryIds.has(channel.id)
  ) {
    return true;
  }

  if (
    channel.type === ChannelType.GuildText &&
    TOPIC_PREFIXES.some((prefix) => channel.topic?.startsWith(prefix))
  ) {
    return true;
  }

  return looksLikeManagedCategory(channel, guild);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getDiscordErrorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== 'object') return undefined;

  const candidate = error as {
    code?: number | string;
    status?: number;
  };

  return candidate.code ?? candidate.status;
}

function getRetryDelay(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;

  const candidate = error as {
    retryAfter?: number;
    data?: { retry_after?: number };
  };

  const retryAfter =
    candidate.retryAfter ??
    candidate.data?.retry_after;

  return typeof retryAfter === 'number' && retryAfter > 0
    ? Math.min(Math.ceil(retryAfter * 1000) + 250, 10_000)
    : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteChannelSafely(
  channel: GuildBasedChannel,
  reason: string,
): Promise<{ deleted: boolean; error?: unknown }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await channel.delete(reason);
      return { deleted: true };
    } catch (error) {
      /*
       * Discord returning Unknown Channel means the resource is already gone.
       * Treat that as successful cleanup, which makes retries idempotent.
       */
      const code = getDiscordErrorCode(error);
      if (code === 10003 || code === 10008) {
        return { deleted: true };
      }

      const retryDelay = getRetryDelay(error);
      if (retryDelay !== null && attempt < 2) {
        await delay(retryDelay);
        continue;
      }

      return { deleted: false, error };
    }
  }

  return { deleted: false, error: new Error('Channel deletion exhausted its retry attempts.') };
}

async function deleteRoleSafely(
  role: NonNullable<ReturnType<typeof guildRoleFromAny>>,
  reason: string,
): Promise<{ deleted: boolean; error?: unknown }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await role.delete(reason);
      return { deleted: true };
    } catch (error) {
      const code = getDiscordErrorCode(error);
      if (code === 10011 || code === 10008) {
        return { deleted: true };
      }

      const retryDelay = getRetryDelay(error);
      if (retryDelay !== null && attempt < 2) {
        await delay(retryDelay);
        continue;
      }

      return { deleted: false, error };
    }
  }

  return { deleted: false, error: new Error('Role deletion exhausted its retry attempts.') };
}

function guildRoleFromAny(
  role: {
    id: string;
    name: string;
    managed: boolean;
    delete: (reason?: string) => Promise<unknown>;
  },
): typeof role {
  return role;
}

export async function performFactoryReset(
  guild: Guild,
  accumulateAuditData = false,
): Promise<FactoryResetResult> {
  resettingGuilds.add(guild.id);

  try {
    await prepareFactoryResetAuditRetention(
      guild,
      accumulateAuditData,
    );

    /*
     * Always refresh the channel cache before computing the deletion scope.
     * Factory reset is destructive and stale cache state is unacceptable.
     */
    await guild.channels.fetch().catch((error) => {
      throw new Error(
        'SupportForge could not refresh the guild channel inventory before reset. No infrastructure was deleted.',
        { cause: error },
      );
    });

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
        ...Object.values(config.departments).map(
          (department) => department.categoryId ?? null,
        ),
        ...(config.retiredCategoryIds ?? []),
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
     * Ticket voice rooms are intentionally not stored in guild-level config.
     * Recover their IDs from ticket metadata before deleting the ticket
     * channels, otherwise an orphaned voice room would survive the reset.
     */
    for (const channel of guild.channels.cache.values()) {
      if (
        channel.type !== ChannelType.GuildText ||
        !channel.topic?.startsWith('supportforge:ticket')
      ) {
        continue;
      }

      const match = channel.topic.match(
        /(?:^|\\s)voice_channel_id=([^\\s]*)/,
      );
      const voiceChannelId = match?.[1];
      if (voiceChannelId) {
        configuredIds.add(voiceChannelId);
      }
    }

    /*
     * Identify all current resources before any deletion. That includes
     * configured IDs, managed topics, strict managed-category fingerprints,
     * and ticket voice channels referenced by ticket metadata.
     */
    const targets = [
      ...guild.channels.cache.values(),
    ].filter((channel) =>
      isSupportForgeChannel(
        channel,
        configuredIds,
        configuredCategoryIds,
        guild,
      ),
    );

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

    let deletedChannels = 0;
    let deletedRoles = 0;
    const failed: FactoryResetFailure[] = [];

    /*
     * Delete child channels first. This includes ticket voice rooms, which
     * are not categories but are nevertheless SupportForge-created resources.
     */
    const childChannels = targets
      .filter((channel) => channel.type !== ChannelType.GuildCategory)
      .sort((a, b) => {
        const aTicket =
          a.type === ChannelType.GuildText &&
          a.topic?.startsWith('supportforge:ticket')
            ? 0
            : 1;
        const bTicket =
          b.type === ChannelType.GuildText &&
          b.topic?.startsWith('supportforge:ticket')
            ? 0
            : 1;
        return aTicket - bTicket;
      });

    for (const channel of childChannels) {
      const result = await deleteChannelSafely(
        channel,
        'SupportForge factory reset: remove all SupportForge channels and messages',
      );

      if (result.deleted) {
        deletedChannels += 1;
      } else {
        failed.push({
          id: channel.id,
          name: channel.name,
          kind: 'channel',
          error: getErrorMessage(result.error),
        });
      }
    }

    const categories = targets.filter(
      (channel) => channel.type === ChannelType.GuildCategory,
    );

    for (const category of categories) {
      const result = await deleteChannelSafely(
        category,
        'SupportForge factory reset: remove all SupportForge channels and messages',
      );

      if (result.deleted) {
        deletedChannels += 1;
      } else {
        failed.push({
          id: category.id,
          name: category.name,
          kind: 'channel',
          error: getErrorMessage(result.error),
        });
      }
    }

    /*
     * Priority/developer roles are also part of SupportForge infrastructure.
     * Keep the state files intact when even one managed resource cannot be
     * deleted, so a second reset attempt still has the IDs required to retry.
     */
    for (const role of managedPriorityRoles) {
      const result = await deleteRoleSafely(
        guildRoleFromAny(role),
        'SupportForge factory reset: remove managed role',
      );

      if (result.deleted) {
        deletedRoles += 1;
      } else {
        failed.push({
          id: role.id,
          name: role.name,
          kind: 'role',
          error: getErrorMessage(result.error),
        });
      }
    }

    if (failed.length > 0) {
      return {
        complete: false,
        deletedChannels,
        deletedRoles,
        failed,
      };
    }

    /*
     * Only after the entire Discord-side deletion has succeeded do we erase
     * SupportForge's normal configuration, reports, and ticket persistence.
     * This prevents a partial reset from losing the IDs needed for recovery.
     */
    await resetConfigState();
    await resetAdvancedSettingsState();
    await resetTicketPersistenceState();
    await resetReportState();

    for (const filename of [
      'config.json',
      'advanced-settings.json',
      'tickets.json',
      'reports.json',
    ]) {
      await unlink(join(DATA_DIR, filename)).catch(() => undefined);
    }

    return {
      complete: true,
      deletedChannels,
      deletedRoles,
      failed: [],
    };
  } finally {
    resettingGuilds.delete(guild.id);
  }
}
