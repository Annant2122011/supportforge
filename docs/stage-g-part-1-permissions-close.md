# Stage G Part 1: Permission and Close-Lifecycle Hardening

## Scope split

- **Part 1 (this increment):** shared lifecycle authorization, read-only ACL reconciliation for closed/archived text tickets, durable outbox repair for private-thread tickets, and close/reopen ordering that never unlocks a closed thread before durable reopening commits.
- **Part 2 (deferred):** inactivity policies, warning/grace periods and restart-safe automated closure. Part 1 adds no inactivity timer or auto-close behavior.

## Authorization model

`src/core/domain/ticketAuthorization.ts` is the shared, testable policy used by text-channel lifecycle actions and private-thread lifecycle actions. Configured department staff and elevated managers can perform ticket-management transitions. A ticket owner may close their own active ticket or resume their own pending ticket; ownership does not grant claim, reassignment, archive or delete privileges. Deletion requires ticket staff or elevated channel-management permission. Durable status-transition validation remains separate from authorization.

## Closed-ticket access

Closed and archived text tickets receive one-PATCH channel reconciliation that:
- keeps `@everyone` from viewing, sending or reading history;
- grants the configured department staff role read-only access;
- grants the ticket owner and saved participants/claimants read-only access;
- removes unrelated per-ticket role/member overwrites that could leave other users in the ticket;
- preserves an explicit bot overwrite so transcript, panel, audit and repair operations continue.

Reopening restores active-ticket ACLs using the current claim state. Button transitions, slash-command metadata changes and durable outbox retries use the same ACL planner, so restart paths converge on the same read-only permissions.

## Private-thread closure and recovery

Private-thread lifecycle actions persist the status change before unlocking/unarchiving a previously closed thread. Closing and archiving both archive and lock the thread; reopening/resuming commits durable state first, then unlocks/unarchives. The durable ticket outbox recognizes private threads as supported resources and retries thread lock/archive and panel synchronization instead of classifying them as deleted text channels.

If durable status commits but a Discord mutation fails, the interaction reports that synchronization is pending rather than claiming all external effects succeeded.

## Verification and scope boundary

Unit tests cover authorization boundaries and the closed ACL plan. CI must pass the TypeScript build, tests and PostgreSQL verification. Real Discord test-guild acceptance remains necessary for overwrite and thread-permission behavior.

Inactivity warnings, schedules and automated closure are reserved for Stage G Part 2.
