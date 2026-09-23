import 'dotenv/config';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_CHANNEL_TIMEOUT_MS = 15_000;
const MAX_AUTOMATIC_RETRY_DELAY_MS = 5_000;
const MAX_RATE_LIMIT_RETRIES = 1;

/*
 * Native REST is used for channel mutations because discord.js channel
 * mutation calls were previously timing out in this project. Since native
 * fetch bypasses discord.js' REST manager, SupportForge keeps its own
 * conservative global pacing layer. Discord currently documents a 50
 * requests/second global bot limit, but the value is deliberately treated
 * as an implementation safety ceiling rather than a Discord guarantee.
 */
const GLOBAL_REQUEST_SPACING_MS = 25;

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

interface DiscordRateLimitBody {
  message?: string;
  retry_after?: number;
  global?: boolean;
}

const channelRateLimitUntil = new Map<string, number>();
const bucketRateLimitUntil = new Map<string, number>();
const channelRequestQueues = new Map<string, Promise<void>>();
let globalRateLimitUntil = 0;
let lastNativeRequestAt = 0;
let globalRequestQueue: Promise<void> = Promise.resolve();

function permissionListToBitfield(
  values: PermissionValue[] | undefined,
): string {
  if (!values || values.length === 0) {
    return '0';
  }

  let result = 0n;

  for (const value of values) {
    result |= BigInt(value);
  }

  return result.toString();
}

function getRemainingCooldown(until: number): number {
  return Math.max(0, until - Date.now());
}

function rememberRateLimit(
  channelId: string,
  retryAfterMs: number,
  isGlobal: boolean,
  bucket?: string | null,
): void {
  const until = Date.now() + retryAfterMs;

  if (isGlobal) {
    globalRateLimitUntil = Math.max(globalRateLimitUntil, until);
    return;
  }

  channelRateLimitUntil.set(
    channelId,
    Math.max(channelRateLimitUntil.get(channelId) ?? 0, until),
  );

  if (bucket) {
    const key = `${channelId}:${bucket}`;
    bucketRateLimitUntil.set(
      key,
      Math.max(bucketRateLimitUntil.get(key) ?? 0, until),
    );
  }
}

function rememberSuccessfulBucket(
  channelId: string,
  response: Response,
): void {
  const bucket = response.headers.get('x-ratelimit-bucket');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const resetAfter = response.headers.get('x-ratelimit-reset-after');

  if (!bucket || remaining !== '0') {
    return;
  }

  const seconds = Number(resetAfter);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return;
  }

  const until = Date.now() + Math.ceil(seconds * 1000);
  const key = `${channelId}:${bucket}`;

  bucketRateLimitUntil.set(
    key,
    Math.max(bucketRateLimitUntil.get(key) ?? 0, until),
  );
}

function getRateLimitCooldown(channelId: string): number {
  let cooldown = Math.max(
    getRemainingCooldown(globalRateLimitUntil),
    getRemainingCooldown(channelRateLimitUntil.get(channelId) ?? 0),
  );

  const prefix = `${channelId}:`;

  for (const [key, until] of bucketRateLimitUntil) {
    if (key.startsWith(prefix)) {
      cooldown = Math.max(
        cooldown,
        getRemainingCooldown(until),
      );
    }
  }

  return cooldown;
}

function parseRetryAfter(
  text: string,
  response: Response,
): {
  retryAfterMs: number;
  global: boolean;
  bucket: string | null;
  scope: string | null;
} {
  let body: DiscordRateLimitBody = {};

  try {
    body = JSON.parse(text) as DiscordRateLimitBody;
  } catch {
    // Fall back to the standard HTTP header if the body is not JSON.
  }

  const headerRetryAfter = response.headers.get('retry-after');

  const retryAfterSeconds =
    typeof body.retry_after === 'number'
      ? body.retry_after
      : headerRetryAfter
        ? Number(headerRetryAfter)
        : 0;

  const retryAfterMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.ceil(retryAfterSeconds * 1000)
      : 1000;

  return {
    retryAfterMs,
    global:
      body.global === true ||
      response.headers.get('x-ratelimit-global') === 'true',
    bucket:
      response.headers.get('x-ratelimit-bucket'),
    scope:
      response.headers.get('x-ratelimit-scope'),
  };
}

function createRateLimitError(
  operation: string,
  retryAfterMs: number,
  global: boolean,
): Error {
  const seconds = Math.ceil(retryAfterMs / 1000);
  const scope = global ? 'global' : 'this Discord channel/resource';

  return new Error(
    `Discord rate limit active for ${scope}. ${operation} cannot be retried automatically for another ${seconds}s.`,
  );
}

async function waitForGlobalRequestSpacing(): Promise<void> {
  const previous = globalRequestQueue;

  let release!: () => void;

  const gate =
    new Promise<void>((resolve) => {
      release = resolve;
    });

  globalRequestQueue =
    previous.then(() => gate);

  await previous;

  try {
    const elapsed =
      Date.now() - lastNativeRequestAt;

    const remaining =
      GLOBAL_REQUEST_SPACING_MS - elapsed;

    if (remaining > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, remaining);
      });
    }

    lastNativeRequestAt =
      Date.now();
  } finally {
    release();
  }
}

async function waitForCooldown(
  channelId: string,
  operation: string,
): Promise<void> {
  const cooldownMs = getRateLimitCooldown(channelId);

  if (cooldownMs <= 0) {
    return;
  }

  if (cooldownMs > MAX_AUTOMATIC_RETRY_DELAY_MS) {
    throw createRateLimitError(
      operation,
      cooldownMs,
      getRemainingCooldown(globalRateLimitUntil) >= cooldownMs,
    );
  }

  console.log(
    `⏳ Discord rate limit: waiting ${cooldownMs}ms before ${operation}`,
  );

  await new Promise<void>((resolve) => {
    setTimeout(resolve, cooldownMs);
  });
}

async function discordRequest<T = unknown>(
  channelId: string,
  method: 'PATCH' | 'PUT',
  path: string,
  body: Record<string, unknown>,
  operation: string,
): Promise<T> {
  const token = process.env.DISCORD_TOKEN;

  if (!token) {
    throw new Error('DISCORD_TOKEN is missing from environment.');
  }

  /*
   * Serialize every native channel mutation locally as a second line of
   * defense. Discord's resource limits are keyed around major resources
   * such as channel IDs, so concurrent PATCH/PUT operations for one ticket
   * should never race each other.
   */
  const previous =
    channelRequestQueues.get(channelId) ??
    Promise.resolve();

  let release!: () => void;

  const gate =
    new Promise<void>((resolve) => {
      release = resolve;
    });

  const current =
    previous.then(() => gate);

  channelRequestQueues.set(
    channelId,
    current,
  );

  await previous;

  try {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    await waitForCooldown(channelId, operation);
    await waitForGlobalRequestSpacing();

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      DISCORD_CHANNEL_TIMEOUT_MS,
    );

    try {
      console.log(
        `🌐 Discord native REST: ${method} ${path} (${operation})`,
      );

      const response = await fetch(
        `${DISCORD_API_BASE}${path}`,
        {
          method,
          headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'DiscordBot (https://github.com/Annant2122011/supportforge, 2.0.0)',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      const text = await response.text();

      if (response.status === 429) {
        const {
          retryAfterMs,
          global,
          bucket,
          scope,
        } = parseRetryAfter(
          text,
          response,
        );

        rememberRateLimit(
          channelId,
          retryAfterMs,
          global,
          bucket,
        );

        console.warn(
          `⚠️ Discord rate limit: ${operation}; retry_after=${Math.ceil(retryAfterMs / 1000)}s; global=${global}; scope=${scope ?? 'unknown'}; bucket=${bucket ?? 'unknown'}`,
        );

        if (
          attempt < MAX_RATE_LIMIT_RETRIES &&
          retryAfterMs <= MAX_AUTOMATIC_RETRY_DELAY_MS
        ) {
          continue;
        }

        throw createRateLimitError(
          operation,
          retryAfterMs,
          global,
        );
      }

      if (!response.ok) {
        throw new Error(
          `Discord ${method} ${operation} failed with HTTP ${response.status}: ${text}`,
        );
      }

      rememberSuccessfulBucket(
        channelId,
        response,
      );

      if (!text) {
        return undefined as T;
      }

      return JSON.parse(text) as T;
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === 'AbortError'
      ) {
        throw new Error(
          `Discord ${method} ${operation} timed out after ${DISCORD_CHANNEL_TIMEOUT_MS}ms.`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

    throw new Error(
      `Discord ${method} ${operation} exhausted its rate-limit retries.`,
    );
  } finally {
    release();

    if (
      channelRequestQueues.get(channelId) === current
    ) {
      channelRequestQueues.delete(channelId);
    }
  }
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
