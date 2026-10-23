import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeManagedBrandDefault } from '../src/core/domain/managedBrandDefaults';
import {
  normalizeLegacyManagedPanelFooters,
  type GuildConfig,
} from '../src/services/configService';
import {
  buildSettingsSummary,
  normalizeLegacyManagedSettingsDefaults,
  type AdvancedGuildSettings,
} from '../src/services/advancedSettingsService';

const CURRENT_DEFAULT = 'ResolvX • Customer Support';

test('managed brand migration updates only an exact historical default', () => {
  assert.equal(normalizeManagedBrandDefault('SupportForge • Customer Support', CURRENT_DEFAULT), CURRENT_DEFAULT);
  assert.equal(normalizeManagedBrandDefault('ResolveX • Customer Support', CURRENT_DEFAULT), CURRENT_DEFAULT);
  assert.equal(normalizeManagedBrandDefault('SUPPORTFORGE • Customer Support', CURRENT_DEFAULT), CURRENT_DEFAULT);
  assert.equal(normalizeManagedBrandDefault(CURRENT_DEFAULT, CURRENT_DEFAULT), CURRENT_DEFAULT);
});

test('managed brand migration preserves administrator-authored content', () => {
  const customTexts = [
    'SupportForge Premium Help',
    'Contact ResolveX SupportForge customers',
    'SUPPORTFORGE migration notes',
    'My custom footer',
    '',
  ];

  for (const text of customTexts) {
    assert.equal(
      normalizeManagedBrandDefault(text, CURRENT_DEFAULT),
      text,
      'Custom server content must not be rewritten: ' + text,
    );
  }
});

test('managed brand migration leaves non-text and unrelated defaults untouched', () => {
  assert.equal(normalizeManagedBrandDefault(null, CURRENT_DEFAULT), null);
  assert.equal(normalizeManagedBrandDefault(42, CURRENT_DEFAULT), 42);
  assert.equal(normalizeManagedBrandDefault('SupportForge', 'Customer Support'), 'SupportForge');
});


test('guild configuration migration updates only known default panel footers', () => {
  const original = {
    guild: {
      customPanels: {
        defaultFooter: {
          title: 'SupportForge Custom Title',
          description: 'Keep SupportForge instructions',
          footer: 'SupportForge • Customer Support',
          buttons: [{ label: 'SupportForge button', confirmationMessage: 'Keep ResolveX copy' }],
          publishedConfig: {
            title: 'SupportForge Published Title',
            description: 'Published custom text',
            footer: 'SupportForge • Customer Support',
            buttons: [{ label: 'SupportForge published button' }],
          },
        },
        customFooter: {
          title: 'My panel',
          description: 'Custom description',
          footer: 'SupportForge team custom footer',
          buttons: [{ label: 'Help' }],
          publishedConfig: null,
        },
      },
      departments: {
        billing: {
          name: 'SupportForge Billing',
          tags: { supportforge: { name: 'SupportForge', description: 'SupportForge tag details' } },
        },
      },
    },
  } as unknown as Record<string, GuildConfig>;

  const migrated = normalizeLegacyManagedPanelFooters(original);
  const defaultFooterPanel = migrated.guild!.customPanels.defaultFooter!;
  assert.equal(defaultFooterPanel.footer, 'ResolvX • Customer Support');
  assert.equal(defaultFooterPanel.publishedConfig?.footer, 'ResolvX • Customer Support');
  assert.equal(defaultFooterPanel.title, 'SupportForge Custom Title');
  assert.equal(defaultFooterPanel.description, 'Keep SupportForge instructions');
  assert.equal(defaultFooterPanel.buttons[0]?.label, 'SupportForge button');
  assert.equal(defaultFooterPanel.buttons[0]?.confirmationMessage, 'Keep ResolveX copy');
  assert.equal(migrated.guild!.customPanels.customFooter!.footer, 'SupportForge team custom footer');
  assert.equal(migrated.guild!.departments.billing!.name, 'SupportForge Billing');
  assert.equal(migrated.guild!.departments.billing!.tags.supportforge!.name, 'SupportForge');
  assert.equal(original.guild!.customPanels.defaultFooter!.footer, 'SupportForge • Customer Support');
});

test('advanced settings migration updates exact managed defaults but preserves custom labels and descriptions', () => {
  const original = {
    guild: {
      appearance: {
        panelTitle: '🎫 SupportForge Support Center',
        panelDescription: 'Instructions for SupportForge users',
        panelFooter: 'My SupportForge footer',
      },
      settingsDashboard: {
        title: '⚙️ SUPPORTFORGE Settings',
        description: 'Custom SupportForge dashboard description',
        footer: 'SupportForge custom dashboard footer',
        buttonCustomizations: {
          forms: { label: 'SupportForge Forms', emoji: null },
        },
      },
      customTags: {
        custom: {
          id: 'custom',
          name: 'SupportForge',
          emoji: '🏷️',
          description: 'SupportForge tag description',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  } as unknown as Record<string, AdvancedGuildSettings>;

  const migrated = normalizeLegacyManagedSettingsDefaults(original);
  assert.equal(migrated.guild!.appearance.panelTitle, '🎫 ResolvX Support Center');
  assert.equal(migrated.guild!.appearance.panelDescription, 'Instructions for SupportForge users');
  assert.equal(migrated.guild!.appearance.panelFooter, 'My SupportForge footer');
  assert.equal(migrated.guild!.settingsDashboard.title, '⚙️ ResolvX Settings');
  assert.equal(migrated.guild!.settingsDashboard.description, 'Custom SupportForge dashboard description');
  assert.equal(migrated.guild!.settingsDashboard.footer, 'SupportForge custom dashboard footer');
  assert.equal(migrated.guild!.settingsDashboard.buttonCustomizations.forms?.label, 'SupportForge Forms');
  assert.equal(migrated.guild!.customTags.custom!.name, 'SupportForge');
  assert.equal(migrated.guild!.customTags.custom!.description, 'SupportForge tag description');
  assert.equal(original.guild!.appearance.panelTitle, '🎫 SupportForge Support Center');
});


test('settings summary describes a disabled retention timer accurately', () => {
  const settings = {
    inactivity: { enabled: false, idleHours: 72, graceHours: 24 },
    panelActivity: { enabled: true, visualLineBudget: 18, messageBudget: 12 },
    ticketDefaults: { priority: 'normal', maxClaimedModerators: 2 },
    reports: { enabled: true, categories: {}, flagRules: {} },
    priorityRoles: {},
    customTags: {},
    retention: { closedDays: 0, archiveDays: 0 },
    statusCategories: { claimedCategoryId: null, pendingCategoryId: null },
  } as unknown as AdvancedGuildSettings;

  const summary = buildSettingsSummary(settings);
  assert.ok(summary.includes('• Closed: No timer (365-day maximum)'));
  assert.ok(summary.includes('• Archived: No timer (365-day maximum)'));
  assert.equal(summary.includes('Unlimited'), false);
  assert.equal(summary.includes('forever'), false);
});
