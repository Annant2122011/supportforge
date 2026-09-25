import {
  ChannelType,
  EmbedBuilder,
  type Guild,
  type TextChannel,
} from 'discord.js';

const PURPOSE_TITLE = '📝 SupportForge Channel Purpose';
const PURPOSE_FOOTER = 'SupportForge • Channel Purpose';

export type SupportForgeChannelPurpose =
  | 'settings'
  | 'audit'
  | 'transcript'
  | 'managed';

const purposeQueues = new Map<string, Promise<void>>();

const DEFAULT_PURPOSES: Record<
  SupportForgeChannelPurpose,
  string
> = {
  settings:
    'This private channel is SupportForge’s administrative control center. Use the buttons here to configure tickets, departments, tags, retention, appearance, storage, rules, roles, repairs, and other server-level SupportForge settings.',
  audit:
    'This private channel stores SupportForge’s durable operational audit history. It records important ticket lifecycle actions, configuration changes, retention decisions, repairs, and other administrative events with responsible users and timestamps.',
  transcript:
    'This private channel is the SupportForge transcript archive. Closed ticket conversations are exported here as HTML transcripts for staff records, review, and historical reference.',
  managed:
    'This is a SupportForge-managed channel reserved for the subsystem that created it. Its SupportForge metadata defines its operational purpose. Keep unrelated conversations out of this channel.',
};

export function getDefaultChannelPurpose(
  purpose: SupportForgeChannelPurpose,
): string {
  return DEFAULT_PURPOSES[purpose];
}

export function getChannelPurposeFromTopic(
  topic: string | null | undefined,
): SupportForgeChannelPurpose | null {
  if (!topic?.startsWith('supportforge:')) {
    return null;
  }

  if (topic.startsWith('supportforge:panel')) {
    return null;
  }

  if (topic.startsWith('supportforge:ticket')) {
    return null;
  }

  if (topic.startsWith('supportforge:settings')) {
    return 'settings';
  }

  if (topic.startsWith('supportforge:audit')) {
    return 'audit';
  }

  if (topic.startsWith('supportforge:transcript')) {
    return 'transcript';
  }

  return 'managed';
}

export async function ensureChannelPurposeMessage(
  channel: TextChannel,
  description?: string,
): Promise<void> {
  const purpose = description?.trim();

  if (!purpose) {
    return;
  }

  const previous =
    purposeQueues.get(channel.id) ??
    Promise.resolve();

  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const current = previous.then(() => gate);
  purposeQueues.set(channel.id, current);

  await previous;

  try {
    const botId = channel.client.user?.id;
    if (!botId) {
      return;
    }

    const recent = await channel.messages
      .fetch({ limit: 50 })
      .catch(() => null);

    const existing = recent?.find(
      (message) =>
        message.author.id === botId &&
        message.embeds.some(
          (embed) =>
            embed.title === PURPOSE_TITLE &&
            embed.footer?.text === PURPOSE_FOOTER,
        ),
    );

    const embed = new EmbedBuilder()
      .setTitle(PURPOSE_TITLE)
      .setDescription(purpose)
      .setFooter({ text: PURPOSE_FOOTER })
      .setTimestamp();

    if (existing) {
      await existing.edit({ embeds: [embed] });
      return;
    }

    await channel.send({
      embeds: [embed],
    });
  } finally {
    release();

    if (purposeQueues.get(channel.id) === current) {
      purposeQueues.delete(channel.id);
    }
  }
}

export async function ensureDefaultChannelPurpose(
  channel: TextChannel,
): Promise<void> {
  const topic = channel.topic ?? '';

  if (
    topic.startsWith('supportforge:panel') ||
    topic.startsWith('supportforge:ticket')
  ) {
    return;
  }

  const purpose =
    getChannelPurposeFromTopic(topic) ??
    'managed';

  await ensureChannelPurposeMessage(
    channel,
    getDefaultChannelPurpose(purpose),
  );
}

export async function ensureSupportForgeCategoryPurposeMessages(
  guild: Guild,
  categoryId: string,
): Promise<void> {
  const category = guild.channels.cache.get(categoryId);

  if (!category || category.type !== ChannelType.GuildCategory) {
    return;
  }

  for (const child of category.children.cache.values()) {
    if (child.type !== ChannelType.GuildText) {
      continue;
    }

    const topic = child.topic ?? '';

    if (
      topic.startsWith('supportforge:panel') ||
      topic.startsWith('supportforge:ticket')
    ) {
      continue;
    }

    await ensureDefaultChannelPurpose(child);
  }
}
