# Stage L — SLA, Escalation and Queue Operations

**Status:** implementation candidate in PR #43; automated and live acceptance gates remain open  
**Implementation PR:** [#43 — Stage L: durable QueryFixr SLA, queue and escalation operations](https://github.com/Annant2122011/supportforge/pull/43)  
**Depends on:** the Stage 3 recovery/SLA foundation in PR #34 and the consolidated Stage A–K candidate in PR #39  
**Persistence:** Neon PostgreSQL remains authoritative. New schema changes must be forward-only and must not renumber existing migration IDs.  
**Non-goal:** no AI requirement, arbitrary executable workflows, or implicit destructive reassignment.

## 1. Why Stage L exists

PR #34 supplies the foundation: persistent guild/department/priority policy selection, first-response and resolution clocks, pending pause, reopen-aware resolution cycles, a bounded monitor, de-duplicated warning/breach records, metrics and CSAT storage. The current early integration adds a separately configurable claim clock. These primitives are necessary, but not the complete SLA/queue product.

Stage L turns the foundation into an operationally configurable and measurable system. It must not duplicate the Stage 3 engine or represent unverified events as completed work.

## 2. Part 1 — reliable SLA clocks and business-time calculation

### Policy model

- Versioned, guild-scoped policies with optional department and priority overrides; use deterministic precedence: exact department + priority, department-only, priority-only, then guild-wide.
- Three explicit targets: first human response, first staff claim, and resolution.
- Warning threshold and pending-pause policy are independently defined. Policy edits create a new version and cannot mutate the meaning of already-recorded alert history.
- Optional working-hours mode reuses the existing support-hours/time-zone primitives rather than creating a competing calendar engine. Elapsed wall-clock and elapsed business-time must be visibly distinguished.
- The first implementation excludes holiday calendars and one-off closure exceptions unless they are explicitly added as a separate, tested extension.

### Clock semantics

- First response is the earliest trustworthy non-bot support reply after ticket creation, excluding the ticket owner's own messages. Missing archived history is reported as incomplete rather than guessed.
- Claim is completed by a durable claim/status-transition event. A current `claimed` status or a channel-topic timestamp alone is not enough to fabricate historical SLA success.
- Resolution completes on a durable close/archive event in the current lifecycle cycle. Reopen starts a new resolution cycle; previous cycles remain available for audit.
- Pending pause/resume uses persisted lifecycle-event timestamps and a documented per-clock policy. Invalid timestamps or missing event attribution fail safe and are visible in data-coverage diagnostics.
- Boundary behavior is fixed and tested: warning threshold, exact deadline, post-deadline breach, policy version change, duplicate events, out-of-order events, pending transitions, reopening, and restart.

### Durable scheduling and alert delivery

- The monitor evaluates bounded batches and persists its cursor/lease so a restart cannot endlessly restart from the same first page or skip records.
- Alert intents are persisted before Discord delivery in the SLA-specific durable queue (`support_sla_alerts`). This queue is intentionally separate from the ticket-materialization outbox because SLA notifications target a configured guild channel rather than mutating ticket-channel state. Delivery retries use bounded backoff, receipt markers reconcile ambiguous Discord/database outcomes, and a worker failure must be visible as failed rather than silently healthy.
- De-duplication keys include guild, ticket, policy ID/version, target, lifecycle cycle and severity. Retrying delivery must not create a second logical alert.
- Notifications are configurable and explicit: assigned staff, supervisor role, department manager and/or designated channel. Defaults are non-destructive.
- Every warning, breach, policy edit, acknowledgement and escalation attempt is audit-recorded with actor attribution and outcome.

## 3. Part 2 — queues, escalation and reporting

### Queue operations

- Add durable queue snapshots based on open/claimed/pending/reopened state, age, priority, department and assignment; show the oldest/highest-risk tickets without treating staff workload as an automatic performance ranking.
- Provide a read-only escalation preview before enabling notification or reassignment rules.
- Escalation actions are allowlisted and re-check current ticket state, permissions, exclusions and policy version immediately before execution. Automatic priority changes or reassignment require explicit admin opt-in.
- Prevent escalation loops with policy versioning, per-ticket lifecycle cycle markers, bounded attempts and cooldowns.
- Reuse Stage K analytics filters/pagination and add SLA coverage/compliance only where authoritative SLA cycles and delivery outcomes support those values.

### Interaction parity

- Settings dashboard and slash commands use the same validated service methods for policy list/create/update/deactivate, evaluation, queue views, escalation preview, acknowledgement and metrics.
- Mutations are administrator-gated, guild-scoped, confirmed where destructive, audited and protected against stale previews.
- Translated user-facing strings must use the existing strict English/Hindi/Bengali catalogs. Stable command names, IDs, user-provided copy and audit identifiers remain unchanged.

## 4. Data and migration contract

- Keep Neon/PostgreSQL as the source of truth.
- Use new migration IDs after the current consolidated schema; never renumber existing migrations or duplicate the claim-SLA migration.
- Persist policy versions, clock/cycle provenance, missing-data indicators, alert intent, delivery receipt, acknowledgement, escalation attempt and monitor progress.
- Keep schema constraints and partial indexes aligned with the bounded scan/query patterns.
- Database verification must execute the actual SLA policy selection, clock history, cursor/lease, idempotent alert intent and delivery-reconciliation SQL paths against disposable PostgreSQL.
- A production/real-data restore is not substituted by schema smoke tests.

## 5. Verification matrix

### Automated checks

1. Unit tests for first-response, claim and resolution clocks; pending pauses; reopen cycles; wall-clock versus business-time; DST gaps/repeats; invalid/missing history; threshold boundaries; deterministic scope precedence.
2. PostgreSQL integration tests for versioned policy writes, migration upgrades from the existing Stage A–K schema, cross-guild isolation, cursor rotation, concurrent monitors, alert uniqueness and outbox reconciliation.
3. Failure-injection tests for database loss, Discord 429/retry-after, lost permissions, alert delivery succeeding before receipt persistence, restart during warning/breach and policy edits during an active evaluation.
4. Command schema/registration tests, permission tests, localization catalog/placeholder parity and Settings/slash-command service parity.
5. Exact-head CI must pass after the final base is refreshed.

### Controlled Discord acceptance

- Create a disposable test guild, test guild-wide and override policies, then verify each clock from real ticket events.
- Verify Pending/resume/reopen boundaries, role and channel permissions, repeated delivery, supervisor routing, disabled policies, and stale confirmation rejection.
- Verify no customer message or transcript is exposed to analytics or unauthorized staff.

### Isolated Neon restore drill

Restore a verified backup into a newly created empty non-production Neon branch/database. Record the checksum, migration level, core row counts, foreign-key/orphan checks, policy/clock/alert/outbox counts and an application smoke test. Never run this drill against the production database.

## 6. Exit criteria

Stage L is code-complete only when the integrated branch, migrations, exact-head CI, and the full automated matrix pass. It is release-ready only after the controlled Discord acceptance and isolated Neon restore drill are recorded independently.

The PR #34/#39 claim-SLA extension was the early foundation. PR #43 adds the Stage L operational layer, but it is not considered complete or release-ready until its exact-head CI, controlled Discord acceptance and isolated non-production Neon restore drill are recorded.
