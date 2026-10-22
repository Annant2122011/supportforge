# Stage G Part 2: Restart-Safe Ticket Inactivity Automation

## Scope

This stage adds per-server inactivity warnings and automatic closure for durable QueryFixr tickets. It does not change ticket creation, support-hour admission, retention approvals, or the Stage G Part 1 permission policy.

## Configuration

The feature is **disabled by default**. An administrator can configure it from either the Settings dashboard's **Inactivity Automation** button or the slash-command fallback:

- `/qf settings inactivity action:show`
- `/qf settings inactivity action:enable`
- `/qf settings inactivity action:disable`
- `/qf settings inactivity action:configure idle-hours:72 grace-hours:24`
- `/qf settings inactivity action:set-exempt-roles exempt-roles:ROLE_ID_1,ROLE_ID_2`
- `/qf settings inactivity action:set-exempt-departments exempt-departments:billing,returns`
- `/qf settings inactivity action:clear-exemptions`

The Settings dashboard offers the same role and department controls: choose zero or more roles in the role selector, and edit the comma-separated list of configured department IDs through the department modal. Up to 25 roles and 25 department IDs are retained. A configured role exempts tickets whose owner or assigned staff member has that role; a configured department exempts all tickets in that department. All settings changes invalidate old policy-generation warning markers and clear outstanding warning/grace state. Idle threshold is bounded to 1–720 hours; grace is bounded to 1–168 hours. Defaults, when enabled explicitly, are a 72-hour idle threshold followed by a 24-hour grace period.

## Runtime design

- A single scheduler starts after Discord client readiness and sweeps durable PostgreSQL ticket records every five minutes. Timers are not stored in memory as source of truth.
- Activity baseline is the durable `metadata.lastActivityAt`, falling back to `updatedAt` and then `createdAt` for older tickets.
- Before sending a warning, after generating/uploading a transcript, and immediately before close, the scheduler checks recent Discord human messages against the activity anchor. The full due-action sweep scans up to 1,000 history entries; if it cannot establish that the anchor is covered, it pauses instead of guessing.
- Critical-priority tickets and tickets with durable `vip`, `activeEscalation`, or `inactivityExempt` markers are exempt. Administrators can also exempt roles and departments from the Settings dashboard or slash-command fallback. If Discord membership lookup fails while configured role exemptions must be evaluated, the sweep fails safe and does not auto-close that ticket during the current pass.
- The warning message contains a deterministic ticket/activity/policy-generation marker. If the process stops after Discord sends the warning but before PostgreSQL stores its message ID, the next sweep tries to recover that warning instead of sending another. Discord and PostgreSQL cannot share one atomic transaction, so recovery minimizes but cannot mathematically eliminate every duplicate-send window.
- The warning creation time and configured grace period determine the persisted deadline. New ticket activity changes the baseline and invalidates the old warning/deadline.
- Before closure, QueryFixr must find or create a transcript in the configured transcript channel. A deterministic transcript marker lets a restart reuse a transcript already uploaded before a process interruption.
- The final status transition uses a PostgreSQL row lock and compares the expected activity anchor in the same transaction that records the lifecycle event and outbox work. If a reply or other ticket update wins the race, the stale auto-close is rejected.
- Once the durable close commits, the existing outbox reconciles text-channel permissions, channel organization, and private-thread locking/archival. A direct private-thread sync is attempted as well; failures remain retryable through the outbox.
- Closed, archived, deleted, malformed, unsupported, or unexpectedly locked private-thread tickets are not auto-closed. Missing transcript configuration/permissions also fails safely without changing ticket status.
- Disabling the feature clears pending warning/grace metadata. Existing ticket data and history are retained.

## Operational acceptance checklist

Use a test guild before enabling this in a production server:

1. Configure a short idle threshold and a grace period, then verify exactly one warning appears and its visible deadline matches the configured grace.
2. Reply after the warning. The ticket must remain active and the previous grace period must not close it.
3. Restart the bot during the grace period. The existing warning and deadline must be recovered without duplicates.
4. Remove transcript-channel access. Automatic closure must pause and leave the ticket active.
5. Restore transcript access. The transcript must be saved before the ticket becomes closed.
6. Test both text-channel and private-thread tickets, including an auto-archived thread, a deliberately locked thread, and a ticket whose channel has been deleted.
7. Disable automation during a grace period and verify that the ticket stays active.
8. Confirm the outbox applies the Stage G Part 1 closed-ticket read-only ACL or private-thread lock after closure.

This stage does not claim live-guild acceptance: Discord permissions, transcript-channel access, interaction behavior, and rate limits require verification in the deployment's own test guild.
