import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { getGuildConfig } from './configService';
import { getAdvancedSettings, updateAdvancedSettings, buildSettingsSummary } from './advancedSettingsService';

const SETTINGS_TOPIC_PREFIX = 'supportforge:settings';

export async function ensureSettingsChannel(guild: Guild, parentId: string): Promise<TextChannel> {
  const settings = await getAdvancedSettings(guild.id);
  const bot = guild.members.me;
  if (!bot) throw new Error('SupportForge bot member could not be resolved.');

  if (settings.settingsChannelId) {
    const saved = guild.channels.cache.get(settings.settingsChannelId);
    if (saved?.type === ChannelType.GuildText) return saved;
  }

  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildText && channel.topic?.startsWith(SETTINGS_TOPIC_PREFIX),
  );
  const channel = existing?.type === ChannelType.GuildText
    ? existing
    : await guild.channels.create({
        name: 'supportforge-settings',
        type: ChannelType.GuildText,
        parent: parentId,
        topic: SETTINGS_TOPIC_PREFIX + ' guild=' + guild.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: bot.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] },
        ],
      });

  for (const department of Object.values((await getGuildConfig(guild.id)).departments)) {
    if (!department.staffRoleId) continue;
    await channel.permissionOverwrites.edit(department.staffRoleId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
    }).catch(() => undefined);
  }

  await updateAdvancedSettings(guild.id, (current) => {
    current.settingsChannelId = channel.id;
  });

  const currentSettings = await getAdvancedSettings(guild.id);
  const embed = new EmbedBuilder()
    .setTitle('⚙️ SupportForge Settings')
    .setDescription(
      'This channel is the administrative control center for SupportForge.\n\n' +
      'Use the slash commands below to configure panel movement, closed/archive retention, and custom slash commands. ' +
      'The ticket conversation itself remains focused on support.',
    )
    .addFields({
      name: '🎛️ Panel positioning',
      value: 'The panel uses a visual-occupancy heuristic rather than raw character count. Short one-line messages count as one visual unit; long messages, line breaks, attachments and embeds count more.',
    }, {
      name: '🗄️ Storage',
      value: 'Closed tickets are placed in Closed storage. Explicitly archived tickets are placed in Archive storage. Billing departments use the dedicated Billing section.',
    }, {
      name: '🧹 Retention',
      value: 'Closed and archived deletion periods are configurable. `0` means never delete.',
    }, {
      name: '🧩 Custom commands',
      value: 'Administrators can register server-specific slash commands with `/supportforge settings custom-add`. Discord exposes application commands through the `/` command picker.',
    }, {
      name: '📋 Current configuration',
      value: buildSettingsSummary(currentSettings).slice(0, 1024),
    })
    .setFooter({ text: 'SupportForge • Advanced Ticket Configuration' })
    .setTimestamp();

  const recent = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  const dashboard = recent?.find((message) => message.author.id === guild.client.user?.id && message.embeds.some((item) => item.title === '⚙️ SupportForge Settings'));
  if (dashboard) await dashboard.edit({ embeds: [embed] });
  else await channel.send({ embeds: [embed] });

  return channel;
}

export async function refreshSettingsChannel(guild: Guild): Promise<void> {
  const settings = await getAdvancedSettings(guild.id);
  if (!settings.settingsChannelId) return;
  const channel = guild.channels.cache.get(settings.settingsChannelId);
  if (channel?.type !== ChannelType.GuildText) return;
  const currentSettings = await getAdvancedSettings(guild.id);
  const recent = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  const dashboard = recent?.find((message) => message.author.id === guild.client.user?.id && message.embeds.some((item) => item.title === '⚙️ SupportForge Settings'));
  if (!dashboard) return;
  const embed = EmbedBuilder.from(dashboard.embeds[0]);
  const fieldIndex = embed.data.fields?.findIndex((field) => field.name === '📋 Current configuration') ?? -1;
  if (fieldIndex >= 0 && embed.data.fields) embed.data.fields[fieldIndex].value = buildSettingsSummary(currentSettings).slice(0, 1024);
  await dashboard.edit({ embeds: [embed] });
}