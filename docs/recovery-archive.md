# Durable ticket archive and recovery

QueryFixr uses Neon PostgreSQL for ticket metadata, message history, channel snapshots, deletion-intent events and recovery state. Message attachments are copied into PostgreSQL BYTEA columns when they are accessible from Discord's CDN and fit the configured size limit.

## What is archived

- Every observed ticket message, including bot panel messages, author ID/name snapshot, text, original timestamp, embeds, component payloads, attachment metadata, edits and observed deletions.
- The ticket channel name/topic, parent details, position, NSFW/rate limit settings and permission-overwrite bitfields.
- Attachment bytes up to TICKET_ARCHIVE_MAX_ATTACHMENT_BYTES.
- Deletion source, confirmation stage, review answer and replacement channel ID.

A background backfill archives existing message history in pages of 100 and stores its cursor in Neon. The ticket-button deletion path completes the remaining backfill before requesting deletion. This is important: a channel deleted natively before its background backfill has reached old messages can only be restored with the content already archived.

## Delete flows

- Discord-native channel deletion is recorded as discord_native with intent unknown. It is listed only under Settings → Repair System → Restore Channel.
- Delete Ticket from inside a ticket requires two separate confirmations. QueryFixr durably records the button intent before calling Discord's delete endpoint. The deletion is listed only under Ticket Deletion Review.
- Ticket Deletion Review asks “Was this ticket deleted by mistake?” The Yes/No result and reviewer are stored in Neon and logged through both the ticket audit stream and developer/system audit stream.
- A ticket-button deletion can be restored only after the reviewer chooses Yes. A native deletion does not trigger this question.

Recovery attempts are durably marked as `restoring`, `failed`, or `restored`. The replacement channel ID is written back to Neon immediately after creation, and the recovery event ID is stored in the replacement channel topic so a restart can locate the channel even if the process stops between Discord creation and the database write. Completed archived-message replays are recorded in `ticket_recovery_replay_items`; retries reuse the same replacement channel and skip completed original messages rather than replaying the whole archive again. If an individual Discord send succeeds but the subsequent Neon ledger write fails, that one archived message may still be duplicated on retry because Discord sends and PostgreSQL commits cannot share one atomic transaction.

## Recovery limits

Discord does not restore deleted channel/message IDs, usernames as message authors, reactions or arbitrary live component state. Recovery creates a new private channel, rebuilds the supported ticket controls, replays archived messages in chronological order with an explicit recovery label and original author/channel/message IDs, and attaches saved files with their new Discord upload URLs. It never impersonates users. Original embeds are replayed where Discord accepts their saved payloads; expired external embed media cannot be guaranteed.

Attachment blobs increase Neon storage usage. Adjust TICKET_ARCHIVE_MAX_ATTACHMENT_BYTES only after reviewing database capacity and Discord upload limits. Files larger than the configured limit are recorded with metadata but their bytes are not claimed to be restorable. Back up Neon regularly and keep message retention compliant with your server's policies.
