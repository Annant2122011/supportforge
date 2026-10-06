export type DomainEventType =
  | 'ticket.created'
  | 'ticket.status_changed'
  | 'ticket.metadata_changed'
  | 'ticket.deleted';

export type EventActorAttribution =
  | 'actorKnown'
  | 'actorInferred'
  | 'actorUnknown';

export type EventActorConfidence = 'high' | 'low' | 'none';

export interface DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  type: DomainEventType;
  aggregateType: 'ticket';
  aggregateId: string;
  guildId: string;
  channelId: string;
  actorId: string;
  actorAttribution: EventActorAttribution;
  actorConfidence: EventActorConfidence;
  payload: TPayload;
  occurredAt: string;
}

export interface TicketStatusChangedPayload {
  from: string;
  to: string;
}

export interface TicketMetadataChangedPayload {
  changedFields: string[];
}

export interface OutboxEvent {
  id: string;
  aggregateType: 'ticket';
  aggregateId: string;
  guildId: string;
  type: DomainEventType;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'published' | 'failed';
  attempts: number;
  availableAt: string;
  createdAt: string;
  processedAt: string | null;
  lastError: string | null;
}
