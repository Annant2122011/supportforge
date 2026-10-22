# Stage F Part 2: Private-Thread Ticket Workspaces

## Scope

This increment adds private-thread workspaces to the existing ticket system without replacing the Neon/PostgreSQL persistence, repository, audit, ticket-state or support-hours layers. Workspace mode is configurable per server and affects newly created tickets only; existing text-channel tickets keep their current resource type.

## Configuration and resource layout

- Configure the mode from **Settings → Ticket Workspace** or `/supportforge settings ticket-workspace`.
- Modes are `text-channels` and `private-threads`; unknown persisted values normalize to the safer legacy `text-channels` mode.
- Private-thread parents are created lazily beneath the configured support category and tagged with a stable topic marker for reconciliation.
- A parent is maintained per department. The configured department staff role and the bot's role receive the permissions required for thread operations. The ticket owner's membership is explicitly added after thread creation.
- If adding the owner fails, thread creation is rolled back rather than leaving an inaccessible ticket behind.

## Lifecycle and controls

Lifecycle controls are validated against the durable ticket status before any transition. Supported actions are claim, unclaim, pending, resume, close, reopen and archive. Auxiliary staff controls include priority changes, internal notes, event history, participant addition/removal and reassignment. Controls carry the relevant thread ID and, for user-specific select/modal actions, the initiating user ID; stale or cross-thread submissions are rejected.

Unknown or future persisted status values return no lifecycle controls and fail closed. Private-thread interactions use the same persisted ticket state and audit/event services as the rest of the bot. Slash-command actions and button actions route to the same service functions.

## Support hours and persistence

Ticket intake uses the shared support-hours policy before and at final ticket creation. The workspace mode does not add a second database or separate source of truth. Ticket state and auxiliary metadata remain stored through the current Neon/PostgreSQL-backed persistence layer. Message/channel snapshots use the existing durable ticket archive services.

## Deletion and recovery

The Delete button requires two explicit confirmations. Before deleting, the service archives the durable ticket/message snapshot and logs the requested operation. If a thread is deleted accidentally, Settings → Repair System → Ticket Deletion Review is the recovery path. Restored content cannot preserve the original channel ID/URL or impersonate historical Discord authors; restored messages must preserve their original user/channel attribution as metadata.

## Permissions and operational acceptance

Before enabling this mode on a real server, verify the bot has the ability to view the support category/parent channels, create private threads, manage threads, send/read messages in threads, attach files and embed links. Each department must have a valid staff role and that role must have access through the parent workspace. Test the following on a non-production guild:

1. Create a ticket from each supported intake path and verify support-hours restrictions still apply.
2. Confirm the owner and only authorized staff/admins can read the private thread.
3. Exercise claim, unclaim, pending, resume, close, reopen and archive from both buttons and slash commands.
4. Verify add/remove participant, reassign, priority and internal-note controls, including stale interaction rejection.
5. Confirm message archival, two-confirmation deletion and the deletion-review recovery workflow.
6. Check command registration after deployment and inspect audit history for each lifecycle operation.

CI includes the TypeScript build, automated tests and PostgreSQL verification. CI cannot fully simulate the Discord permission model, so real test-guild acceptance is required before production rollout.
