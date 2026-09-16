import {
  AttachmentBuilder,
  type Embed,
  type Message,
  type TextChannel,
} from 'discord.js';

const MAX_MESSAGES = 10000;
const PAGE_SIZE = 100;

/* -------------------------------------------------------------------------- */
/*                              HTML UTILITIES                                */
/* -------------------------------------------------------------------------- */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(date: Date): string {
  return escapeHtml(
    date.toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }),
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 'Unknown size';
  }

  const units = ['B', 'KB', 'MB', 'GB'];

  let value = bytes;
  let index = 0;

  while (
    value >= 1024 &&
    index < units.length - 1
  ) {
    value /= 1024;
    index++;
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatContent(content: string): string {
  return escapeHtml(content)
    .replace(/\r?\n/g, '<br>');
}

/* -------------------------------------------------------------------------- */
/*                              AUTHOR HELPERS                                */
/* -------------------------------------------------------------------------- */

function getAuthorName(
  message: Message,
): string {
  return (
    message.member?.displayName ??
    message.author.globalName ??
    message.author.username
  );
}

function getAvatarUrl(
  message: Message,
): string {
  return (
    message.author.displayAvatarURL({
      extension: 'png',
      size: 128,
    }) ??
    ''
  );
}

/* -------------------------------------------------------------------------- */
/*                              EMBED RENDERING                               */
/* -------------------------------------------------------------------------- */

function renderEmbed(
  embed: Embed,
): string {
  const parts: string[] = [];

  if (embed.title) {
    const title = embed.url
      ? `<a href="${escapeHtml(
          embed.url,
        )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          embed.title,
        )}</a>`
      : escapeHtml(embed.title);

    parts.push(
      `<div class="embed-title">${title}</div>`,
    );
  }

  if (embed.description) {
    parts.push(
      `<div class="embed-description">${formatContent(
        embed.description,
      )}</div>`,
    );
  }

  if (embed.fields?.length) {
    parts.push(
      `<div class="embed-fields">${embed.fields
        .map(
          (field) => `
            <div class="embed-field">
              <div class="embed-field-name">
                ${escapeHtml(field.name)}
              </div>
              <div class="embed-field-value">
                ${formatContent(field.value)}
              </div>
            </div>
          `,
        )
        .join('')}</div>`,
    );
  }

  if (embed.image?.url) {
    parts.push(`
      <div class="embed-image">
        <img
          src="${escapeHtml(embed.image.url)}"
          alt="Embedded image"
          loading="lazy"
        />
      </div>
    `);
  }

  if (embed.thumbnail?.url) {
    parts.push(`
      <div class="embed-thumbnail">
        <img
          src="${escapeHtml(embed.thumbnail.url)}"
          alt="Embed thumbnail"
          loading="lazy"
        />
      </div>
    `);
  }

  if (embed.footer?.text) {
    parts.push(`
      <div class="embed-footer">
        ${escapeHtml(embed.footer.text)}
      </div>
    `);
  }

  if (!parts.length) {
    return '';
  }

  return `
    <div class="discord-embed">
      ${parts.join('\n')}
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/*                           ATTACHMENT RENDERING                             */
/* -------------------------------------------------------------------------- */

function renderAttachments(
  message: Message,
): string {
  if (!message.attachments.size) {
    return '';
  }

  return `
    <div class="attachments">
      ${Array.from(
        message.attachments.values(),
      )
        .map((attachment) => {
          const name =
            attachment.name ??
            'Attachment';

          const size = formatBytes(
            attachment.size,
          );

          const isImage =
            attachment.contentType?.startsWith(
              'image/',
            ) ?? false;

          if (isImage) {
            return `
              <div class="attachment image-attachment">
                <a
                  href="${escapeHtml(
                    attachment.url,
                  )}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img
                    src="${escapeHtml(
                      attachment.url,
                    )}"
                    alt="${escapeHtml(name)}"
                    loading="lazy"
                  />
                </a>

                <div class="attachment-info">
                  📎
                  <a
                    href="${escapeHtml(
                      attachment.url,
                    )}"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    ${escapeHtml(name)}
                  </a>

                  <span>${escapeHtml(size)}</span>
                </div>
              </div>
            `;
          }

          return `
            <div class="attachment">
              <span class="attachment-icon">📎</span>

              <a
                href="${escapeHtml(
                  attachment.url,
                )}"
                target="_blank"
                rel="noopener noreferrer"
              >
                ${escapeHtml(name)}
              </a>

              <span class="attachment-size">
                ${escapeHtml(size)}
              </span>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/*                             STICKER RENDERING                              */
/* -------------------------------------------------------------------------- */

function renderStickers(
  message: Message,
): string {
  if (!message.stickers.size) {
    return '';
  }

  return `
    <div class="stickers">
      ${Array.from(
        message.stickers.values(),
      )
        .map(
          (sticker) => `
            <div class="sticker">
              <span>🎟️</span>
              ${escapeHtml(
                sticker.name,
              )}
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/*                              REPLY RENDERING                               */
/* -------------------------------------------------------------------------- */

function renderReference(
  message: Message,
): string {
  const reference =
    message.reference;

  if (!reference?.messageId) {
    return '';
  }

  return `
    <div class="reply-reference">
      ↪️ Reply / reference to message
      <code>${escapeHtml(
        reference.messageId,
      )}</code>
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/*                              MESSAGE LINKS                                */
/* -------------------------------------------------------------------------- */

function renderMessageLink(
  message: Message,
): string {
  return `
    <a
      class="message-link"
      href="${escapeHtml(
        message.url,
      )}"
      target="_blank"
      rel="noopener noreferrer"
      title="Open message in Discord"
    >
      #
    </a>
  `;
}

/* -------------------------------------------------------------------------- */
/*                              MESSAGE BODY                                  */
/* -------------------------------------------------------------------------- */

function renderMessage(
  message: Message,
): string {
  const author =
    escapeHtml(
      getAuthorName(message),
    );

  const avatar =
    escapeHtml(
      getAvatarUrl(message),
    );

  const timestamp =
    formatDate(
      message.createdAt,
    );

  const content =
    formatContent(
      message.content || '',
    );

  const edited =
    message.editedTimestamp
      ? `<span class="edited">(edited)</span>`
      : '';

  const botBadge =
    message.author.bot
      ? `<span class="bot-badge">BOT</span>`
      : '';

  const systemBadge =
    message.system
      ? `<span class="system-badge">SYSTEM</span>`
      : '';

  const reference =
    renderReference(
      message,
    );

  const attachments =
    renderAttachments(
      message,
    );

  const embeds =
    message.embeds
      .map(renderEmbed)
      .join('');

  const stickers =
    renderStickers(
      message,
    );

  const messageLink =
    renderMessageLink(
      message,
    );

  const contentBlock =
    content
      ? `
        <div class="message-content">
          ${content}
          ${edited}
        </div>
      `
      : '';

  return `
    <article
      class="message"
      id="message-${escapeHtml(
        message.id,
      )}"
    >

      <img
        class="avatar"
        src="${avatar}"
        alt="${author}"
        loading="lazy"
      />

      <div class="message-main">

        <div class="message-header">

          <strong class="author">
            ${author}
          </strong>

          ${botBadge}
          ${systemBadge}

          <span class="timestamp">
            ${timestamp}
          </span>

          ${messageLink}

        </div>

        ${reference}

        ${contentBlock}

        ${attachments}

        ${embeds}

        ${stickers}

      </div>

    </article>
  `;
}

/* -------------------------------------------------------------------------- */
/*                         MESSAGE FETCHING                                   */
/* -------------------------------------------------------------------------- */

async function fetchMessages(
  channel: TextChannel,
): Promise<{
  messages: Message[];
  limited: boolean;
}> {
  const result: Message[] = [];

  let before:
    | string
    | undefined;

  let page = 0;

  while (
    result.length <
    MAX_MESSAGES
  ) {
    page++;

    const remaining =
      MAX_MESSAGES -
      result.length;

    const limit = Math.min(
      PAGE_SIZE,
      remaining,
    );

    const batch =
      await channel.messages.fetch({
        limit,
        ...(before
          ? { before }
          : {}),
      });

    if (batch.size === 0) {
      break;
    }

    result.push(
      ...batch.values(),
    );

    if (
      batch.size <
      PAGE_SIZE
    ) {
      break;
    }

    const oldest =
      batch.last();

    if (!oldest) {
      break;
    }

    before =
      oldest.id;

    /*
     * Avoid accidentally looping forever if Discord returns
     * an unexpected duplicate page.
     */
    if (
      result.length >=
      2 * PAGE_SIZE
    ) {
      const ids =
        new Set(
          result.map(
            (message) =>
              message.id,
          ),
        );

      if (
        ids.size !==
        result.length
      ) {
        console.warn(
          '⚠️ Duplicate message IDs detected while generating transcript.',
        );

        break;
      }
    }

    /*
     * This gives the console useful progress on large tickets.
     */
    if (
      page % 10 ===
      0
    ) {
      console.log(
        `📚 Transcript fetch progress: ${result.length}/${MAX_MESSAGES}`,
      );
    }
  }

  /*
   * Discord returns newest → oldest.
   * Transcripts should be oldest → newest.
   */
  result.sort(
    (a, b) =>
      a.createdTimestamp -
      b.createdTimestamp,
  );

  return {
    messages: result,
    limited:
      result.length >=
      MAX_MESSAGES,
  };
}

/* -------------------------------------------------------------------------- */
/*                            MAIN TRANSCRIPT                                 */
/* -------------------------------------------------------------------------- */

export async function generateTranscript(
  options: {
    channel: TextChannel;
    ticketNumber: string;
    subject: string;
    ownerId: string;
    ownerName: string;
    closedBy: string;
    openedAt: Date;
    closedAt: Date;
  },
): Promise<AttachmentBuilder> {
  console.log(
    `📄 Transcript generation started for ticket #${options.ticketNumber}`,
  );

  console.time(
    `TRANSCRIPT_TOTAL_${options.ticketNumber}`,
  );

  const {
    messages,
    limited,
  } =
    await fetchMessages(
      options.channel,
    );

  console.log(
    `📚 Transcript collected ${messages.length} messages for ticket #${options.ticketNumber}`,
  );

  const body =
    messages
      .map(
        renderMessage,
      )
      .join('\n');

  const warning =
    limited
      ? `
        <div class="warning">
          ⚠️ This transcript reached the
          ${MAX_MESSAGES.toLocaleString()}
          message safety limit.
          Older messages may not be included.
        </div>
      `
      : '';

  const html = `<!doctype html>
<html lang="en">
<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
/>

<meta
  name="description"
  content="SupportForge ticket transcript #${escapeHtml(
    options.ticketNumber,
  )}"
/>

<title>
  SupportForge Ticket #${escapeHtml(
    options.ticketNumber,
  )}
</title>

<style>

:root {
  color-scheme: light;
  --background: #f5f7fb;
  --surface: #ffffff;
  --surface-soft: #f7f8fa;
  --border: #e5e7eb;
  --text: #1f2937;
  --muted: #6b7280;
  --accent: #5865f2;
  --accent-soft: #eef0ff;
  --warning: #fff3cd;
  --warning-border: #f0c36d;
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  padding: 24px;
  background: var(--background);
  color: var(--text);
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Arial,
    sans-serif;
  line-height: 1.5;
}

.container {
  width: min(1100px, 100%);
  margin: 0 auto;
  background: var(--surface);
  border-radius: 18px;
  overflow: hidden;
  box-shadow:
    0 10px 40px rgba(0, 0, 0, 0.08);
}

.header {
  padding: 28px;
  background:
    linear-gradient(
      135deg,
      #5865f2,
      #4752c4
    );
  color: white;
}

.header h1 {
  margin: 0 0 8px;
  font-size: 28px;
}

.header-subtitle {
  opacity: 0.9;
}

.summary {
  padding: 24px;
  display: grid;
  grid-template-columns:
    repeat(
      auto-fit,
      minmax(220px, 1fr)
    );
  gap: 12px;
}

.card {
  padding: 16px;
  background: var(--surface-soft);
  border: 1px solid var(--border);
  border-radius: 12px;
}

.card-label {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 5px;
}

.card-value {
  font-size: 14px;
  word-break: break-word;
}

.warning {
  margin:
    0 24px
    20px;
  padding: 14px 16px;
  background: var(--warning);
  border:
    1px solid
    var(--warning-border);
  border-radius: 12px;
}

.messages {
  padding: 8px 24px 30px;
}

.message {
  display: flex;
  gap: 12px;
  padding: 15px 0;
  border-bottom:
    1px solid
    var(--border);
}

.message:last-child {
  border-bottom: 0;
}

.avatar {
  width: 42px;
  height: 42px;
  min-width: 42px;
  border-radius: 50%;
  object-fit: cover;
  background: #ddd;
}

.message-main {
  min-width: 0;
  flex: 1;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.author {
  font-size: 15px;
}

.timestamp {
  color: var(--muted);
  font-size: 12px;
}

.edited {
  color: var(--muted);
  font-size: 11px;
  margin-left: 5px;
}

.bot-badge,
.system-badge {
  display: inline-block;
  padding: 2px 5px;
  border-radius: 4px;
  font-size: 9px;
  font-weight: 800;
  color: white;
  background: var(--accent);
}

.system-badge {
  background: #777;
}

.message-link {
  margin-left: auto;
  color: var(--muted);
  text-decoration: none;
  font-size: 16px;
}

.message-link:hover {
  color: var(--accent);
}

.message-content {
  margin-top: 5px;
  white-space: normal;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}

.reply-reference {
  margin-top: 7px;
  padding:
    6px 9px;
  border-left:
    3px solid
    var(--accent);
  background:
    var(--accent-soft);
  color: var(--muted);
  font-size: 12px;
  border-radius: 4px;
}

.attachments {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}

.attachment {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border:
    1px solid
    var(--border);
  border-radius: 8px;
  background:
    var(--surface-soft);
}

.attachment a {
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
}

.attachment a:hover {
  text-decoration: underline;
}

.attachment-size {
  color: var(--muted);
  font-size: 11px;
}

.image-attachment {
  display: block;
}

.image-attachment img {
  display: block;
  max-width: min(600px, 100%);
  max-height: 500px;
  border-radius: 8px;
  margin-bottom: 8px;
  object-fit: contain;
}

.attachment-info {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.discord-embed {
  max-width: 650px;
  margin-top: 10px;
  padding: 12px 14px;
  border-left:
    4px solid
    var(--accent);
  border-radius: 6px;
  background:
    #f7f8fb;
}

.embed-title {
  font-weight: 700;
  margin-bottom: 5px;
}

.embed-title a {
  color: var(--accent);
  text-decoration: none;
}

.embed-description {
  margin-top: 4px;
}

.embed-fields {
  display: grid;
  grid-template-columns:
    repeat(
      auto-fit,
      minmax(180px, 1fr)
    );
  gap: 8px;
  margin-top: 10px;
}

.embed-field {
  padding: 8px;
  background: white;
  border-radius: 6px;
}

.embed-field-name {
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 3px;
}

.embed-field-value {
  font-size: 13px;
  color: #444;
}

.embed-image img {
  max-width: 100%;
  max-height: 500px;
  margin-top: 10px;
  border-radius: 8px;
}

.embed-thumbnail img {
  max-width: 160px;
  max-height: 160px;
  margin-top: 10px;
  border-radius: 8px;
}

.embed-footer {
  margin-top: 10px;
  padding-top: 8px;
  border-top:
    1px solid
    var(--border);
  color: var(--muted);
  font-size: 11px;
}

.stickers {
  margin-top: 10px;
}

.sticker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border:
    1px solid
    var(--border);
  border-radius: 8px;
  background:
    var(--surface-soft);
  font-size: 13px;
}

.footer {
  padding: 20px 24px;
  border-top:
    1px solid
    var(--border);
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

code {
  padding:
    2px 4px;
  background:
    #e5e7eb;
  border-radius: 4px;
  font-family:
    Consolas,
    Monaco,
    monospace;
  font-size: 11px;
}

@media (
  max-width: 650px
) {

  body {
    padding: 0;
  }

  .container {
    border-radius: 0;
  }

  .header {
    padding: 22px;
  }

  .summary {
    padding: 16px;
  }

  .messages {
    padding:
      8px
      16px
      24px;
  }

  .message {
    gap: 8px;
  }

  .avatar {
    width: 36px;
    height: 36px;
    min-width: 36px;
  }

}

</style>

</head>

<body>

<div class="container">

  <header class="header">

    <h1>
      🎫 SupportForge Ticket #${escapeHtml(
        options.ticketNumber,
      )}
    </h1>

    <div class="header-subtitle">
      Complete support conversation transcript
    </div>

  </header>

  <section class="summary">

    <div class="card">
      <div class="card-label">
        Subject
      </div>

      <div class="card-value">
        ${escapeHtml(
          options.subject,
        )}
      </div>
    </div>

    <div class="card">
      <div class="card-label">
        Owner
      </div>

      <div class="card-value">
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

    <div class="card">
      <div class="card-label">
        Opened
      </div>

      <div class="card-value">
        ${formatDate(
          options.openedAt,
        )}
      </div>
    </div>

    <div class="card">
      <div class="card-label">
        Closed
      </div>

      <div class="card-value">
        ${formatDate(
          options.closedAt,
        )}
        <br>
        by ${escapeHtml(
          options.closedBy,
        )}
      </div>
    </div>

    <div class="card">
      <div class="card-label">
        Messages
      </div>

      <div class="card-value">
        ${messages.length.toLocaleString()}
        ${
          limited
            ? '+'
            : ''
        }
      </div>
    </div>

    <div class="card">
      <div class="card-label">
        Generated
      </div>

      <div class="card-value">
        ${formatDate(
          new Date(),
        )}
      </div>
    </div>

  </section>

  ${warning}

  <main class="messages">

    ${
      body ||
      '<p>No messages were found in this ticket.</p>'
    }

  </main>

  <footer class="footer">
    Generated by
    <strong>
      SupportForge
    </strong>
    · Advanced Discord Support System
  </footer>

</div>

</body>
</html>`;

  const attachment =
    new AttachmentBuilder(
      Buffer.from(
        html,
        'utf8',
      ),
      {
        name:
          `ticket-${options.ticketNumber}-transcript.html`,
      },
    );

  console.timeEnd(
    `TRANSCRIPT_TOTAL_${options.ticketNumber}`,
  );

  console.log(
    `✅ Transcript generated for ticket #${options.ticketNumber} (${messages.length} messages)`
  );

  return attachment;
}