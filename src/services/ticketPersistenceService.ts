import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TicketPriority } from './advancedSettingsService';
import type { TicketStatus } from './ticketStateService';

export interface PersistedTicket {
  guildId: string | null;
  status: TicketStatus;
  updatedAt: string;
  createdAt: string;
  ticketNumber: string | null;
  departmentId: string | null;
  tagId: string | null;
  ownerId: string | null;
  priority: TicketPriority | null;
  deletedAt: string | null;
  deletionReason: string | null;
}

interface TicketStateFile {
  version: 1;
  tickets: Record<string, PersistedTicket>;
}

const DATA_DIR = join(process.cwd(), 'data');
const TICKETS_PATH = join(DATA_DIR, 'tickets.json');
const TICKETS_BACKUP_PATH = join(DATA_DIR, 'tickets.backup.json');

let state: TicketStateFile | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function loadState(): Promise<TicketStateFile> {
  if (state) {
    return state;
  }

  await mkdir(DATA_DIR, { recursive: true });

  let raw: string | null = null;
  let primaryError: unknown = null;

  try {
    raw = await readFile(TICKETS_PATH, 'utf8');
  } catch (error) {
    primaryError = error;
  }

  if (raw === null) {
    try {
      raw = await readFile(TICKETS_BACKUP_PATH, 'utf8');
    } catch (backupError) {
      const primaryCode = (primaryError as NodeJS.ErrnoException | null)?.code;
      const backupCode = (backupError as NodeJS.ErrnoException).code;

      if (primaryCode !== 'ENOENT' || backupCode !== 'ENOENT') {
        throw new Error(
          'SupportForge ticket persistence could not be loaded safely. Existing state was not replaced.',
          { cause: primaryError ?? backupError },
        );
      }
    }
  }

  if (raw !== null) {
    let parsed: Partial<TicketStateFile>;

    try {
      parsed = JSON.parse(raw) as Partial<TicketStateFile>;
    } catch (error) {
      if (primaryError === null) {
        try {
          const backupRaw = await readFile(TICKETS_BACKUP_PATH, 'utf8');
          parsed = JSON.parse(backupRaw) as Partial<TicketStateFile>;
          raw = backupRaw;
        } catch (backupError) {
          throw new Error(
            'SupportForge ticket persistence contains invalid data and its backup could not be recovered.',
            { cause: backupError },
          );
        }
      } else {
        throw new Error(
          'SupportForge ticket persistence backup contains invalid data. Existing state was not replaced.',
          { cause: error },
        );
      }
    }

    const rawTickets = parsed.tickets ?? {};
    const normalizedTickets: Record<string, PersistedTicket> = {};

    for (const [channelId, ticket] of Object.entries(rawTickets)) {
      const legacy = ticket as Partial<PersistedTicket>;
      normalizedTickets[channelId] = {
        guildId: legacy.guildId ?? null,
        status: legacy.status ?? 'open',
        updatedAt: legacy.updatedAt ?? new Date().toISOString(),
        createdAt: legacy.createdAt ?? legacy.updatedAt ?? new Date().toISOString(),
        ticketNumber: legacy.ticketNumber ?? null,
        departmentId: legacy.departmentId ?? null,
        tagId: legacy.tagId ?? null,
        ownerId: legacy.ownerId ?? null,
        priority: legacy.priority ?? null,
        deletedAt: legacy.deletedAt ?? null,
        deletionReason: legacy.deletionReason ?? null,
      };
    }

    state = {
      version: 1,
      tickets: normalizedTickets,
    };

    return state;
  }

  state = {
    version: 1,
    tickets: {},
  };

  await persistState();

  return state;
}

async function persistState(): Promise<void> {
  if (!state) {
    return;
  }

  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    await mkdir(DATA_DIR, { recursive: true });

    const serialized = JSON.stringify(state, null, 2);
    const temporaryPath =
      TICKETS_PATH + '.tmp-' + process.pid + '-' + Date.now();

    await writeFile(
      temporaryPath,
      serialized,
      'utf8',
    );

    try {
      try {
        await copyFile(
          TICKETS_PATH,
          TICKETS_BACKUP_PATH,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw error;
        }
      }

      /*
       * Swap the fully written temporary file into place. The previous
       * generation remains available as tickets.backup.json, so a crash or
       * malformed write does not require inventing ticket state.
       */
      await rename(
        temporaryPath,
        TICKETS_PATH,
      );
    } finally {
      try {
        await rename(
          temporaryPath,
          temporaryPath + '.abandoned',
        );
      } catch {
        // The temporary file was normally consumed by the atomic rename.
      }
    }
  });

  await writeQueue;
}

export async function getPersistedTicketStatus(
  channelId: string,
): Promise<TicketStatus | undefined> {
  const current = await loadState();
  return current.tickets[channelId]?.status;
}

export async function getPersistedTicketPriority(
  channelId: string,
): Promise<TicketPriority | undefined> {
  const current = await loadState();
  return current.tickets[channelId]?.priority ?? undefined;
}

export interface TicketRegistration {
  guildId: string;
  ticketNumber: string;
  departmentId: string;
  tagId: string;
  ownerId: string;
  priority: TicketPriority;
  createdAt: string;
}

export async function registerTicket(
  channelId: string,
  registration: TicketRegistration,
): Promise<void> {
  const current = await loadState();
  const existing = current.tickets[channelId];

  current.tickets[channelId] = {
    guildId: existing?.guildId ?? registration.guildId,
    status: existing?.status ?? 'open',
    updatedAt: registration.createdAt,
    createdAt: existing?.createdAt ?? registration.createdAt,
    ticketNumber: existing?.ticketNumber ?? registration.ticketNumber,
    departmentId: existing?.departmentId ?? registration.departmentId,
    tagId: existing?.tagId ?? registration.tagId,
    ownerId: existing?.ownerId ?? registration.ownerId,
    priority: existing?.priority ?? registration.priority,
    deletedAt: existing?.deletedAt ?? null,
    deletionReason: existing?.deletionReason ?? null,
  };

  await persistState();
}

export async function setPersistedTicketStatus(
  channelId: string,
  status: TicketStatus,
): Promise<void> {
  const current = await loadState();
  const existing = current.tickets[channelId];
  const now = new Date().toISOString();

  current.tickets[channelId] = {
    guildId: existing?.guildId ?? null,
    status,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
    ticketNumber: existing?.ticketNumber ?? null,
    departmentId: existing?.departmentId ?? null,
    tagId: existing?.tagId ?? null,
    ownerId: existing?.ownerId ?? null,
    priority: existing?.priority ?? null,
    deletedAt: existing?.deletedAt ?? null,
    deletionReason: existing?.deletionReason ?? null,
  };

  await persistState();
}
export async function updatePersistedTicketMetadata(
  channelId: string,
  updates: Partial<
    Pick<
      PersistedTicket,
      'departmentId' | 'tagId' | 'ownerId' | 'priority'
    >
  >,
): Promise<void> {
  const current = await loadState();
  const existing = current.tickets[channelId];
  const now = new Date().toISOString();

  current.tickets[channelId] = {
    guildId: existing?.guildId ?? null,
    status: existing?.status ?? 'open',
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
    ticketNumber: existing?.ticketNumber ?? null,
    departmentId:
      updates.departmentId ?? existing?.departmentId ?? null,
    tagId:
      updates.tagId ?? existing?.tagId ?? null,
    ownerId:
      updates.ownerId ?? existing?.ownerId ?? null,
    priority:
      updates.priority ?? existing?.priority ?? null,
    deletedAt: existing?.deletedAt ?? null,
    deletionReason: existing?.deletionReason ?? null,
  };

  await persistState();
}


export async function getPersistedTicketRecords(guildId?: string): Promise<PersistedTicket[]> {
  const current = await loadState();
  return Object.values(current.tickets)
    .filter((ticket) => !guildId || ticket.guildId === guildId)
    .map((ticket) => ({ ...ticket }));
}

export async function markPersistedTicketDeleted(
  channelId: string,
  reason: string,
): Promise<void> {
  const current = await loadState();
  const existing = current.tickets[channelId];
  if (!existing) return;

  current.tickets[channelId] = {
    ...existing,
    deletedAt: new Date().toISOString(),
    deletionReason: reason,
  };

  await persistState();
}

export async function removePersistedTicket(
  channelId: string,
): Promise<void> {
  const current = await loadState();

  if (!(channelId in current.tickets)) {
    return;
  }

  delete current.tickets[channelId];
  await persistState();
}

export async function resetTicketPersistenceState(): Promise<void> {
  await writeQueue.catch(() => undefined);
  state = null;
  writeQueue = Promise.resolve();
}
