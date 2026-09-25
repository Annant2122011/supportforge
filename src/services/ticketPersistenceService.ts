import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

let state: TicketStateFile | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function loadState(): Promise<TicketStateFile> {
  if (state) {
    return state;
  }

  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(TICKETS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TicketStateFile>;

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
  } catch {
    state = {
      version: 1,
      tickets: {},
    };

    await persistState();
  }

  return state;
}

async function persistState(): Promise<void> {
  if (!state) {
    return;
  }

  writeQueue = writeQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(
      TICKETS_PATH,
      JSON.stringify(state, null, 2),
      'utf8',
    );
  });

  await writeQueue;
}

export async function getPersistedTicketStatus(
  channelId: string,
): Promise<TicketStatus | undefined> {
  const current = await loadState();
  return current.tickets[channelId]?.status;
}

export interface TicketRegistration {
  guildId: string;
  ticketNumber: string;
  departmentId: string;
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
    ownerId: existing?.ownerId ?? null,
    priority: existing?.priority ?? null,
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
