import { ChannelType, type Client, type Guild, type TextChannel } from 'discord.js';
import { getAdvancedSettings } from './advancedSettingsService';
import { getPersistedTicketStatus } from './ticketPersistenceService';
import { getField, getTicketStatus, isTicketTopic } from './ticketStateService';

let timer: NodeJS.Timeout | undefined;

async function sweepGuild(guild: Guild): Promise<void> {
  const settings = await getAdvancedSettings(guild.id);
  const now = Date.now();
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText || !isTicketTopic(channel.topic ?? '')) continue;
    const text = channel as TextChannel;
    const status = (await getPersistedTicketStatus(text.id)) ?? getTicketStatus(text.topic ?? '');
    const days = status === 'closed' ? settings.retention.closedDays : status === 'archived' ? settings.retention.archiveDays : 0;
    if (days <= 0) continue;
    const timestampField = status === 'closed' ? getField(text.topic ?? '', 'closed_at') : getField(text.topic ?? '', 'archived_at');
    if (!timestampField) continue;
    const timestamp = Date.parse(timestampField);
    if (!Number.isFinite(timestamp)) continue;
    if (now - timestamp < days * 86_400_000) continue;
    await text.delete('SupportForge automatic ticket retention cleanup').catch((error) => {
      console.warn('⚠️ Retention cleanup could not delete ' + text.id + ':', error);
    });
  }
}

export function startTicketRetentionScheduler(client: Client): void {
  if (timer) return;
  const run = async () => {
    for (const guild of client.guilds.cache.values()) {
      await sweepGuild(guild).catch((error) => console.warn('⚠️ Ticket retention sweep failed for ' + guild.id + ':', error));
    }
  };
  void run();
  timer = setInterval(() => { void run(); }, 60 * 60 * 1000);
}