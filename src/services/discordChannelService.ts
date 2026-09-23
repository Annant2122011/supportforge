import 'dotenv/config';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_CHANNEL_TIMEOUT_MS = 15_000;

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

interface DiscordChannelPatchBody {
  topic?: string;
  permission_overwrites?: DiscordPermissionOverwritePayload[];
}

function permissionValueToString(
  value: PermissionValue | undefined,
): string {
  if (value === undefined) {
    return '0';
  }

  return String(value);
}

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

async function discordChannelRequest<T = unknown>(
  channelId: string,
  method: 'PATCH' | 'PUT',
  body: Record<string, unknown>,
  operation: string,
): Promise<T> {
  const token = process.env.DISCORD_TOKEN;

  if (!token) {
    throw new Error(
      'DISCORD_TOKEN is missing from environment.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    DISCORD_CHANNEL_TIMEOUT_MS,
  );

  try {
    console.log(
      `🌐 Discord native REST: ${method} /channels/${channelId} (${operation})`,
    );

    const response = await fetch(
      `${DISCORD_API_BASE}/channels/${channelId}`,
      {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Discord ${method} ${operation} failed with HTTP ${response.status}: ${text}`,
      );
    }

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

async function discordPermissionRequest(
  channelId: string,
  overwriteId: string,
  type: 0 | 1,
  allow: PermissionValue[] | undefined,
  deny: PermissionValue[] | undefined,
  operation: string,
): Promise<void> {
  const token = process.env.DISCORD_TOKEN;

  if (!token) {
    throw new Error(
      'DISCORD_TOKEN is missing from environment.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    DISCORD_CHANNEL_TIMEOUT_MS,
  );

  try {
    console.log(
      `🌐 Discord native REST: PUT /channels/${channelId}/permissions/${overwriteId} (${operation})`,
    );

    const response = await fetch(
      `${DISCORD_API_BASE}/channels/${channelId}/permissions/${overwriteId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type,
          allow: permissionListToBitfield(allow),
          deny: permissionListToBitfield(deny),
        }),
        signal: controller.signal,
      },
    );

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Discord PUT ${operation} failed with HTTP ${response.status}: ${text}`,
      );
    }
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === 'AbortError'
    ) {
      throw new Error(
        `Discord PUT ${operation} timed out after ${DISCORD_CHANNEL_TIMEOUT_MS}ms.`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function setChannelTopic(
  channelId: string,
  topic: string,
  operation: string,
): Promise<void> {
  await discordChannelRequest(
    channelId,
    'PATCH',
    {
      topic,
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
      allow: permissionListToBitfield(
        overwrite.allow,
      ),
      deny: permissionListToBitfield(
        overwrite.deny,
      ),
    }));

  await discordChannelRequest(
    channelId,
    'PATCH',
    {
      permission_overwrites: payload,
    },
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
  await discordPermissionRequest(
    channelId,
    overwriteId,
    type,
    allow,
    deny,
    operation,
  );
}
