import { ChannelType, type Message, type TextChannel } from 'discord.js';
import { getAdvancedSettings } from './advancedSettingsService';
import { getField } from './ticketStateService';
import { moveTicketPanelToBottom } from './ticketPanelService';

interface ActivityState { anchorMessageId: string; messages: number; visualLines: number; moving: boolean; }
const states = new Map<string, ActivityState>();
function estimateVisualLines(message: Message): number {
  const content = message.content ?? '';
  const explicitLines = Math.max(1, content.split(/\r?\n/).length);
  const wrappedLines = Math.ceil(content.length / 70);
  let score = Math.max(explicitLines, wrappedLines, 1);
  if (message.attachments.size > 0) score += Math.min(6, message.attachments.size * 3);
  if (message.embeds.length > 0) score += Math.min(4, message.embeds.length * 2);
  if (message.stickers.size > 0) score += Math.min(4, message.stickers.size * 2);
  if (message.reference) score += 1;
  return Math.min(10, score);
}
export function resetPanelActivity(channelId: string, anchorMessageId: string): void { states.set(channelId, { anchorMessageId, messages: 0, visualLines: 0, moving: false }); }
export async function recordTicketMessageForPanel(message: Message): Promise<void> {
  if (!message.guild || message.author.bot || message.channel.type !== ChannelType.GuildText) return;
  const channel = message.channel as TextChannel; const topic = channel.topic ?? ''; const panelMessageId = getField(topic, 'message');
  if (!topic.startsWith('supportforge:ticket') || !panelMessageId) return;
  const settings = await getAdvancedSettings(message.guild.id); if (!settings.panelActivity.enabled) return;
  let state = states.get(channel.id);
  if (!state || state.anchorMessageId !== panelMessageId) {
    state = { anchorMessageId: panelMessageId, messages: 0, visualLines: 0, moving: false };
    try {
      const recent = await channel.messages.fetch({ limit: 50 }); const anchor = recent.get(panelMessageId);
      if (anchor) for (const item of recent.values()) if (item.id !== panelMessageId && item.createdTimestamp > anchor.createdTimestamp && !item.author.bot) { state.messages += 1; state.visualLines += estimateVisualLines(item); }
    } catch { /* Establish baseline from new messages if history cannot be read. */ }
    states.set(channel.id, state);
  }
  state.messages += 1; state.visualLines += estimateVisualLines(message);
  const reachedVisualBudget = state.visualLines >= settings.panelActivity.visualLineBudget;
  const reachedMessageBudget = state.messages >= settings.panelActivity.messageBudget && state.messages >= settings.panelActivity.minimumMessagesBeforeMove;
  if (!reachedVisualBudget && !reachedMessageBudget) return; if (state.moving) return; state.moving = true;
  try { await moveTicketPanelToBottom(channel); resetPanelActivity(channel.id, channel.lastMessageId ?? panelMessageId); }
  catch (error) { console.warn('⚠️ Automatic ticket panel repositioning skipped in ' + channel.id + ':', error); }
  finally { const current = states.get(channel.id); if (current) current.moving = false; }
}