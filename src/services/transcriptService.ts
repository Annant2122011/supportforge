import {
  AttachmentBuilder,
  type Message,
  type TextChannel,
} from 'discord.js';

const MAX_MESSAGES = 1000;
const FETCH_BATCH_SIZE = 100;

function escapeHtml(value: string): string {
  return String(value)
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

/**
 * Fetch messages in chronological order.
 *
 * Discord returns messages newest-first.
 * We paginate backwards using the oldest message ID
 * from the previous batch.
 *
 * The function is deliberately limited to MAX_MESSAGES
 * so a giant ticket cannot make transcript generation
 * run indefinitely.
 */
async function fetchAllMessages(
  channel: TextChannel,
): Promise<{
  messages: Message[];
  limited: boolean;
}> {
  const messages: Message[] = [];

  let before: string | undefined;

  while (messages.length < MAX_MESSAGES) {
    const remaining =
      MAX_MESSAGES - messages.length;

    const limit = Math.min(
      FETCH_BATCH_SIZE,
      remaining,
    );

    let batch;

    try {
      batch = await channel.messages.fetch({
        limit,
        ...(before
          ? { before }
          : {}),
      });
    } catch (error) {
      console.error(
        `❌ Failed to fetch transcript messages from #${channel.name}:`,
        error,
      );

      throw new Error(
        'Discord message history could not be fetched.',
      );
    }

    if (batch.size === 0) {
      break;
    }

    messages.push(
      ...batch.values(),
    );

    if (
      batch.size < FETCH_BATCH_SIZE
    ) {
      break;
    }

    const oldest =
      batch.last();

    if (!oldest) {
      break;
    }

    before = oldest.id;
  }

  messages.sort(
    (a, b) =>
      a.createdTimestamp -
      b.createdTimestamp,
  );

  return {
    messages,
    limited:
      messages.length >=
      MAX_MESSAGES,
  };
}

/**
 * Safely renders one Discord message.
 *
 * A malformed/unusual message should never cause
 * the entire transcript generation process to fail.
 */
function renderMessage(
  message: Message,
): string {
  const authorName =
    escapeHtml(
      message.member?.displayName ??
        message.author.username,
    );

  const username =
    escapeHtml(
      message.author.username,
    );

  const avatarUrl =
    escapeHtml(
      message.author.displayAvatarURL({
        extension: 'png',
        size: 128,
      }),
    );

  const timestamp =
    formatDate(
      message.createdAt,
    );

  const content =
    message.content
      ? escapeHtml(
          message.content,
        ).replace(
          /\r?\n/g,
          '<br>',
        )
      : '';

  const attachments =
    Array.from(
      message.attachments.values(),
    )
      .map(
        (attachment) => {
          const attachmentName =
            escapeHtml(
              attachment.name ??
                'Attachment',
            );

          const attachmentUrl =
            escapeHtml(
              attachment.url,
            );

          return `
            <div class="attachment">
              <span class="attachment-icon">📎</span>

              <a
                href="${attachmentUrl}"
                target="_blank"
                rel="noopener noreferrer"
              >
                ${attachmentName}
              </a>
            </div>
          `;
        },
      )
      .join('');

  const embeds =
    message.embeds
      .map((embed) => {
        const title =
          embed.title
            ? `
                <div class="embed-title">
                  ${escapeHtml(
                    embed.title,
                  )}
                </div>
              `
            : '';

        const description =
          embed.description
            ? `
                <div class="embed-description">
                  ${escapeHtml(
                    embed.description,
                  ).replace(
                    /\r?\n/g,
                    '<br>',
                  )}
                </div>
              `
            : '';

        return `
          <div class="embed">
            ${title}
            ${description}
          </div>
        `;
      })
      .join('');

  const stickers =
    message.stickers.size > 0
      ? `
          <div class="stickers">
            🎨 Sticker:
            ${escapeHtml(
              Array.from(
                message.stickers.values(),
              )
                .map(
                  (sticker) =>
                    sticker.name,
                )
                .join(', '),
            )}
          </div>
        `
      : '';

  return `
    <div class="message">
      <img
        class="avatar"
        src="${avatarUrl}"
        alt=""
        loading="lazy"
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
            ? `
                <div class="content">
                  ${content}
                </div>
              `
            : ''
        }

        ${attachments}

        ${embeds}

        ${stickers}

      </div>
    </div>
  `;
}

/**
 * Renders a message safely.
 *
 * If one message somehow fails to render, the transcript
 * continues instead of failing completely.
 */
function safelyRenderMessage(
  message: Message,
): string {
  try {
    return renderMessage(
      message,
    );
  } catch (error) {
    console.error(
      `⚠️ Failed to render message ${message.id}:`,
      error,
    );

    return `
      <div class="message">
        <div class="message-body">
          <div class="message-header">
            <span class="author">
              Unable to render message
            </span>
          </div>

          <div class="content">
            ⚠️ This message could not be rendered.
          </div>
        </div>
      </div>
    `;
  }
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
  console.log(
    `📄 Starting transcript generation for ticket #${options.ticketNumber}...`,
  );

  const {
    messages: fetchedMessages,
    limited,
  } = await fetchAllMessages(
    options.channel,
  );

  /**
   * Only include messages that existed at or before
   * the exact moment the ticket was closed.
   *
   * This prevents:
   *
   * - post-close admin messages
   * - transcript confirmation messages
   * - other bot messages sent after closing
   *
   * from appearing in the actual conversation transcript.
   */
  const messages =
    fetchedMessages.filter(
      (message) =>
        message.createdTimestamp <=
        options.closedAt.getTime(),
    );

  console.log(
    `📄 Fetched ${fetchedMessages.length} messages; ` +
      `including ${messages.length} messages in ticket #${options.ticketNumber}.`,
  );

  if (limited) {
    console.warn(
      `⚠️ Transcript for ticket #${options.ticketNumber} reached the ${MAX_MESSAGES}-message safety limit.`,
    );
  }

  const renderedMessages =
    messages
      .map(
        safelyRenderMessage,
      )
      .join('\n');

  const messageCountText =
    limited
      ? `${messages.length} (most recent ${MAX_MESSAGES})`
      : `${messages.length}`;

  const messageContent =
    renderedMessages ||
    `
      <div class="empty">
        No messages were found in this ticket.
      </div>
    `;

  const limitNotice =
    limited
      ? `
        <div class="limit-warning">
          ⚠️ This transcript is limited to the
          most recent ${MAX_MESSAGES} messages.
        </div>
      `
      : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>

  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

  <meta
    name="robots"
    content="noindex,nofollow"
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
      width: 100%;
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
        0 2px 8px rgba(
          0,
          0,
          0,
          0.08
        );
    }

    .header h1 {
      margin: 0 0 8px;
      font-size: 28px;
      line-height: 1.25;
    }

    .subtitle {
      color: #666;
      margin-bottom: 20px;
    }

    .metadata {
      display: grid;
      grid-template-columns:
        repeat(
          auto-fit,
          minmax(
            220px,
            1fr
          )
        );
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
      letter-spacing: 0.04em;
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
        0 2px 8px rgba(
          0,
          0,
          0,
          0.08
        );
    }

    .limit-warning {
      background: #fff3cd;
      border: 1px solid #ffe69c;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 16px;
      color: #664d03;
      font-size: 14px;
    }

    .message {
      display: flex;
      gap: 12px;
      padding: 14px 8px;
      border-bottom:
        1px solid #eeeeee;
    }

    .message:last-child {
      border-bottom: none;
    }

    .avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      flex-shrink: 0;
      object-fit: cover;
      background: #ddd;
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
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .attachment {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      padding: 8px 10px;
      background: #f4f5f7;
      border-radius: 6px;
      font-size: 14px;
      word-break: break-word;
    }

    .attachment-icon {
      flex-shrink: 0;
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

    .embed-title {
      font-weight: bold;
      margin-bottom: 4px;
    }

    .embed-description {
      line-height: 1.5;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .stickers {
      margin-top: 8px;
      padding: 8px 10px;
      background: #f4f5f7;
      border-radius: 6px;
      font-size: 14px;
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
      padding-bottom: 20px;
    }

    @media (max-width: 600px) {

      .container {
        margin: 20px auto;
        padding: 0 10px;
      }

      .header {
        padding: 20px;
      }

      .header h1 {
        font-size: 22px;
      }

      .transcript {
        padding: 10px;
      }

      .message {
        padding: 12px 4px;
      }

      .avatar {
        width: 36px;
        height: 36px;
      }

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
            ${escapeHtml(
              options.subject,
            )}
          </div>

        </div>

        <div class="metadata-item">

          <div class="metadata-label">
            Ticket Owner
          </div>

          <div class="metadata-value">
            ${escapeHtml(
              options.ownerName,
            )}
            <br>
            <small>
              ${escapeHtml(
                options.ownerId,
              )}
            </small>
          </div>

        </div>

        <div class="metadata-item">

          <div class="metadata-label">
            Opened
          </div>

          <div class="metadata-value">
            ${escapeHtml(
              formatDate(
                options.openedAt,
              ),
            )}
          </div>

        </div>

        <div class="metadata-item">

          <div class="metadata-label">
            Closed
          </div>

          <div class="metadata-value">
            ${escapeHtml(
              formatDate(
                options.closedAt,
              ),
            )}
          </div>

        </div>

        <div class="metadata-item">

          <div class="metadata-label">
            Closed By
          </div>

          <div class="metadata-value">
            ${escapeHtml(
              options.closedBy,
            )}
          </div>

        </div>

        <div class="metadata-item">

          <div class="metadata-label">
            Messages
          </div>

          <div class="metadata-value">
            ${escapeHtml(
              messageCountText,
            )}
          </div>

        </div>

      </div>

    </div>

    <div class="transcript">

      ${limitNotice}

      ${messageContent}

    </div>

    <div class="footer">
      Generated by SupportForge
    </div>

  </div>

</body>
</html>`;

  const buffer =
    Buffer.from(
      html,
      'utf-8',
    );

  console.log(
    `✅ Transcript generated for ticket #${options.ticketNumber} (${buffer.length} bytes).`,
  );

  return new AttachmentBuilder(
    buffer,
    {
      name:
        `ticket-${options.ticketNumber}-transcript.html`,
    },
  );
}