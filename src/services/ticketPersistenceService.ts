import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TicketStatus } from './ticketStateService';

interface PersistedTicket {
  status: TicketStatus;
  updatedAt: string;
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

    state = {
      version: 1,
      tickets: parsed.tickets ?? {},
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

export async function setPersistedTicketStatus(
  channelId: string,
  status: TicketStatus,
): Promise<void> {
  const current = await loadState();

  current.tickets[channelId] = {
    status,
    updatedAt: new Date().toISOString(),
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
