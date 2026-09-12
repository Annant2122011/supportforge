import {
  AttachmentBuilder,
  type Message,
  type TextChannel,
} from 'discord.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(date: Date): string {
  return date.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

async function fetchAllMessages(
  channel: TextChannel,
): Promise<Message[]> {
  const messages: Message[] = [];

  // Safety limit so an ancient/huge ticket cannot make closing
  // take forever.
  const MAX_MESSAGES = 1000;

  let before: string | undefined;

  while (messages.length < MAX_MESSAGES) {
    const remaining = MAX_MESSAGES - messages.length;

    const batch = await channel.messages.fetch({
      limit: Math.min(100, remaining),
      ...(before ? { before } : {}),
    });

    if (batch.size === 0) {
      break;
    }

    messages.push(...batch.values());

    if (batch.size < 100 || messages.length >= MAX_MESSAGES) {
      break;
    }

    const oldest = batch.last();

    if (!oldest) {
      break;
    }

    before = oldest.id;
  }

  return messages.sort(
    (a, b) =>
      a.createdTimestamp - b.createdTimestamp,
  );
}
function renderMessage(message: Message): string {
  const authorName = escapeHtml(
    message.member?.displayName ??
      message.author.displayName ??
      message.author.username,
  );

  const username = escapeHtml(
    message.author.username,
  );

  const avatarUrl = escapeHtml(
    message.author.displayAvatarURL({
      extension: 'png',
      size: 128,
    }),
  );

  const timestamp = formatDate(
    message.createdAt,
  );

  const content = message.content
    ? escapeHtml(message.content).replace(
        /\n/g,
        '<br>',
      )
    : '';

  const attachments = Array.from(
    message.attachments.values(),
  )
    .map(
      (attachment) => `
        <div class="attachment">
          📎
          <a
            href="${escapeHtml(attachment.url)}"
            target="_blank"
            rel="noopener noreferrer"
          >
            ${escapeHtml(attachment.name ?? 'Attachment')}
          </a>
        </div>
      `,
    )
    .join('');

  const embeds = message.embeds
    .map((embed) => {
      const title = embed.title
        ? `<strong>${escapeHtml(embed.title)}</strong>`
        : '';

      const description = embed.description
        ? `<div>${escapeHtml(embed.description)}</div>`
        : '';

      return `
        <div class="embed">
          ${title}
          ${description}
        </div>
      `;
    })
    .join('');

  return `
    <div class="message">
      <img
        class="avatar"
        src="${avatarUrl}"
        alt=""
      />

      <div class="message-body">
        <div class="message-header">
          <span class="author">
            ${authorName}
          </span>

          <span class="username">
            @${username}
          </span>

          <span class="timestamp">
            ${escapeHtml(timestamp)}
          </span>
        </div>

        ${
          content
            ? `<div class="content">${content}</div>`
            : ''
        }

        ${attachments}
        ${embeds}
      </div>
    </div>
  `;
}

export interface TranscriptOptions {
  channel: TextChannel;
  ticketNumber: string;
  subject: string;
  ownerId: string;
  ownerName: string;
  closedBy: string;
  openedAt: Date;
  closedAt: Date;
}

export async function generateTranscript(
  options: TranscriptOptions,
): Promise<AttachmentBuilder> {
  const messages = await fetchAllMessages(
    options.channel,
  );
  const transcriptWasLimited =
  messages.length >= 1000;

  const renderedMessages = messages
    .map(renderMessage)
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

  <title>
    SupportForge Ticket #${escapeHtml(
      options.ticketNumber,
    )}
  </title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 0;
      background: #f4f5f7;
      color: #202225;
      font-family:
        Arial,
        Helvetica,
        sans-serif;
    }

    .container {
      max-width: 1000px;
      margin: 40px auto;
      padding: 0 20px;
    }

    .header {
      background: #ffffff;
      border-radius: 12px;
      padding: 28px;
      margin-bottom: 20px;
      box-shadow:
        0 2px 8px rgba(0, 0, 0, 0.08);
    }

    .header h1 {
      margin: 0 0 8px;
      font-size: 28px;
    }

    .header .subtitle {
      color: #666;
      margin-bottom: 20px;
    }

    .metadata {
      display: grid;
      grid-template-columns:
        repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }

    .metadata-item {
      background: #f7f7f8;
      border-radius: 8px;
      padding: 12px;
    }

    .metadata-label {
      font-size: 11px;
      text-transform: uppercase;
      color: #777;
      margin-bottom: 4px;
      font-weight: bold;
    }

    .metadata-value {
      font-size: 14px;
      word-break: break-word;
    }

    .transcript {
      background: #ffffff;
      border-radius: 12px;
      padding: 20px;
      box-shadow:
        0 2px 8px rgba(0, 0, 0, 0.08);
    }

    .message {
      display: flex;
      gap: 12px;
      padding: 14px 8px;
      border-bottom: 1px solid #eeeeee;
    }

    .message:last-child {
      border-bottom: none;
    }

    .avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .message-body {
      min-width: 0;
      flex: 1;
    }

    .message-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 5px;
    }

    .author {
      font-weight: bold;
    }

    .username {
      color: #777;
      font-size: 13px;
    }

    .timestamp {
      color: #999;
      font-size: 12px;
    }

    .content {
      line-height: 1.5;
      word-wrap: break-word;
    }

    .attachment {
      margin-top: 8px;
      padding: 8px 10px;
      background: #f4f5f7;
      border-radius: 6px;
      font-size: 14px;
    }

    .attachment a {
      color: #5865f2;
      text-decoration: none;
    }

    .attachment a:hover {
      text-decoration: underline;
    }

    .embed {
      margin-top: 8px;
      padding: 10px 12px;
      border-left: 4px solid #5865f2;
      background: #f4f5f7;
      border-radius: 4px;
    }

    .empty {
      text-align: center;
      color: #777;
      padding: 40px;
    }

    .footer {
      text-align: center;
      color: #888;
      font-size: 12px;
      margin-top: 20px;
    }
  </style>
</head>

<body>
  <div class="container">

    <div class="header">
      <h1>
        🎫 SupportForge Ticket #${escapeHtml(
          options.ticketNumber,
        )}
      </h1>

      <div class="subtitle">
        Ticket Transcript
      </div>

      <div class="metadata">

        <div class="metadata-item">
          <div class="metadata-label">
            Subject
          </div>

          <div class="metadata-value">
            ${escapeHtml(options.subject)}
          </div>
        </div>

        <div class="metadata-item">
          <div class="metadata-label">
            Ticket Owner
          </div>

          <div class="metadata-value">
            ${escapeHtml(options.ownerName)}
            (${escapeHtml(options.ownerId)})
          </div>
        </div>

        <div class="metadata-item">
          <div class="metadata-label">
            Opened
          </div>

          <div class="metadata-value">
            ${escapeHtml(
              formatDate(options.openedAt),
            )}
          </div>
        </div>

        <div class="metadata-item">
          <div class="metadata-label">
            Closed
          </div>

          <div class="metadata-value">
            ${escapeHtml(
              formatDate(options.closedAt),
            )}
          </div>
        </div>

        <div class="metadata-item">
          <div class="metadata-label">
            Closed By
          </div>

          <div class="metadata-value">
            ${escapeHtml(options.closedBy)}
          </div>
        </div>

        <div class="metadata-item">
          <div class="metadata-label">
            Messages
          </div>

          <div class="metadata-value">
            ${messages.length}
          </div>
        </div>

      </div>
    </div>

  <div class="transcript">
  ${
    transcriptWasLimited
      ? `
        <div class="empty">
          ⚠️ This transcript contains the most recent
          1000 messages from the ticket.
        </div>
      `
      : ''
  }

  ${
    renderedMessages ||
    `
      <div class="empty">
        No messages were found in this ticket.
      </div>
    `
  }
</div>

    <div class="footer">
      Generated by SupportForge
    </div>

  </div>
</body>
</html>`;

  const buffer = Buffer.from(html, 'utf-8');

  return new AttachmentBuilder(
    buffer,
    {
      name:
        `ticket-${options.ticketNumber}-transcript.html`,
    },
  );
}