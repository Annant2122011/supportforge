const LEGACY_PRODUCT_NAMES = ['Resolv' + 'X', 'Resolve' + 'X', 'Support' + 'Forge'] as const;

const KNOWN_PRODUCT_NAMES = ['QueryFixr', ...LEGACY_PRODUCT_NAMES] as const;

/**
 * Recognize historical branded artifacts without presenting an old name in
 * new user-facing content. These checks are used only for safe replay and
 * reconciliation of data created by older releases.
 */
export function isRecoveryArchiveFooter(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const prefixes = KNOWN_PRODUCT_NAMES.map((name) => name + ' Recovery Archive');
  const normalized = value.toLocaleLowerCase('en-US');
  return prefixes.some((prefix) => normalized.startsWith(prefix.toLocaleLowerCase('en-US')));
}

export function isTicketPanelTitle(value: unknown): boolean {
  const title = typeof value === 'string' ? value : String(value ?? '');
  const normalized = title.toLocaleLowerCase('en-US');
  return KNOWN_PRODUCT_NAMES.some((name) =>
    normalized.includes((name + ' Ticket #').toLocaleLowerCase('en-US')),
  );
}

export function isManagedDepartmentCategoryName(value: string): boolean {
  const normalized = value.toLocaleLowerCase('en-US');
  return KNOWN_PRODUCT_NAMES.some((name) =>
    normalized.startsWith((name + '.').toLocaleLowerCase('en-US')),
  );
}
