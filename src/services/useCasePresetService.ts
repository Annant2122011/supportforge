import {
  getGuildConfig,
  newDepartmentId,
  newTagId,
  updateGuildConfig,
} from './configService';

export interface UseCasePreset {
  name: string;
  emoji: string;
  tags: string[];
}

export const USE_CASE_PRESETS: Record<string, UseCasePreset> = {
  'technical-support': {
    name: 'Technical Support', emoji: '🛠️',
    tags: ['Bug Report', 'Error Message', 'Performance Issue', 'Installation', 'Configuration', 'Integration', 'Feature Request', 'Compatibility'],
  },
  sales: {
    name: 'Sales', emoji: '💼',
    tags: ['Pricing', 'Plan Comparison', 'Quote Request', 'Product Demo', 'Enterprise Inquiry', 'Volume Discount', 'Purchase Assistance', 'Upgrade Inquiry'],
  },
  'account-access': {
    name: 'Account & Access', emoji: '🔐',
    tags: ['Login Issue', 'Password Reset', 'Email Change', 'Two-Factor Authentication', 'Account Verification', 'Account Recovery', 'Permission Issue', 'Account Deletion'],
  },
  partnerships: {
    name: 'Partnerships', emoji: '🤝',
    tags: ['Partnership Proposal', 'Affiliate Program', 'Integration Proposal', 'Reseller Inquiry', 'Co-Marketing', 'Sponsorship', 'API Collaboration', 'Business Development'],
  },
  'reports-abuse': {
    name: 'Reports & Abuse', emoji: '🚩',
    tags: ['Harassment', 'Spam', 'Scam Attempt', 'Impersonation', 'Malicious Content', 'Terms Violation', 'Privacy Concern', 'Appeal'],
  },
  'refunds-returns': {
    name: 'Refunds & Returns', emoji: '↩️',
    tags: ['Refund Request', 'Return Request', 'Duplicate Charge', 'Billing Error', 'Cancel Order', 'Missing Refund', 'Damaged Item', 'Exchange Request'],
  },
  'product-support': {
    name: 'Product Support', emoji: '📦',
    tags: ['Product Question', 'Setup Assistance', 'Feature Guidance', 'Product Defect', 'Compatibility', 'Warranty Claim', 'Replacement Request', 'Documentation'],
  },
  'vip-support': {
    name: 'VIP Support', emoji: '⭐',
    tags: ['Priority Escalation', 'Service Outage', 'Executive Request', 'Dedicated Assistance', 'SLA Concern', 'Critical Business Impact', 'Account Review', 'Renewal Assistance'],
  },
};

export async function addUseCasePreset(guildId: string, key: string): Promise<{
  id: string;
  name: string;
  tagNames: string[];
}> {
  const preset = USE_CASE_PRESETS[key];
  if (!preset) throw new Error('Unknown support use case.');

  const config = await getGuildConfig(guildId);
  if (Object.values(config.departments).some((department) => department.name.toLowerCase() === preset.name.toLowerCase())) {
    throw new Error('A department named "' + preset.name + '" is already configured.');
  }

  const departmentId = newDepartmentId();
  const now = new Date().toISOString();
  const tags = Object.fromEntries(
    preset.tags.map((tagName) => {
      const tagId = newTagId();
      return [tagId, { id: tagId, name: tagName, createdAt: now }];
    }),
  );

  await updateGuildConfig(guildId, (current) => {
    current.departments[departmentId] = {
      id: departmentId,
      name: preset.name,
      staffRoleId: null,
      categoryId: null,
      tags,
      createdAt: now,
    };
  });

  return { id: departmentId, name: preset.name, tagNames: [...preset.tags] };
}
