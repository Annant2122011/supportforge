import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';

import { getGuildConfig, newTagId, updateGuildConfig } from '../services/configService';
import { getAdvancedSettings, updateAdvancedSettings, type TicketPriority } from '../services/advancedSettingsService';
import { getLocaleLabel, isSupportedLocale } from '../i18n/localeRegistry';
import { translate } from '../i18n/translationService';
import { getTicketWorkspaceMode, setTicketWorkspaceMode } from '../services/privateThreadTicketService';
import { ensureArchiveCategory, ensureClosedCategory, ensureOptionalStatusCategory, getOptionalStatusCategory } from '../services/ticketStorageService';
import { refreshSettingsChannel } from '../services/settingsChannelService';
import { addUseCasePreset } from '../services/useCasePresetService';
import { performFactoryReset } from '../services/factoryResetService';
import { logSettingsEvent, refreshAuditPanelTheme } from '../services/auditLogService';
import { approveRetentionDeletion, declineRetentionDeletion, getEligibleRetentionTickets } from '../services/ticketRetentionService';
import { clearTicketInactivityWarningsForGuild } from '../services/ticketInactivityService';
import { migrateDepartmentStaffRole } from '../services/departmentStaffRoleService';
import { enforcePriorityRoleHierarchy } from '../services/priorityRoleService';
import { getThemeColor, getThemeDefinition, isGuildTheme } from '../services/uiThemeService';
import {
  createDefaultSupportHoursPolicy,
  deleteSupportHoursPolicy,
  evaluateSupportHours,
  formatSupportHoursInstant,
  getSupportHoursPolicies,
  getSupportHoursPolicy,
  parseSupportHoursIntervals,
  resolveEffectiveSupportHoursPolicy,
  saveSupportHoursPolicy,
  SUPPORT_HOURS_DAYS,
  type SupportHoursDay,
  type SupportHoursScopeType,
  type OutsideHoursBehavior,
} from '../services/supportHoursService';

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
    if (action === 'language') {
      const current = await getAdvancedSettings(guild.id);
      const permissions = interaction.memberPermissions;
      if (
        !permissions ||
        (!permissions.has(PermissionFlagsBits.Administrator) &&
          !permissions.has(PermissionFlagsBits.ManageGuild))
      ) {
        await interaction.editReply(translate(current.locale, 'errors.permissionDenied'));
        return;
      }
      const selected = interaction.options.getString('locale');
      if (!selected) {
        await interaction.editReply(
          translate(current.locale, 'settings.locale.current', { locale: getLocaleLabel(current.locale) }),
        );
        return;
      }
      if (!isSupportedLocale(selected)) {
        await interaction.editReply(translate(current.locale, 'settings.locale.unknown'));
        return;
      }
      await updateAdvancedSettings(guild.id, (settings) => { settings.locale = selected; });
      await refreshSettingsChannel(guild);
      audit('SERVER_LANGUAGE_CHANGED', 'Changed the server language to ' + selected + ' (' + getLocaleLabel(selected) + ').');
      await interaction.editReply(
        translate(selected, 'settings.locale.saved', { locale: getLocaleLabel(selected) }),
      );
      return;
    }

    if (action === 'overview') {
      const settings = await getAdvancedSettings(guild.id);
      const departments = Object.values(config.departments);
      const tagCount = departments.reduce((sum, department) => sum + Object.keys(department.tags ?? {}).length, 0);
      await interaction.editReply(
        '**QueryFixr Settings Overview**\n\n' +
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

    if (action === 'theme') {
      const mode = interaction.options.getString('action', true);
      const requestedTheme = interaction.options.getString('theme');
      if (mode === 'set') {
        if (!isGuildTheme(requestedTheme)) throw new Error('Choose a supported theme when using action:set.');
        const previousTheme = (await getGuildConfig(guild.id)).theme;
        await updateGuildConfig(guild.id, (current) => { current.theme = requestedTheme; });
        if (previousTheme !== requestedTheme) {
          await hooks.syncPanel(guild);
          await refreshSettingsChannel(guild);
          await refreshAuditPanelTheme(guild);
          audit('SERVER_THEME_CHANGED', 'Changed the server UI theme from ' + getThemeDefinition(previousTheme).label + ' to ' + getThemeDefinition(requestedTheme).label + ' through slash command.');
        }
      }
      const currentConfig = await getGuildConfig(guild.id);
      const activeTheme = getThemeDefinition(currentConfig.theme);
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(getThemeColor(currentConfig.theme))
          .setTitle('🌈 Server Theme')
          .setDescription('Each server stores its own theme. Changing this palette does not affect other servers. It accents the public support panel, Settings dashboard and Ticket Forms screens.')
          .addFields(
            { name: 'Current theme', value: '**' + activeTheme.label + '**\n' + activeTheme.description, inline: true },
            { name: 'Change it', value: 'Use /supportforge settings theme with action:set and choose a palette.', inline: true },
          )
          .setFooter({ text: 'QueryFixr • Server-specific appearance' })],
      });
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

    if (action === 'inactivity') {
      const mode = interaction.options.getString('action', true);
      const idleHours = interaction.options.getInteger('idle-hours');
      const graceHours = interaction.options.getInteger('grace-hours');
      const exemptRolesRaw = interaction.options.getString('exempt-roles');
      const exemptDepartmentsRaw = interaction.options.getString('exempt-departments');
      const supportedActions = [
        'show', 'enable', 'disable', 'configure',
        'set-exempt-roles', 'set-exempt-departments', 'clear-exemptions',
      ];
      if (!supportedActions.includes(mode)) {
        throw new Error('Choose a supported inactivity policy action.');
      }
      if ((idleHours !== null && (idleHours < 1 || idleHours > 720)) ||
          (graceHours !== null && (graceHours < 1 || graceHours > 168))) {
        throw new Error('Idle hours must be 1–720 and grace hours must be 1–168.');
      }
      if (mode === 'configure' && idleHours === null && graceHours === null) {
        throw new Error('Supply idle-hours, grace-hours, or both when configuring the inactivity policy.');
      }

      const parseIds = (raw: string | null): string[] => [...new Set(
        (raw ?? '').split(',').map((value) => value.trim()).filter(Boolean),
      )];
      let requestedRoleIds: string[] | null = null;
      let requestedDepartmentIds: string[] | null = null;

      if (mode === 'set-exempt-roles') {
        if (exemptRolesRaw === null) throw new Error('Supply exempt-roles as a comma-separated list of Discord role IDs. Use clear-exemptions to clear both lists.');
        requestedRoleIds = parseIds(exemptRolesRaw);
        if (requestedRoleIds.length < 1 || requestedRoleIds.length > 25) {
          throw new Error('Supply between 1 and 25 role IDs. Use clear-exemptions to remove every exemption.');
        }
        const knownRoles = await guild.roles.fetch().catch(() => guild.roles.cache);
        const missingRoles = requestedRoleIds.filter((id) => !knownRoles.has(id));
        if (missingRoles.length) throw new Error('These role IDs were not found in this server: ' + missingRoles.join(', '));
      }

      if (mode === 'set-exempt-departments') {
        if (exemptDepartmentsRaw === null) throw new Error('Supply exempt-departments as a comma-separated list of configured department IDs. Use clear-exemptions to clear both lists.');
        requestedDepartmentIds = parseIds(exemptDepartmentsRaw);
        if (requestedDepartmentIds.length < 1 || requestedDepartmentIds.length > 25) {
          throw new Error('Supply between 1 and 25 department IDs. Use clear-exemptions to remove every exemption.');
        }
        const currentConfig = await getGuildConfig(guild.id);
        const missingDepartments = requestedDepartmentIds.filter((id) => !currentConfig.departments[id]);
        if (missingDepartments.length) throw new Error('These department IDs are not configured in this server: ' + missingDepartments.join(', '));
      }

      const mutating = ['enable', 'disable', 'configure', 'set-exempt-roles', 'set-exempt-departments', 'clear-exemptions'].includes(mode);
      if (mutating) {
        await updateAdvancedSettings(guild.id, (settings) => {
          if (mode === 'enable') settings.inactivity.enabled = true;
          if (mode === 'disable') settings.inactivity.enabled = false;
          if (idleHours !== null) settings.inactivity.idleHours = idleHours;
          if (graceHours !== null) settings.inactivity.graceHours = graceHours;
          if (requestedRoleIds) settings.inactivity.exemptRoleIds = requestedRoleIds;
          if (requestedDepartmentIds) settings.inactivity.exemptDepartmentIds = requestedDepartmentIds;
          if (mode === 'clear-exemptions') {
            settings.inactivity.exemptRoleIds = [];
            settings.inactivity.exemptDepartmentIds = [];
          }
          settings.inactivity.generation = Math.min(2147483647, settings.inactivity.generation + 1);
        });
        await clearTicketInactivityWarningsForGuild(guild);
        await refreshSettingsChannel(guild);
        const savedPolicy = (await getAdvancedSettings(guild.id)).inactivity;
        audit('TICKET_INACTIVITY_' + mode.toUpperCase(),
          'Inactivity auto-close action=' + mode + '; enabled=' + savedPolicy.enabled +
          '; idleHours=' + savedPolicy.idleHours + '; graceHours=' + savedPolicy.graceHours +
          '; exemptRoleIds=' + savedPolicy.exemptRoleIds.join(',') +
          '; exemptDepartmentIds=' + savedPolicy.exemptDepartmentIds.join(',') + '.');
      }

      const inactivity = (await getAdvancedSettings(guild.id)).inactivity;
      const currentConfig = await getGuildConfig(guild.id);
      const roleNames = inactivity.exemptRoleIds
        .map((id) => guild.roles.cache.get(id)?.name ?? id)
        .join(', ') || 'None';
      const departmentNames = inactivity.exemptDepartmentIds
        .map((id) => currentConfig.departments[id]?.name ? currentConfig.departments[id].name + ' (' + id + ')' : id)
        .join(', ') || 'None';
      await interaction.editReply(
        '**Ticket Inactivity Automation**\n' +
        'Status: **' + (inactivity.enabled ? 'Enabled' : 'Disabled') + '**\n' +
        'Warning threshold: **' + inactivity.idleHours + ' idle hours**\n' +
        'Grace period: **' + inactivity.graceHours + ' additional hours**\n' +
        'Exempt roles (owner or assigned staff): **' + roleNames + '**\n' +
        'Exempt departments: **' + departmentNames + '**\n\n' +
        'Automation is opt-in. Warnings persist across restarts; closure requires a saved transcript, unchanged activity timestamp and no configured exemption.\n' +
        'Use action:set-exempt-roles with exempt-roles, action:set-exempt-departments with exempt-departments, or action:clear-exemptions to manage exclusions.'
      );
      return;
    }

    if (action === 'ticket-workspace') {
      const requested = interaction.options.getString('action', true);
      if (requested !== 'show' && requested !== 'text-channels' && requested !== 'private-threads') {
        throw new Error('Choose show, text-channels, or private-threads.');
      }
      const before = await getTicketWorkspaceMode(guild.id);
      if (requested !== 'show') {
        await setTicketWorkspaceMode(guild.id, requested);
        await refreshSettingsChannel(guild);
        audit('TICKET_WORKSPACE_MODE_CHANGED', 'Changed ticket workspace mode from ' + before + ' to ' + requested + '. Existing tickets were not migrated.');
      }
      const mode = await getTicketWorkspaceMode(guild.id);
      await interaction.editReply(
        '**Ticket Workspace**\nCurrent mode: **' + mode + '**\\n' +
        (mode === 'private-threads'
          ? 'New tickets use private threads inside a department workspace. Configure a staff role for each department and grant the bot Manage Threads and Create Private Threads.'
          : 'New tickets use private text channels.') +
        '\nExisting tickets are unchanged. Use the Settings channel Ticket Workspace button for visual controls.'
      );
      return;
    }

    if (action === 'support-hours') {
      const scopeType = interaction.options.getString('scope', true) as SupportHoursScopeType;
      const scopeIdInput = interaction.options.getString('scope-id');
      const scopeId = scopeIdInput?.trim() || null;
      if (scopeType === 'guild' && scopeId) throw new Error('The server-default scope does not take a scope ID.');
      if (scopeType !== 'guild' && !scopeId) throw new Error('Supply the department ID or panel ID for this scope.');
      if (scopeType === 'department' && !config.departments[scopeId!]) throw new Error('Department ID not found. Use /supportforge category list to see configured IDs.');
      if (scopeType === 'panel' && !config.customPanels[scopeId!]) throw new Error('Ticket panel ID not found. Use /supportforge panel list to see published panel IDs.');

      const currentPolicy = await getSupportHoursPolicy(guild.id, scopeType, scopeId);
      const context = scopeType === 'department'
        ? { departmentId: scopeId! }
        : scopeType === 'panel'
          ? { panelId: scopeId! }
          : {};
      const mode = interaction.options.getString('action', true);

      if (mode === 'show') {
        const allPolicies = await getSupportHoursPolicies(guild.id);
        const effective = resolveEffectiveSupportHoursPolicy(allPolicies, context);
        if (!effective) {
          await interaction.editReply(
            '**Support Hours**\nScope: **' + scopeType + (scopeId ? ' · ' + scopeId : '') + '**\n' +
            'No effective schedule is configured. New tickets are currently unrestricted.\n\n' +
            'Use the set-timezone, set-day, behavior, and enable actions to configure a schedule.',
          );
          return;
        }
        const evaluated = await evaluateSupportHours(guild.id, context);
        const scheduleLines = SUPPORT_HOURS_DAYS.map((day) => {
          const intervals = effective.weeklySchedule[day] ?? [];
          return '**' + day.charAt(0).toUpperCase() + day.slice(1) + ':** ' +
            (intervals.length ? intervals.map((interval) => interval.start + '–' + interval.end).join(', ') : 'Closed');
        });
        const currentState = !evaluated.policyEnabled
          ? 'Enforcement disabled'
          : evaluated.isOpen
            ? 'OPEN'
            : evaluated.ticketCreationAllowed
              ? 'CLOSED · ticket creation allowed with notice'
              : 'CLOSED · new ticket creation restricted';
        const inheritance = currentPolicy
          ? 'Using the configured override for this scope.'
          : 'No override at this scope; using the inherited schedule.';
        await interaction.editReply(
          '**Support Hours**\nScope: **' + scopeType + (scopeId ? ' · ' + scopeId : '') + '**\n' +
          'Status: **' + currentState + '**\n' +
          'Time zone: ' + effective.timezone + '\n' +
          'Outside hours: **' + effective.outsideHoursBehavior + '**\n' +
          'Policy: version **' + effective.version + '** · ' + inheritance + '\n\n' +
          scheduleLines.join('\n') + '\n\n' +
          (evaluated.nextOpeningAt
            ? 'Next opening: **' + formatSupportHoursInstant(evaluated.nextOpeningAt, evaluated.timezone) + '**'
            : (!evaluated.isOpen && evaluated.policyEnabled ? 'No next opening is configured.' : '')));
        return;
      }

      if (mode === 'clear-scope') {
        const removed = await deleteSupportHoursPolicy(guild.id, scopeType, scopeId);
        if (!removed) throw new Error('There is no saved override at this scope to remove.');
        await refreshSettingsChannel(guild);
        audit('SUPPORT_HOURS_CHANGED', 'Removed support-hours override for ' + scopeType + (scopeId ? ' ' + scopeId : '') + '; policy inheritance now applies.');
        await interaction.editReply('✅ Removed the support-hours override. The next applicable scope now controls ticket intake.');
        return;
      }

      const base = currentPolicy ?? createDefaultSupportHoursPolicy(scopeType, scopeId);
      const draft = {
        ...base,
        scopeType,
        scopeId,
        weeklySchedule: Object.fromEntries(SUPPORT_HOURS_DAYS.map((day) => [
          day,
          [...(base.weeklySchedule[day] ?? [])],
        ])) as typeof base.weeklySchedule,
        updatedBy: interaction.user.id,
      };
      if (mode === 'set-timezone') {
        const timezone = interaction.options.getString('timezone')?.trim();
        if (!timezone) throw new Error('Supply an IANA time zone, for example Asia/Kolkata.');
        draft.timezone = timezone;
      } else if (mode === 'set-day') {
        const day = interaction.options.getString('day') as SupportHoursDay | null;
        const intervals = interaction.options.getString('intervals');
        if (!day || !(SUPPORT_HOURS_DAYS as readonly string[]).includes(day)) throw new Error('Choose a valid weekday.');
        if (intervals === null) throw new Error('Supply intervals such as 09:00-12:00,13:00-17:00, or type closed.');
        draft.weeklySchedule[day] = parseSupportHoursIntervals(intervals);
      } else if (mode === 'behavior') {
        const behavior = interaction.options.getString('behavior') as OutsideHoursBehavior | null;
        if (behavior !== 'allow' && behavior !== 'restrict') throw new Error('Choose allow or restrict for outside-hours behavior.');
        draft.outsideHoursBehavior = behavior;
      } else if (mode === 'enable') {
        draft.enabled = true;
      } else if (mode === 'disable') {
        draft.enabled = false;
      } else {
        throw new Error('Unknown support-hours action.');
      }

      const saved = await saveSupportHoursPolicy(guild.id, draft);
      await refreshSettingsChannel(guild);
      audit(
        'SUPPORT_HOURS_CHANGED',
        'Support-hours policy ' + mode + ' at ' + scopeType + (scopeId ? ' ' + scopeId : '') +
          '; version=' + saved.version + '; enabled=' + saved.enabled + '; timezone=' + saved.timezone + '.',
      );
      const message = mode === 'enable'
        ? 'Support-hours enforcement enabled.'
        : mode === 'disable'
          ? 'Support-hours enforcement disabled; ticket creation is unrestricted at this scope.'
          : mode === 'set-timezone'
            ? 'Time zone updated to ' + saved.timezone + '.'
            : mode === 'set-day'
              ? 'Schedule for ' + interaction.options.getString('day', true) + ' updated.'
              : 'Outside-hours behavior updated to ' + saved.outsideHoursBehavior + '.';
      await interaction.editReply(
        '✅ ' + message + '\nScope: **' + scopeType + (scopeId ? ' · ' + scopeId : '') + '** · Policy version **' + saved.version + '**.',
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
      await interaction.editReply(translate(current.locale, enabled ? 'settings.reports.command.enabled' : 'settings.reports.command.disabled'));
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
        throw new Error(translate(settings.locale, 'settings.reports.error.categoryMissing') + ' Run /supportforge settings report-categories without a category ID to list valid IDs.');
      }
      const lines = (selected ? [selected] : categories).map((category) => {
        const subs = Object.values(category.subcategories);
        return category.emoji + ' **' + category.name + '** · ID: ' + category.id + '\n' +
          (subs.length ? subs.map((sub) => '  • ' + sub.name + ' · ID: ' + sub.id).join('\n') : '  ' + translate(settings.locale, 'settings.reports.value.noSubcategories'));
      });
      const content = lines.join('\n\n') || translate(settings.locale, 'settings.reports.value.noCategories');
      const chunks: string[] = [];
      for (const line of content.split('\n')) {
        const current = chunks[chunks.length - 1];
        if (current && (current.length + line.length + 1) > 1700) chunks.push(line);
        else if (current) chunks[chunks.length - 1] = current + '\n' + line;
        else chunks.push(line);
      }
      const requestedPage = interaction.options.getInteger('page') ?? 1;
      if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > chunks.length) throw new Error(translate(settings.locale, 'settings.reports.command.pageOutOfRange', { page: requestedPage, pages: chunks.length }));
      await interaction.editReply('**' + translate(settings.locale, 'settings.reports.command.categoryListTitle') + (selected ? ' · ' + selected.name : '') + ' · ' + translate(settings.locale, 'settings.reports.selector.page', { page: requestedPage, pages: chunks.length }) + '**\n\n' + chunks[requestedPage - 1]);
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
      if (category?.type === ChannelType.GuildCategory) await category.edit({ name: ('QueryFixr.' + newName).slice(0, 100), reason: 'QueryFixr department update from slash command' });
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
      if (mode === 'status') {
        const settings = await getAdvancedSettings(guild.id);
        const claimed = await getOptionalStatusCategory(guild, 'claimed');
        const pending = await getOptionalStatusCategory(guild, 'pending');
        const categoryName = (id: string | null): string =>
          id ? (guild.channels.cache.get(id)?.name ?? 'Configured category') : 'Not provisioned';
        await interaction.editReply(
          '**Storage & Categories**\n' +
          'Closed tickets: **' + categoryName(settings.closedCategoryId) + '**\n' +
          'Archive tickets: **' + categoryName(settings.archiveCategoryId) + '**\n' +
          'Claimed tickets: **' + (claimed?.name ?? 'Not added') + '**\n' +
          'Pending tickets: **' + (pending?.name ?? 'Not added') + '**'
        );
        return;
      }
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
        throw new Error('Creating or deleting QueryFixr priority roles requires the Administrator permission.');
      }
      const settings = await getAdvancedSettings(guild.id);
      if (mode === 'status') {
        const priorities: TicketPriority[] = ['critical', 'urgent', 'high', 'normal', 'low'];
        const lines = priorities.map((item) => {
          const roleId = settings.priorityRoles[item];
          const candidate = roleId ? guild.roles.cache.get(roleId) : undefined;
          const role = candidate && !candidate.managed ? candidate : undefined;
          return '**' + item.toUpperCase() + '** · ' + (role ? role.toString() : 'No managed role configured');
        });
        await interaction.editReply('**Priority Rules & Roles**\n\n' + lines.join('\n') + '\n\nUse /supportforge settings priority-role to create or delete a managed role.');
        return;
      }

      const priorityValue = interaction.options.getString('priority');
      if (!priorityValue) throw new Error('Choose a priority when creating or deleting a managed role.');
      const priority = priorityValue as TicketPriority;
      const savedId = settings.priorityRoles[priority];
      const candidate = savedId ? guild.roles.cache.get(savedId) : undefined;
      const existing = candidate && !candidate.managed ? candidate : undefined;
      if (mode === 'create') {
        if (existing) {
          await interaction.editReply('The ' + priority + ' priority role already exists: ' + existing.toString());
          return;
        }
        const bot = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
        if (!bot?.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('QueryFixr needs Manage Roles to create priority roles.');
        const roleMeta: Record<TicketPriority, { label: string; color: number }> = {
          low: { label: 'Low', color: 0x2ecc71 },
          normal: { label: 'Normal', color: 0xf1c40f },
          high: { label: 'High', color: 0xe67e22 },
          urgent: { label: 'Urgent', color: 0xe74c3c },
          critical: { label: 'Critical', color: 0x9b59b6 },
        };
        const meta = roleMeta[priority];
        const role = await guild.roles.create({
          name: 'QueryFixr • ' + meta.label + ' Tickets',
          colors: { primaryColor: meta.color },
          mentionable: false,
          reason: 'QueryFixr priority role created through slash command',
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
          throw new Error('Discord will not let QueryFixr delete that role. Move the bot role above it and ensure Manage Roles is granted.');
        }
        await existing.delete('QueryFixr priority role removed through slash command');
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
      if (!category) throw new Error(translate(settings.locale, 'settings.reports.error.categoryMissing') + ' Use Settings report controls to inspect configured categories.');
      if (action === 'report-subcategory-add') {
        const name = interaction.options.getString('name', true).trim().replace(/\s+/g, ' ');
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
        if (!id) throw new Error(translate(settings.locale, 'settings.reports.error.subcategoryInvalid'));
        if (category.subcategories[id]) throw new Error(translate(settings.locale, 'settings.reports.error.subcategoryExists'));
        const now = new Date().toISOString();
        await updateAdvancedSettings(guild.id, (current) => {
          const item = current.reports.categories[categoryId];
          if (item) item.subcategories[id] = { id, name, createdAt: now, updatedAt: now };
        });
        audit('REPORT_SUBCATEGORY_ADDED', 'Added ' + name + ' to report category ' + categoryId + '.');
        await interaction.editReply(translate(settings.locale, 'settings.reports.command.subcategoryAdded', { name, id }));
      } else {
        const subId = interaction.options.getString('subcategory-id', true).trim();
        const sub = category.subcategories[subId];
        if (!sub) throw new Error(translate(settings.locale, 'settings.reports.error.subcategoryMissing'));
        if (action === 'report-subcategory-edit') {
          const name = interaction.options.getString('name', true).trim().replace(/\s+/g, ' ');
          if (!name) throw new Error(translate(settings.locale, 'settings.reports.error.subcategoryEmpty'));
          await updateAdvancedSettings(guild.id, (current) => {
            const item = current.reports.categories[categoryId]?.subcategories[subId];
            if (item) { item.name = name; item.updatedAt = new Date().toISOString(); }
          });
          audit('REPORT_SUBCATEGORY_EDITED', 'Renamed subcategory ' + subId + ' to ' + name + '.');
          await interaction.editReply(translate(settings.locale, 'settings.reports.command.subcategoryRenamed', { name }));
        } else {
          if (Object.keys(category.subcategories).length <= 1) throw new Error(translate(settings.locale, 'settings.reports.error.keepOneSubcategory'));
          await updateAdvancedSettings(guild.id, (current) => { const item = current.reports.categories[categoryId]; if (item) delete item.subcategories[subId]; });
          audit('REPORT_SUBCATEGORY_REMOVED', 'Removed subcategory ' + subId + ' from ' + categoryId + '.');
          await interaction.editReply(translate(settings.locale, 'settings.reports.command.subcategoryRemoved', { name: sub.name }));
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
        '**QueryFixr ' + (version === 'quick' ? 'Quick Manual' : 'Detailed Manual') + '**\n\n' +
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
      await interaction.editReply('QueryFixr factory reset started. This is destructive and cannot be undone.');
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
