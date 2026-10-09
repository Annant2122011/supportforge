import 'dotenv/config';
import { Routes, type REST } from 'discord.js';

const MAX_INLINE_RATE_LIMIT_WAIT_MS = 5_000;
const RATE_LIMIT_SAFETY_MARGIN_MS = 750;

type DiscordMutationMethod = 'PATCH' | 'PUT' | 'DELETE';
type PermissionValue = bigint | number | string;

export interface ChannelPermissionOverwrite {
  id: string;
  allow?: PermissionValue[];
  deny?: PermissionValue[];
}

interface DiscordPermissionOverwritePayload {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

interface DeferredDiscordMutation {
  key: string;
  channelId: string;
  method: DiscordMutationMethod;
  path: string;
  body?: Record<string, unknown>;
  operation: string;
  operations: Set<string>;
  timer?: NodeJS.Timeout;
}

let sharedRest: REST | null = null;
const deferredMutations = new Map<string, DeferredDiscordMutation>();

/**
 * All SupportForge channel mutations share discord.js's REST manager so its
 * global, route-bucket, major-parameter and resource sublimit accounting stays
 * consistent with the rest of the bot.
 */
export function configureDiscordChannelRest(rest: REST): void {
  sharedRest = rest;
}

function permissionListToBitfield(
  values: PermissionValue[] | undefined,
): string {
  if (!values || values.length === 0) return '0';

  let result = 0n;
  for (const value of values) result |= BigInt(value);
  return result.toString();
}

function resolveDiscordRoute(method: DiscordMutationMethod, path: string): string {
  const permissionMatch = path.match(/^\/channels\/(\d+)\/permissions\/(\d+)$/);
  if (permissionMatch) {
    if (method === 'PATCH') {
      throw new Error('PATCH is not supported for a single permission-overwrite route.');
    }
    return Routes.channelPermission(permissionMatch[1]!, permissionMatch[2]!);
  }

  const channelMatch = path.match(/^\/channels\/(\d+)$/);
  if (channelMatch && method !== 'DELETE') {
    return Routes.channel(channelMatch[1]!);
  }

  throw new Error('Unsupported SupportForge Discord REST route: ' + method + ' ' + path);
}

function getRateLimitRetryAfterMs(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'retryAfter' in error) {
    const retryAfter = Number((error as { retryAfter?: unknown }).retryAfter);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  }

  const message = error instanceof Error ? error.message : String(error);
  const milliseconds = message.match(/retry(?:\s+after|After)[=: ]+\s*(\d+)\s*ms/i);
  if (milliseconds) {
    const value = Number(milliseconds[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const seconds = message.match(/another\s+(\d+)s\b/i);
  if (seconds) {
    const value = Number(seconds[1]) * 1000;
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

function isGlobalRateLimit(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'global' in error && (error as { global?: unknown }).global === true;
}

function createRateLimitError(operation: string, retryAfterMs: number, global: boolean): Error {
  const seconds = Math.ceil(retryAfterMs / 1000);
  const scope = global ? 'global' : 'shared/resource or route';
  return new Error(
    'Discord rate limit active for ' + scope + '. ' + operation +
    ' is queued for an automatic retry after another ' + seconds + 's.',
  );
}

function deferredMutationKey(method: DiscordMutationMethod, path: string): string {
  if (method === 'PATCH') {
    const channelMatch = path.match(/^\/channels\/(\d+)$/);
    if (channelMatch) return 'PATCH:/channels/' + channelMatch[1];
  }
  return method + ':' + path;
}

function scheduleDeferredMutation(
  request: Omit<DeferredDiscordMutation, 'key' | 'timer' | 'operations'>,
  retryAfterMs: number,
): void {
  const key = deferredMutationKey(request.method, request.path);
  const existing = deferredMutations.get(key);
  if (existing?.timer) clearTimeout(existing.timer);

  const operations = new Set<string>(existing?.operations ?? []);
  operations.add(request.operation ?? 'channel mutation');

  const merged: DeferredDiscordMutation = {
    key,
    channelId: request.channelId,
    method: request.method,
    path: request.path,
    body: request.method === 'PATCH'
      ? { ...(existing?.body ?? {}), ...(request.body ?? {}) }
      : request.body,
    operation: request.operation,
    operations,
  };

  const delay = Math.max(1_000, retryAfterMs) + RATE_LIMIT_SAFETY_MARGIN_MS;
  merged.timer = setTimeout(() => {
    void drainDeferredMutation(key);
  }, delay);
  merged.timer.unref?.();
  deferredMutations.set(key, merged);

  console.warn(
    '⏳ Queued Discord mutation for automatic retry: ' +
    [...operations].slice(-4).join(', ') +
    '; channel=' + request.channelId +
    '; retry_in=' + Math.ceil(delay / 1000) + 's; coalesced=' + operations.size,
  );
}

async function executeDiscordMutation<T>(
  channelId: string,
  method: DiscordMutationMethod,
  path: string,
  body: Record<string, unknown> | undefined,
  operation: string,
): Promise<T> {
  if (!sharedRest) {
    throw new Error('SupportForge Discord REST manager has not been configured.');
  }

  const route = resolveDiscordRoute(method, path);
  const requestOptions = {
    ...(body ? { body } : {}),
    // Short waits are safely queued by discord.js. Long waits are rejected so
    // ticket interactions can commit durable state while a background retry is scheduled.
    rejectOnRateLimit: (rateLimitData: { retryAfter: number }) =>
      rateLimitData.retryAfter > MAX_INLINE_RATE_LIMIT_WAIT_MS,
  };

  try {
    if (method === 'PATCH') return await sharedRest.patch(route, requestOptions) as T;
    if (method === 'PUT') return await sharedRest.put(route, requestOptions) as T;
    return await sharedRest.delete(route, requestOptions) as T;
  } catch (error) {
    const retryAfterMs = getRateLimitRetryAfterMs(error);
    if (retryAfterMs === null || retryAfterMs <= MAX_INLINE_RATE_LIMIT_WAIT_MS) {
      throw error;
    }

    // The existing name-rename queue already maintains desired-name state and
    // updates discord.js' channel cache after success. Do not double-queue it.
    const isNameOnlyPatch =
      method === 'PATCH' &&
      Object.keys(body ?? {}).length === 1 &&
      Object.prototype.hasOwnProperty.call(body ?? {}, 'name');

    if (!isNameOnlyPatch) {
      scheduleDeferredMutation({
        channelId,
        method,
        path,
        ...(body ? { body } : {}),
        operation,
      }, retryAfterMs);
      throw createRateLimitError(operation, retryAfterMs, isGlobalRateLimit(error));
    }

    throw new Error(
      'Discord rate limit active. ' + operation +
      ' cannot be completed for another ' + Math.ceil(retryAfterMs / 1000) + 's.',
      { cause: error },
    );
  }
}

async function drainDeferredMutation(key: string): Promise<void> {
  const request = deferredMutations.get(key);
  if (!request) return;
  deferredMutations.delete(key);
  request.timer = undefined;

  try {
    await executeDiscordMutation(
      request.channelId,
      request.method,
      request.path,
      request.body,
      [...request.operations].slice(-4).join(' / '),
    );
    console.log(
      '✅ Deferred Discord mutation synchronized: ' +
      [...request.operations].slice(-4).join(', ') +
      ' [channel ' + request.channelId + ']',
    );
  } catch (error) {
    const retryAfterMs = getRateLimitRetryAfterMs(error);
    if (retryAfterMs !== null && retryAfterMs > 0) {
      // The route/resource is still throttled. Put the latest merged desired
      // state back behind the server-provided cooldown, without busy retrying.
      scheduleDeferredMutation({
        channelId: request.channelId,
        method: request.method,
        path: request.path,
        ...(request.body ? { body: request.body } : {}),
        operation: [...request.operations].slice(-4).join(' / '),
      }, retryAfterMs);
      return;
    }

    console.error(
      '❌ Deferred Discord mutation failed permanently; manual repair may be required: ' +
      [...request.operations].slice(-4).join(', ') +
      ' [channel ' + request.channelId + ']:',
      error,
    );
  }
}

async function discordRequest<T = unknown>(
  channelId: string,
  method: DiscordMutationMethod,
  path: string,
  body: Record<string, unknown> | undefined,
  operation: string,
): Promise<T> {
  return executeDiscordMutation<T>(channelId, method, path, body, operation);
}

export async function setChannelUserLimit(
  channelId: string,
  userLimit: number,
  operation: string,
): Promise<void> {
  await discordRequest(
    channelId,
    'PATCH',
    '/channels/' + channelId,
    { user_limit: userLimit },
    operation,
  );
}

export async function setChannelName(
  channelId: string,
  name: string,
  operation: string,
): Promise<void> {
  await discordRequest(
    channelId,
    'PATCH',
    `/channels/${channelId}`,
    { name },
    operation,
  );
}

/**
 * Updates the channel name and topic in one PATCH request.
 *
 * Both properties use the same Discord /channels/{channel.id} route bucket.
 * Sending them separately doubles the number of requests and can cause
 * unnecessary 429s when several ticket state changes happen close together.
 */
export async function setChannelNameAndTopic(
  channelId: string,
  name: string,
  topic: string,
  operation: string,
): Promise<void> {
  await discordRequest(
    channelId,
    'PATCH',
    `/channels/${channelId}`,
    { name, topic },
    operation,
  );
}

export async function setChannelParent(
  channelId: string,
  parentId: string,
  operation: string,
): Promise<void> {
  await discordRequest(
    channelId,
    'PATCH',
    `/channels/${channelId}`,
    { parent_id: parentId },
    operation,
  );
}

export async function setChannelTopic(
  channelId: string,
  topic: string,
  operation: string,
): Promise<void> {
  await discordRequest(
    channelId,
    'PATCH',
    `/channels/${channelId}`,
    { topic },
    operation,
  );
}

export async function setChannelTopicAndPermissionOverwrites(
  channelId: string,
  topic: string,
  overwrites: ChannelPermissionOverwrite[],
  roleIds: ReadonlySet<string>,
  operation: string,
): Promise<void> {
  const payload: DiscordPermissionOverwritePayload[] =
    overwrites.map((overwrite) => ({
      id: overwrite.id,
      type: roleIds.has(overwrite.id) ? 0 : 1,
      allow: permissionListToBitfield(overwrite.allow),
      deny: permissionListToBitfield(overwrite.deny),
    }));

  await discordRequest(
    channelId,
    'PATCH',
    `/channels/${channelId}`,
    {
      topic,
      permission_overwrites: payload,
    },
    operation,
  );
}

export async function setChannelPermissionOverwrites(
  channelId: string,
  overwrites: ChannelPermissionOverwrite[],
  roleIds: ReadonlySet<string>,
  operation: string,
): Promise<void> {
  const payload: DiscordPermissionOverwritePayload[] =
    overwrites.map((overwrite) => ({
      id: overwrite.id,
      type: roleIds.has(overwrite.id) ? 0 : 1,
      allow: permissionListToBitfield(overwrite.allow),
      deny: permissionListToBitfield(overwrite.deny),
    }));

  await discordRequest(
    channelId,
    'PATCH',
    `/channels/${channelId}`,
    { permission_overwrites: payload },
    operation,
  );
}

export async function deleteChannelPermissionOverwrite(
  channelId: string,
  overwriteId: string,
  operation: string,
): Promise<void> {
  await discordRequest(
    channelId,
    'DELETE',
    '/channels/' + channelId + '/permissions/' + overwriteId,
    undefined,
    operation,
  );
}

export async function setChannelPermissionOverwrite(
  channelId: string,
  overwriteId: string,
  allow: PermissionValue[],
  deny: PermissionValue[],
  type: 0 | 1,
  operation: string,
): Promise<void> {
  await discordRequest(
    channelId,
    'PUT',
    `/channels/${channelId}/permissions/${overwriteId}`,
    {
      type,
      allow: permissionListToBitfield(allow),
      deny: permissionListToBitfield(deny),
    },
    operation,
  );
}
