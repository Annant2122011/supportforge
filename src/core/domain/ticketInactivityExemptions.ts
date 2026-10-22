/**
 * Shared normalization and matching for inactivity auto-close exclusions.
 * Administrator-controlled lists are bounded so persisted settings cannot
 * grow without limit and older/malformed documents fail closed to no extras.
 */
export const MAX_INACTIVITY_EXEMPTIONS = 25;

export function normalizeInactivityExemptionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((candidate): candidate is string => typeof candidate === 'string')
      .map((candidate) => candidate.trim())
      .filter((candidate) => candidate.length > 0 && candidate.length <= 100),
  )].slice(0, MAX_INACTIVITY_EXEMPTIONS);
}

export function isDepartmentExemptFromInactivity(
  departmentId: string | null | undefined,
  exemptDepartmentIds: readonly string[],
): boolean {
  return Boolean(departmentId && exemptDepartmentIds.includes(departmentId));
}

export function hasExemptInactivityRole(
  memberRoleIds: readonly string[],
  exemptRoleIds: readonly string[],
): boolean {
  if (exemptRoleIds.length === 0 || memberRoleIds.length === 0) return false;
  const memberRoles = new Set(memberRoleIds);
  return exemptRoleIds.some((roleId) => memberRoles.has(roleId));
}
