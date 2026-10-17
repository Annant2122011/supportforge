import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';

import { getGuildConfig, newTagId, updateGuildConfig } from '../services/configService';
import { getAdvancedSettings, updateAdvancedSettings, type TicketPriority } from '../services/advancedSettingsService';
import { ensureArchiveCategory, ensureClosedCategory, ensureOptionalStatusCategory } from '../services/ticketStorageService';
import { refreshSettingsChannel } from '../services/settingsChannelService';
import { addUseCasePreset } from '../services/useCasePresetService';
import { performFactoryReset } from '../services/factoryResetService';
import { logSettingsEvent } from '../services/auditLogService';
import { approveRetentionDeletion, declineRetentionDeletion, getEligibleRetentionTickets } from '../services/ticketRetentionService';
import { migrateDepartmentStaffRole } from '../services/departmentStaffRoleService';
import { enforcePriorityRoleHierarchy } from '../services/priorityRoleService';

export interface SettingsSlashHooks {
  syncPanel(guild: Guild): Promise<void>;
  repair(guild: Guild, mode: 'normal' | 'storage'): Promise<string>;
  refresh(guild: Guild): Promise<void>;
}

const PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent', 'critical'];

export async function handleSettingsSlashCommand(
  interaction: ChatInputCommandInteraction,
  hooks: SettingsSlashHooks,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const action = interaction.options.getSubcommand();
  const config = await getGuildConfig(guild.id);
  const audit = (event: string, detail: string): void => {
    if (!config.supportCategoryId) return;
    void logSettingsEvent(guild, config.supportCategoryId, {
      action: event,
      actorId: interaction.user.id,
      actorName: interaction.user.tag,
      detail,
    }).catch((error) => console.warn('Settings slash-command audit failed:', error));
  };

  try {
    if (action === 'overview') {
      const settings = await getAdvancedSettings(guild.id);
      const departments = Object.values(config.departments);
      const tagCount = departments.reduce((sum, department) => sum + Object.keys(department.tags ?? {}).length, 0);
      await interaction.editReply(
        '**SupportForge Settings Overview**\n\n' +
        'Departments: **' + departments.length + '** · Tags: **' + tagCount + '**\n' +
        'Default priority: **' + settings.ticketDefaults.priority + '**\n' +
        'Simultaneous moderators: **' + settings.ticketDefaults.maxClaimedModerators + '**\n' +
        'Automatic panel movement: **' + (settings.panelActivity.enabled ? 'Enabled' : 'Disabled') + '**\n' +
        'Reports: **' + (settings.reports.enabled ? 'Enabled' : 'Disabled') + '**\n' +
        'Closed retention: **' + settings.retention.closedDays + ' days** · Archive retention: **' + settings.retention.archiveDays + ' days**\n\n' +
        'Button controls remain in the Settings channel. These commands operate on the same settings data.'
      );
      return;
    }

    if (action === 'panel') {
      const mode = interaction.options.getString('action', true);
      const visual = interaction.options.getInteger('visual-lines');
      const cap = interaction.options.getInteger('message-cap');
      const minimum = interaction.options.getInteger('minimum-messages');
      if (mode !== 'show' || visual !== null || cap !== null || minimum !== null) {
        await updateAdvancedSettings(guild.id, (settings) => {
          if (mode === 'toggle') settings.panelActivity.enabled = !settings.panelActivity.enabled;
          if (mode === 'enable') settings.panelActivity.enabled = true;
          if (mode === 'disable') settings.panelActivity.enabled = false;
          if (visual !== null) settings.panelActivity.visualLineBudget = visual;
          if (cap !== null) settings.panelActivity.messageBudget = cap;
          if (minimum !== null) settings.panelActivity.minimumMessagesBeforeMove = minimum;
        });
        await hooks.syncPanel(guild);
        await refreshSettingsChannel(guild);
        audit('PANEL_SETTINGS_CHANGED', 'Updated ticket panel automation through slash command.');
      }
      const settings = await getAdvancedSettings(guild.id);
      await interaction.editReply(
        '**Panel Settings**\nAutomatic movement: **' + (settings.panelActivity.enabled ? 'Enabled' : 'Disabled') + '**\n' +
        'Visual line budget: **' + settings.panelActivity.visualLineBudget + '**\n' +
        'Message safety cap: **' + settings.panelActivity.messageBudget + '**\n' +
        'Minimum messages before moving: **' + settings.panelActivity.minimumMessagesBeforeMove + '**'
      );
      return;
    }

    if (action === 'defaults') {
      const priority = interaction.options.getString('priority') as TicketPriority | null;
      if (priority && !PRIORITIES.includes(priority)) throw new Error('Invalid priority.');
      if (priority) {
        await updateAdvancedSettings(guild.id, (settings) => { settings.ticketDefaults.priority = priority; });
        await refreshSettingsChannel(guild);
        audit('TICKET_DEFAULTS_CHANGED', 'Default ticket priority changed to ' + priority + '.');
      }
      const settings = await getAdvancedSettings(guild.id);
      await interaction.editReply('Default ticket priority: **' + settings.ticketDefaults.priority + '**.');
      return;
    }

    if (action === 'team') {
      const maximum = interaction.options.getInteger('max-moderators');
      if (maximum !== null) {
        await updateAdvancedSettings(guild.id, (settings) => { settings.ticketDefaults.maxClaimedModerators = maximum; });
        await refreshSettingsChannel(guild);
        audit('TEAM_LIMIT_CHANGED', 'Maximum simultaneous ticket moderators changed to ' + maximum + '.');
      }
      const settings = await getAdvancedSettings(guild.id);
      await interaction.editReply('Maximum simultaneous moderators: **' + settings.ticketDefaults.maxClaimedModerators + '**. Private voice capacity: **' + (settings.ticketDefaults.maxClaimedModerators + 1) + '** people.');
      return;
    }

    if (action === 'retention') {
      const closed = interaction.options.getInteger('closed-days');
      const archive = interaction.options.getInteger('archive-days');
      if (closed !== null || archive !== null) {
        await updateAdvancedSettings(guild.id, (settings) => {
          if (closed !== null) {
            settings.retention.closedDays = closed;
            settings.retention.closedEffectiveFrom = null;
            settings.retention.pendingApprovals.closed = null;
          }
          if (archive !== null) {
            settings.retention.archiveDays = archive;
            settings.retention.archiveEffectiveFrom = null;
            settings.retention.pendingApprovals.archive = null;
          }
        });
        await refreshSettingsChannel(guild);
        audit('RETENTION_CHANGED', 'Updated ticket retention through slash command.');
      }
      const settings = await getAdvancedSettings(guild.id);
      await interaction.editReply(
        'Closed tickets: **' + (settings.retention.closedDays === 0 ? 'No timer (365-day maximum)' : settings.retention.closedDays + ' days') +
        '**\nArchived tickets: **' + (settings.retention.archiveDays === 0 ? 'No timer (365-day maximum)' : settings.retention.archiveDays + ' days') + '**.'
      );
      return;
    }

    if (action === 'retention-action') {
      const mode = interaction.options.getString('action', true);
      const scope = interaction.options.getString('scope', true) as 'closed' | 'archive';
      const settings = await getAdvancedSettings(guild.id);
      const pending = settings.retention.pendingApprovals[scope];

      if (mode === 'review') {
        const eligible = await getEligibleRetentionTickets(guild, scope);
        const preview = eligible.slice(0, 12).map((channel) => '• ' + channel.name + ' (' + channel.id + ')').join('\n');
        const requestText = pending
          ? '\nPending approval requested by <@' + pending.requestedById + '> on ' + pending.requestedAt + '.'
          : '\nThere is no pending deletion approval for this scope.';
        await interaction.editReply(
          '**Retention Review: ' + (scope === 'closed' ? 'Closed Tickets' : 'Archived Tickets') + '**\n' +
          'Eligible tickets: **' + eligible.length + '**.' + requestText + '\n\n' +
          (preview || 'No eligible tickets were found.') +
          (eligible.length > 12 ? '\n…and ' + (eligible.length - 12) + ' more.' : '') +
          '\n\nReview does not delete anything.'
        );
        return;
      }

      if (!pending) throw new Error('There is no pending retention approval for that scope.');
      if (pending.requestedById !== interaction.user.id && guild.ownerId !== interaction.user.id) {
        throw new Error('Only the administrator who was asked, or the server owner, can approve or decline this deletion.');
      }

      if (mode === 'decline') {
        await declineRetentionDeletion(guild, scope, interaction.user.id);
        await refreshSettingsChannel(guild);
        audit('RETENTION_DECLINED', 'Declined pending ' + scope + ' retention deletion through slash command.');
        await interaction.editReply('✅ Declined the pending ' + scope + ' retention deletion. No tickets were deleted.');
        return;
      }

      const confirmDelete = interaction.options.getBoolean('confirm-delete') ?? false;
      const eligible = await getEligibleRetentionTickets(guild, scope);
      const preview = eligible.slice(0, 12).map((channel) => '• ' + channel.name + ' (' + channel.id + ')').join('\n');
      if (!confirmDelete) {
        await interaction.editReply(
          '**Retention Deletion Confirmation Required**\n\n' +
          'Scope: **' + scope + '** · Eligible tickets: **' + eligible.length + '**.\n' +
          (preview || 'No eligible tickets were found.') +
          (eligible.length > 12 ? '\n…and ' + (eligible.length - 12) + ' more.' : '') +
          '\n\nNo tickets were deleted. Repeat this command with **confirm-delete: True** to approve the deletion.'
        );
        return;
      }

      const deleted = await approveRetentionDeletion(guild, scope, interaction.user.id);
      await refreshSettingsChannel(guild);
      audit('RETENTION_APPROVED', 'Approved deletion of ' + deleted + ' eligible ' + scope + ' ticket(s) through slash command.');
      await interaction.editReply('✅ Approved retention cleanup. Deleted **' + deleted + '** eligible ' + scope + ' ticket(s).');
      return;
    }

    if (action === 'appearance') {
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const footer = interaction.options.getString('footer');
      if (title !== null || description !== null || footer !== null) {
        await updateAdvancedSettings(guild.id, (settings) => {
          if (title !== null) settings.appearance.panelTitle = title;
          if (description !== null) settings.appearance.panelDescription = description;
          if (footer !== null) settings.appearance.panelFooter = footer;
        });
        await hooks.syncPanel(guild);
        await refreshSettingsChannel(guild);
        audit('PANEL_APPEARANCE_CHANGED', 'Updated public panel appearance through slash command.');
      }
      const settings = await getAdvancedSettings(guild.id);
      await interaction.editReply(
        '**Panel Appearance**\nTitle: ' + settings.appearance.panelTitle +
        '\nDescription: ' + settings.appearance.panelDescription +
        '\nFooter: ' + settings.appearance.panelFooter
      );
      return;
    }

    if (action === 'reports') {
      const mode = interaction.options.getString('action', true);
      const current = await getAdvancedSettings(guild.id);
      let enabled = current.reports.enabled;
      if (mode === 'toggle') enabled = !enabled;
      if (mode === 'enable') enabled = true;
      if (mode === 'disable') enabled = false;
      if (enabled !== current.reports.enabled) {
        await updateAdvancedSettings(guild.id, (settings) => { settings.reports.enabled = enabled; });
        await refreshSettingsChannel(guild);
        audit('REPORT_INTAKE_CHANGED', 'Report intake ' + (enabled ? 'enabled' : 'disabled') + '.');
      }
      await interaction.editReply('Safety reports are **' + (enabled ? 'Enabled' : 'Disabled') + '**.');
      return;
    }

    if (action === 'report-categories') {
      const settings = await getAdvancedSettings(guild.id);
      const requestedCategoryId = interaction.options.getString('category-id')?.trim();
      const categories = Object.values(settings.reports.categories);
      const selected = requestedCategoryId
        ? settings.reports.categories[requestedCategoryId]
        : undefined;
      if (requestedCategoryId && !selected) {
        throw new Error('Report category not found. Run /supportforge settings report-categories without a category ID to list valid IDs.');
      }
      const lines = (selected ? [selected] : categories).map((category) => {
        const subs = Object.values(category.subcategories);
        return category.emoji + ' **' + category.name + '** · ID: ' + category.id + '\n' +
          (subs.length ? subs.map((sub) => '  • ' + sub.name + ' · ID: ' + sub.id).join('\n') : '  No subcategories configured.');
      });
      const content = lines.join('\n\n') || 'No report categories are configured.';
      const chunks: string[] = [];
      for (const line of content.split('\n')) {
        const current = chunks[chunks.length - 1];
        if (current && (current.length + line.length + 1) > 1700) chunks.push(line);
        else if (current) chunks[chunks.length - 1] = current + '\n' + line;
        else chunks.push(line);
      }
      const requestedPage = interaction.options.getInteger('page') ?? 1;
      if (requestedPage > chunks.length) throw new Error('Page ' + requestedPage + ' does not exist. This result has ' + chunks.length + ' page(s).');
      await interaction.editReply('**Report Categories' + (selected ? ' · ' + selected.name : '') + ' · Page ' + requestedPage + ' / ' + chunks.length + '**\n\n' + chunks[requestedPage - 1]);
      return;
    }

    if (action === 'report-rules') {
      const settings = await getAdvancedSettings(guild.id);
      const ticketRule = Object.values(settings.reports.flagRules).find((rule) => rule.action === 'tickets');
      const serverRule = Object.values(settings.reports.flagRules).find((rule) => rule.action === 'server');
      const channelRule = Object.values(settings.reports.flagRules).find((rule) => rule.action === 'channel');
      const ticketInput = interaction.options.getInteger('ticket-threshold');
      const serverInput = interaction.options.getInteger('server-threshold');
      const channelInput = interaction.options.getInteger('channel-threshold');
      const selectedChannel = interaction.options.getChannel('channel');
      const ticketThreshold = ticketInput ?? ticketRule?.threshold ?? 5;
      const serverThreshold = serverInput ?? serverRule?.threshold ?? 10;
      const channelThreshold = channelInput ?? channelRule?.threshold ?? 0;
      const channelId = selectedChannel?.id ?? channelRule?.channelId ?? null;
      if (channelThreshold > 0 && !channelId) throw new Error('Choose a text channel when the channel-rule threshold is above zero.');
      if (ticketInput !== null || serverInput !== null || channelInput !== null || selectedChannel !== null) {
        const now = new Date().toISOString();
        await updateAdvancedSettings(guild.id, (current) => {
          for (const rule of Object.values(current.reports.flagRules)) rule.enabled = false;
          const ensureRule = (id: string, ruleAction: 'tickets' | 'server' | 'channel', threshold: number, target: string | null) => {
            if (threshold <= 0) return;
            const existing = current.reports.flagRules[id];
            current.reports.flagRules[id] = existing ?? { id, threshold, action: ruleAction, channelId: target, enabled: true, createdAt: now, updatedAt: now };
            current.reports.flagRules[id].threshold = threshold;
            current.reports.flagRules[id].action = ruleAction;
            current.reports.flagRules[id].channelId = target;
            current.reports.flagRules[id].enabled = true;
            current.reports.flagRules[id].updatedAt = now;
          };
          ensureRule('tickets-default', 'tickets', ticketThreshold, null);
          ensureRule('server-default', 'server', serverThreshold, null);
          ensureRule('channel-default', 'channel', channelThreshold, channelId);
        });
        await refreshSettingsChannel(guild);
        audit('REPORT_RULES_CHANGED', 'Updated automatic report flag thresholds through slash command.');
      }
      await interaction.editReply(
        '**Report Flag Rules**\nTicket restriction: **' + ticketThreshold +
        '** flags\nServer action: **' + serverThreshold +
        '** flags\nChannel action: **' + channelThreshold + '** flags' +
        (channelId ? ' in <#' + channelId + '>' : '') + '\nSet a threshold to 0 to disable that action.'
      );
      return;
    }

    if (action === 'department-edit') {
      const currentName = interaction.options.getString('department-name', true).trim().toLowerCase();
      const newName = interaction.options.getString('new-name', true).trim().replace(/\s+/g, ' ');
      const role = interaction.options.getRole('staff-role');
      const clearRole = interaction.options.getBoolean('clear-staff-role') ?? false;
      const department = Object.values(config.departments).find((item) => item.name.toLowerCase() === currentName);
      if (!department) throw new Error('Department not found.');
      if (!newName) throw new Error('Department name cannot be empty.');
      if (clearRole && role) throw new Error('Choose a new staff role or clear the existing role, not both.');
      if (Object.values(config.departments).some((item) => item.id !== department.id && item.name.toLowerCase() === newName.toLowerCase())) throw new Error('Another department already uses that name.');
      if (role && (role.managed || role.id === guild.roles.everyone.id)) throw new Error('Choose a normal server role, not @everyone or a managed integration role.');
      const staffRoleId = clearRole ? null : role?.id ?? department.staffRoleId;
      const category = department.categoryId ? guild.channels.cache.get(department.categoryId) : null;
      if (category?.type === ChannelType.GuildCategory) await category.edit({ name: ('SupportForge.' + newName).slice(0, 100), reason: 'SupportForge department update from slash command' });
      await updateGuildConfig(guild.id, (current) => {
        const item = current.departments[department.id];
        if (item) { item.name = newName; item.staffRoleId = staffRoleId; }
      });
      await migrateDepartmentStaffRole(guild, department.id, department.staffRoleId, staffRoleId);
      await hooks.syncPanel(guild);
      await refreshSettingsChannel(guild);
      audit('DEPARTMENT_CHANGED', 'Renamed department ' + department.name + ' to ' + newName + '.');
      await interaction.editReply('Updated department **' + department.name + '** to **' + newName + '**. Staff role: ' + (staffRoleId ? '<@&' + staffRoleId + '>' : 'Administrators only') + '.');
      return;
    }

    if (action === 'tag-add' || action === 'tag-rename' || action === 'tag-remove') {
      const departmentName = interaction.options.getString('department-name', true).trim().toLowerCase();
      const department = Object.values(config.departments).find((item) => item.name.toLowerCase() === departmentName);
      if (!department) throw new Error('Department not found.');
      if (action === 'tag-add') {
        const name = interaction.options.getString('name', true).trim().replace(/\s+/g, ' ');
        if (!name) throw new Error('Tag name cannot be empty.');
        if (Object.values(department.tags).some((tag) => tag.name.toLowerCase() === name.toLowerCase())) throw new Error('This department already has a tag with that name.');
        const tagId = newTagId();
        const now = new Date().toISOString();
        await updateGuildConfig(guild.id, (current) => {
          const item = current.departments[department.id];
          if (item) item.tags[tagId] = { id: tagId, name, createdAt: now };
        });
        audit('TAG_ADDED', 'Added tag ' + name + ' to department ' + department.name + '.');
        await interaction.editReply('Added tag **' + name + '** to **' + department.name + '**.');
      } else {
        const oldName = (action === 'tag-rename'
          ? interaction.options.getString('current-name', true)
          : interaction.options.getString('tag-name', true)).trim().toLowerCase();
        const tag = Object.values(department.tags).find((item) => item.name.toLowerCase() === oldName);
        if (!tag) throw new Error('Tag not found in that department.');
        if (action === 'tag-rename') {
          const newName = interaction.options.getString('new-name', true).trim().replace(/\s+/g, ' ');
          if (!newName) throw new Error('Tag name cannot be empty.');
          if (Object.values(department.tags).some((item) => item.id !== tag.id && item.name.toLowerCase() === newName.toLowerCase())) throw new Error('This department already has a tag with that name.');
          await updateGuildConfig(guild.id, (current) => {
            const item = current.departments[department.id]?.tags[tag.id];
            if (item) item.name = newName;
          });
          audit('TAG_RENAMED', 'Renamed tag ' + tag.name + ' to ' + newName + ' in ' + department.name + '.');
          await interaction.editReply('Renamed tag **' + tag.name + '** to **' + newName + '**.');
        } else {
          if (Object.keys(department.tags).length <= 1) throw new Error('Each department must keep at least one tag.');
          await updateGuildConfig(guild.id, (current) => { const item = current.departments[department.id]; if (item) delete item.tags[tag.id]; });
          audit('TAG_REMOVED', 'Removed tag ' + tag.name + ' from department ' + department.name + '.');
          await interaction.editReply('Removed tag **' + tag.name + '** from **' + department.name + '**. Existing tickets keep their historical routing metadata.');
        }
      }
      await hooks.syncPanel(guild);
      await refreshSettingsChannel(guild);
      return;
    }

    if (action === 'usecase-add') {
      const preset = interaction.options.getString('preset', true);
      const added = await addUseCasePreset(guild.id, preset);
      await hooks.syncPanel(guild);
      await refreshSettingsChannel(guild);
      audit('USE_CASE_ADDED', 'Added use case department ' + added.name + ' with ' + added.tagNames.length + ' starter tags.');
      await interaction.editReply('Added **' + added.name + '** with ' + added.tagNames.length + ' starter tags: ' + added.tagNames.join(', ') + '.');
      return;
    }

    if (action === 'storage') {
      const mode = interaction.options.getString('action', true);
      if (mode === 'claimed' || mode === 'pending') {
        const category = await ensureOptionalStatusCategory(guild, mode);
        await refreshSettingsChannel(guild);
        audit('STATUS_CATEGORY_ADDED', 'Added ' + mode + ' status category ' + category.name + '.');
        await interaction.editReply('Added **' + mode + '** ticket category: ' + category.toString() + '.');
      } else {
        await ensureClosedCategory(guild);
        await ensureArchiveCategory(guild);
        await refreshSettingsChannel(guild);
        audit('STORAGE_REPAIR', 'Closed and Archive storage repair completed through slash command.');
        await interaction.editReply('Closed and Archive storage categories have been checked and repaired.');
      }
      return;
    }

    if (action === 'priority-role') {
      const mode = interaction.options.getString('action', true);
      if (mode !== 'status' && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        throw new Error('Creating or deleting SupportForge priority roles requires the Administrator permission.');
      }
      const settings = await getAdvancedSettings(guild.id);
      if (mode === 'status') {
        const priorities: TicketPriority[] = ['critical', 'urgent', 'high', 'normal', 'low'];
        const lines = priorities.map((item) => {
          const roleId = settings.priorityRoles[item];
          const role = roleId ? guild.roles.cache.get(roleId) : undefined;
          return '**' + item.toUpperCase() + '** · ' + (role ? role.toString() : 'No managed role configured');
        });
        await interaction.editReply('**Priority Rules & Roles**\n\n' + lines.join('\n') + '\n\nUse /supportforge settings priority-role to create or delete a managed role.');
        return;
      }

      const priorityValue = interaction.options.getString('priority');
      if (!priorityValue) throw new Error('Choose a priority when creating or deleting a managed role.');
      const priority = priorityValue as TicketPriority;
      const savedId = settings.priorityRoles[priority];
      const existing = savedId ? guild.roles.cache.get(savedId) : undefined;
      if (mode === 'create') {
        if (existing) {
          await interaction.editReply('The ' + priority + ' priority role already exists: ' + existing.toString());
          return;
        }
        const bot = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
        if (!bot?.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('SupportForge needs Manage Roles to create priority roles.');
        const roleMeta: Record<TicketPriority, { label: string; color: number }> = {
          low: { label: 'Low', color: 0x2ecc71 },
          normal: { label: 'Normal', color: 0xf1c40f },
          high: { label: 'High', color: 0xe67e22 },
          urgent: { label: 'Urgent', color: 0xe74c3c },
          critical: { label: 'Critical', color: 0x9b59b6 },
        };
        const meta = roleMeta[priority];
        const role = await guild.roles.create({
          name: 'SupportForge • ' + meta.label + ' Tickets',
          colors: { primaryColor: meta.color },
          mentionable: false,
          reason: 'SupportForge priority role created through slash command',
        });
        await updateAdvancedSettings(guild.id, (current) => { current.priorityRoles[priority] = role.id; });
        await enforcePriorityRoleHierarchy(guild);
        await refreshSettingsChannel(guild);
        audit('PRIORITY_ROLE_CREATED', 'Created ' + role.name + ' for ' + priority + ' priority.');
        await interaction.editReply('Created ' + role.toString() + ' for **' + priority + '** priority.');
      } else if (mode === 'delete') {
        if (!existing) {
          await updateAdvancedSettings(guild.id, (current) => { delete current.priorityRoles[priority]; });
          await refreshSettingsChannel(guild);
          audit('PRIORITY_ROLE_CLEANED', 'Cleared stale or missing ' + priority + ' priority role configuration.');
          await interaction.editReply('No ' + priority + ' priority role exists. Stale configuration was cleared.');
          return;
        }
        const bot = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
        if (!existing.editable || existing.managed || !bot?.permissions.has(PermissionFlagsBits.ManageRoles)) {
          throw new Error('Discord will not let SupportForge delete that role. Move the bot role above it and ensure Manage Roles is granted.');
        }
        await existing.delete('SupportForge priority role removed through slash command');
        await updateAdvancedSettings(guild.id, (current) => { delete current.priorityRoles[priority]; });
        await enforcePriorityRoleHierarchy(guild);
        await refreshSettingsChannel(guild);
        audit('PRIORITY_ROLE_DELETED', 'Deleted ' + existing.name + ' for ' + priority + ' priority.');
        await interaction.editReply('Deleted the ' + priority + ' priority role.');
      } else {
        throw new Error('Unsupported priority-role action.');
      }
      return;
    }

    if (action === 'report-subcategory-add' || action === 'report-subcategory-edit' || action === 'report-subcategory-remove') {
      const categoryId = interaction.options.getString('category-id', true).trim();
      const settings = await getAdvancedSettings(guild.id);
      const category = settings.reports.categories[categoryId];
      if (!category) throw new Error('Report category not found. Use Settings report controls to inspect configured categories.');
      if (action === 'report-subcategory-add') {
        const name = interaction.options.getString('name', true).trim().replace(/\s+/g, ' ');
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
        if (!id) throw new Error('Subcategory name must contain letters or numbers.');
        if (category.subcategories[id]) throw new Error('A report subcategory with that name already exists.');
        const now = new Date().toISOString();
        await updateAdvancedSettings(guild.id, (current) => {
          const item = current.reports.categories[categoryId];
          if (item) item.subcategories[id] = { id, name, createdAt: now, updatedAt: now };
        });
        audit('REPORT_SUBCATEGORY_ADDED', 'Added ' + name + ' to report category ' + categoryId + '.');
        await interaction.editReply('Added report subcategory **' + name + '** (' + id + ').');
      } else {
        const subId = interaction.options.getString('subcategory-id', true).trim();
        const sub = category.subcategories[subId];
        if (!sub) throw new Error('Report subcategory not found.');
        if (action === 'report-subcategory-edit') {
          const name = interaction.options.getString('name', true).trim().replace(/\s+/g, ' ');
          if (!name) throw new Error('Subcategory name cannot be empty.');
          await updateAdvancedSettings(guild.id, (current) => {
            const item = current.reports.categories[categoryId]?.subcategories[subId];
            if (item) { item.name = name; item.updatedAt = new Date().toISOString(); }
          });
          audit('REPORT_SUBCATEGORY_EDITED', 'Renamed subcategory ' + subId + ' to ' + name + '.');
          await interaction.editReply('Renamed report subcategory to **' + name + '**.');
        } else {
          if (Object.keys(category.subcategories).length <= 1) throw new Error('Each report category must retain at least one subcategory.');
          await updateAdvancedSettings(guild.id, (current) => { const item = current.reports.categories[categoryId]; if (item) delete item.subcategories[subId]; });
          audit('REPORT_SUBCATEGORY_REMOVED', 'Removed subcategory ' + subId + ' from ' + categoryId + '.');
          await interaction.editReply('Removed report subcategory **' + sub.name + '**.');
        }
      }
      await refreshSettingsChannel(guild);
      return;
    }

    if (action === 'repair') {
      const mode = interaction.options.getString('mode', true) as 'normal' | 'storage';
      const result = await hooks.repair(guild, mode);
      await interaction.editReply('✅ ' + result);
      audit(mode === 'normal' ? 'NORMAL_REPAIR' : 'STORAGE_REPAIR', result);
      return;
    }

    if (action === 'refresh') {
      await hooks.refresh(guild);
      await interaction.editReply('Settings dashboard and support panel refreshed.');
      return;
    }

    if (action === 'manual') {
      const version = interaction.options.getString('version', true);
      await interaction.editReply(
        '**SupportForge ' + (version === 'quick' ? 'Quick Manual' : 'Detailed Manual') + '**\n\n' +
        'Use Claim to take ownership, Pending when waiting for a customer, Resume to return a pending ticket to open, and Close to generate the transcript and lock the ticket.\n\n' +
        'Administrators can configure departments, tags, retention, panel behavior, report safety, and forms using Settings buttons or slash commands.\n\n' +
        'For the full detailed guide, open Settings → Manual and choose the detailed version.'
      );
      return;
    }

    if (action === 'reset') {
      const confirmation = interaction.options.getString('confirmation', true).trim().toUpperCase();
      if (confirmation !== 'DELETE SUPPORT FORGE') throw new Error('Confirmation must be exactly DELETE SUPPORT FORGE. Nothing was deleted.');
      const accumulate = interaction.options.getBoolean('accumulate-audit', true);
      await interaction.editReply('SupportForge factory reset started. This is destructive and cannot be undone.');
      const result = await performFactoryReset(guild, accumulate);
      const failures = result.failed.slice(0, 8).map((failure) => '• ' + failure.name + ' (' + failure.id + '): ' + failure.error).join('\n');
      await interaction.followUp({
        content: (result.complete ? '✅' : '⚠️') + ' Factory reset ' + (result.complete ? 'completed' : 'partially completed') +
          '. Deleted channels: **' + result.deletedChannels + '** · roles: **' + result.deletedRoles + '**.' +
          (failures ? '\n\nFailures:\n' + failures : '') +
          (result.failed.length > 8 ? '\n…and ' + (result.failed.length - 8) + ' more failure(s).' : ''),
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined);
      return;
    }

    throw new Error('Unsupported Settings command.');
  } catch (error) {
    await interaction.editReply('❌ ' + (error instanceof Error ? error.message : 'Settings command failed.')).catch(() => undefined);
  }
}
