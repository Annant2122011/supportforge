import {
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
} from 'discord.js';

import {
  getGuildConfig,
  updateGuildConfig,
  type DepartmentConfig,
} from './configService';
import { logSystemEvent } from './auditLogService';
import { getPersistedTicketRecords, getPersistedTicketStatus } from './ticketPersistenceService';
import { getField, isTicketTopic } from './ticketStateService';
import { setChannelParent } from './discordChannelService';

const MAX_CHANNELS_PER_CATEGORY = 50;
const PREFIX = 'QueryFixr.';

function categoryName(departmentName: string, suffix = 1): string {
  const clean = departmentName.replace(/\s+/g, ' ').trim();
  const base = (PREFIX + clean).slice(0, 100);

  if (suffix === 1) return base;

  const suffixText = ' ' + suffix;
  return base.slice(0, 100 - suffixText.length) + suffixText;
}

function isMatchingCategory(
  channel: unknown,
  baseName: string,
): channel is CategoryChannel {
  if (!channel || typeof channel !== 'object') return false;

  const candidate = channel as CategoryChannel;
  return (
    candidate.type === ChannelType.GuildCategory &&
    (candidate.name.toLowerCase() === baseName.toLowerCase() ||
      candidate.name.toLowerCase().startsWith(baseName.toLowerCase() + ' '))
  );
}

async function reconcileDepartmentTickets(
  guild: Guild,
  departmentId: string,
  category: CategoryChannel,
): Promise<void> {
  const capacity = MAX_CHANNELS_PER_CATEGORY - category.children.cache.size;
  if (capacity <= 0) return;

  let moved = 0;
  for (const channel of guild.channels.cache.values()) {
    if (moved >= capacity) break;
    if (channel.type !== ChannelType.GuildText) continue;

    const topic = channel.topic ?? '';
    if (!isTicketTopic(topic) || getField(topic, 'department') !== departmentId) {
      continue;
    }

    const status =
      (await getPersistedTicketStatus(channel.id)) ??
      getField(topic, 'status') ??
      'open';

    /*
     * Closed and archived tickets belong to historical storage, not the live
     * department category. Only active lifecycle states are reconciled here.
     */
    if (
      !['open', 'claimed', 'pending', 'reopened'].includes(status) ||
      channel.parentId === category.id
    ) {
      continue;
    }

    await setChannelParent(
      channel.id,
      category.id,
      'QueryFixr: reconcile ticket with department category',
    ).then(() => {
      moved += 1;
    }).catch((error) => {
      console.warn(
        '⚠️ Could not move ticket #' +
          (getField(topic, 'number') ?? 'unknown') +
          ' into ' +
          category.name +
          ':',
        error,
      );
    });
  }
}

async function removeEmptyOrphanDepartmentCategories(guild: Guild): Promise<void> {
  /*
   * An empty category has no ticket topic that can prove ownership. Names are
   * not sufficient either because administrators can legitimately create
   * categories with the same display name. Leave unreferenced categories alone
   * rather than risking deletion of unrelated server infrastructure.
   */
  return;
}

export async function ensureDepartmentCategory(
  guild: Guild,
  department: Pick<DepartmentConfig, 'id' | 'name' | 'staffRoleId' | 'categoryId'>,
): Promise<CategoryChannel> {
  const bot = guild.members.me;
  if (!bot) {
    throw new Error('QueryFixr bot member could not be resolved.');
  }

  const baseName = categoryName(department.name);

  const saved = department.categoryId
    ? guild.channels.cache.get(department.categoryId)
    : undefined;

  if (
    saved?.type === ChannelType.GuildCategory &&
    saved.children.cache.size < MAX_CHANNELS_PER_CATEGORY
  ) {
    await saved.permissionOverwrites.edit(guild.roles.everyone.id, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false,
    });

    await saved.permissionOverwrites.edit(bot.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: true,
      ManageMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
    });

    if (department.staffRoleId) {
      await saved.permissionOverwrites.edit(department.staffRoleId, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: false,
      });
    }

    await reconcileDepartmentTickets(guild, department.id, saved);
    return saved;
  }

  /*
   * A matching name is not ownership proof. An administrator may have created
   * an unrelated category with the same department name. Only the persisted
   * categoryId identifies an existing QueryFixr department category.
   */
  const candidates: CategoryChannel[] = [];

  const suffix = candidates.length + 1;

  const category = await guild.channels.create({
    name: categoryName(department.name, suffix),
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      {
        id: bot.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      ...(department.staffRoleId
        ? [
            {
              id: department.staffRoleId,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
          ]
        : []),
    ],
    reason: 'QueryFixr department category provisioning',
  });

  await updateGuildConfig(guild.id, (current) => {
    const configuredDepartment = current.departments[department.id];
    if (configuredDepartment) {
      configuredDepartment.categoryId = category.id;
    }
    current.managedCategoryIds = Array.from(
      new Set([...(current.managedCategoryIds ?? []), category.id]),
    );
  });

  const config = await getGuildConfig(guild.id);
  await reconcileDepartmentTickets(guild, department.id, category);
  if (config.supportCategoryId) {
    void logSystemEvent(
      guild,
      config.supportCategoryId,
      'CATEGORY_CREATED',
      `Created QueryFixr department category ${category.name} (${category.id}).`,
    ).catch(() => undefined);
  }

  return category;
}

export async function syncDepartmentCategoryId(
  guildId: string,
  departmentId: string,
  categoryId: string,
): Promise<void> {
  await updateGuildConfig(guildId, (config) => {
    const department = config.departments[departmentId];
    if (department) {
      department.categoryId = categoryId;
    }
  });
}

export async function ensureAllDepartmentCategories(
  guild: Guild,
): Promise<void> {
  const config = await getGuildConfig(guild.id);

  // Fetch a complete channel snapshot before deciding whether a previously
  // provisioned department category is still justified by an existing ticket.
  // If Discord is unavailable, fail closed: do not create or delete categories.
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) {
    console.warn(
      '⚠️ Department category repair skipped for guild ' + guild.id +
        ' because Discord channels could not be fetched safely.',
    );
    return;
  }

  const ticketDepartments = new Set<string>();
  // Discord channels can be deleted while their durable ticket records remain.
  // Those records still prove that the department category is needed.
  const durableTickets = await getPersistedTicketRecords(guild.id);
  for (const ticket of durableTickets) {
    if (!ticket.deletedAt && ticket.departmentId) ticketDepartments.add(ticket.departmentId);
  }

  for (const channel of channels.values()) {
    if (!channel || channel.type !== ChannelType.GuildText) continue;
    const topic = channel.topic ?? '';
    if (isTicketTopic(topic)) {
      const departmentId = getField(topic, 'department');
      if (departmentId) ticketDepartments.add(departmentId);
    }
  }

  for (const department of Object.values(config.departments)) {
    // Departments with no ticket must not cause a category to be created or
    // repaired merely because a stale categoryId remains in configuration.
    if (!ticketDepartments.has(department.id)) {
      if (department.categoryId) {
        const saved = channels.get(department.categoryId);
        const isKnownManagedCategory =
          (config.managedCategoryIds ?? []).includes(department.categoryId);

        // Remove only a provably QueryFixr-managed, empty category. Never
        // delete a non-empty category or one whose ownership is uncertain.
        if (
          saved?.type === ChannelType.GuildCategory &&
          saved.children.cache.size === 0 &&
          isKnownManagedCategory
        ) {
          const removed = await saved.delete(
            'QueryFixr cleanup: no tickets exist for this department',
          ).then(() => true).catch((error) => {
            console.warn(
              '⚠️ Could not remove unused empty department category ' +
                saved.name + ' (' + saved.id + '):',
              error,
            );
            return false;
          });

          if (removed) {
            await updateGuildConfig(guild.id, (current) => {
              const currentDepartment = current.departments[department.id];
              if (currentDepartment?.categoryId === saved.id) {
                currentDepartment.categoryId = null;
              }
              current.managedCategoryIds = (current.managedCategoryIds ?? [])
                .filter((id) => id !== saved.id);
            });
          }
        }
      }
      continue;
    }

    // A ticket may have been preserved in the main QueryFixr category
    // after an earlier category-provisioning failure. Setup should repair it
    // even when no department category ID was saved.
    const category = await ensureDepartmentCategory(guild, department);

    if (department.categoryId !== category.id) {
      await syncDepartmentCategoryId(guild.id, department.id, category.id);
    }
  }

  await removeEmptyOrphanDepartmentCategories(guild);
}
