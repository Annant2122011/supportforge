# Stage K — Operational analytics architecture

**Status:** Part 1 implementation in progress  
**Implementation branch:** stage-k-part-1-analytics-foundation  
**Scope:** Discord-first operational metrics backed by the existing Neon/PostgreSQL source of truth.

## Goals and boundaries

Stage K turns persisted ticket lifecycle and message metadata into actionable operational reporting. Metrics are descriptive signals, not simplistic staff rankings. A lower ticket count can mean complex cases, not poor performance.

The feature must not introduce another database, infer state from channel names or Discord permissions, fabricate missing measurements, add AI dependencies, or place SQL/business logic directly inside the large ticket-interaction handler. The existing ticket store and durable ticket_events ledger remain authoritative.

## Part 1 — Metric foundation and guild overview

Part 1 delivers:

1. A bounded PostgreSQL aggregation repository with parameterized SQL and guild isolation applied to every query.
2. A service that validates supported rolling reporting windows (7, 30 or 90 days) and normalizes the calculation boundaries to exact UTC timestamps.
3. A shared Discord embed intended for both the slash-command and Settings-dashboard entry points.
4. Initial guild-level metrics:
   - tickets created during the selected window;
   - current active backlog, split into open/reopened, claimed and pending;
   - current urgent/critical active tickets and age of the oldest active ticket;
   - first closures during the window and all close actions during the window;
   - distinct tickets reopened during the window;
   - average first response for the report's newly-created ticket cohort, with an explicit sample/eligibility count;
   - average time to first closure for tickets first closed in the window;
   - a defined reopen rate for the first-closure cohort.
5. Automated tests for aggregation-row normalization, rolling UTC boundaries, parameter binding, null samples, invalid inputs and zero-denominator behavior.
6. An additive database migration for analytics query indexes; existing migrations and production data are not rewritten.

## Part 2 — Operational breakdowns and exports

Part 2 is deliberately separate so the initial reporting foundation stays reviewable. It will add:

- department volume, backlog, first-response and resolution breakdowns;
- staff workload/assignment views with explicit attribution and guardrails against misleading leaderboards;
- time-series summaries and current-versus-previous-period comparisons;
- bounded, permission-checked CSV export with spreadsheet-formula neutralization;
- validated filters for department, status, priority and tag;
- data-coverage diagnostics and privacy-conscious analytics retention;
- SLA compliance only after an authoritative SLA policy/event source is implemented;
- CSAT reporting only after ratings have a durable, auditable source.

Part 2 must not fabricate SLA compliance or customer satisfaction values before those source systems exist.

## Metric definitions

| Metric | Definition | Caveat |
|---|---|---|
| Tickets created | Non-deleted ticket records whose created_at falls in the selected UTC window | Durable ticket records only |
| Active backlog | Current, non-deleted tickets in open, claimed, pending or reopened | Current snapshot, not a period total |
| Close actions | ticket.closed events in the selected window | Can exceed unique tickets after reopen and re-close |
| First resolved | Distinct tickets whose earliest persisted ticket.closed event falls in the window | Tickets with no durable close event are not guessed into the count |
| First response | Average elapsed time from the first recorded customer message to the first later, explicitly attributed staff message, for tickets created in the window | Unknown author types are excluded; sample and eligibility counts must be visible |
| Resolution time | Average from ticket creation to its earliest persisted close event, among tickets first closed in the window | Includes tickets created before the selected window |
| Reopened tickets | Distinct tickets with a ticket.reopened event in the window | Counts tickets, not every repeated reopen action |
| Reopen rate | Tickets in the first-closure cohort that have an observed later reopen before the report window ends, divided by first-resolved tickets in that window | Not available when denominator is zero |

All report periods are rolling windows of 7 × 24, 30 × 24 or 90 × 24 hours ending at report generation time. The report prints the exact UTC boundaries; it does not silently switch to local midnight or daylight-saving-dependent windows.

## Data correctness and security rules

- Guild ID is a bound SQL parameter, never interpolated into SQL.
- Every live-ticket aggregate filters to the guild and excludes records with deleted_at set.
- Current backlog is computed from persisted status, not Discord channel permissions.
- Message-event aggregation uses only ticket.message.received payloads whose messageAuthorType is exactly customer or staff. Unknown or missing attribution is not guessed.
- First response is measured from the original message timestamps recorded in event payloads, not from the later database-write time, and starts at the customer's first recorded message rather than ticket creation. This metric uses only tickets created within the selected window; events without a valid source timestamp are excluded.
- First-resolution uses the earliest durable close event per ticket, preventing a later re-close from double-counting a ticket as newly resolved.
- SQL is aggregate-only; it does not read or return message bodies, attachment URLs, or transcript contents.
- The Settings dashboard and slash command must independently enforce Manage Server or Administrator authorization.
- Empty duration samples are rendered as unavailable, not zero minutes. A zero is reserved for a measured count or quantity.
- Missing historical event coverage is disclosed. It is never backfilled from guesses in this reporting phase.

## Runtime and query design

PostgresAnalyticsRepository owns SQL. analyticsService validates windows and computes the derived reopen-rate percentage. analyticsPresentation owns the shared Discord embed and period controls. Command and component handlers should only authorize, acknowledge interactions promptly, call the service and render the result.

The aggregate query uses CTEs for the ticket cohort, first customer message, first attributed staff response, first closure and first-closure cohort. It returns one aggregate row and uses existing ticket/event indexes, supplemented by migration 12 for common guild/date/event-type access paths. It does not cache results in an in-memory store that could become stale between bot processes.

## Part 1 acceptance checklist

- [ ] TypeScript build passes with the current Node toolchain.
- [ ] Analytics unit tests pass.
- [ ] PostgreSQL database verification and all existing tests pass in CI.
- [ ] Slash command and Settings-button views show the same core definitions.
- [ ] A member without Manage Server/Administrator cannot read the admin analytics view.
- [ ] A second guild's records cannot affect this guild's report.
- [ ] Empty databases and zero-sample windows render a valid report without NaN or Infinity.
- [ ] Confirm the migration is additive and idempotent.
- [ ] Perform live acceptance in a non-production Discord test guild before production rollout.

The implementation is not considered fully accepted until the actual CI checks and a live Discord test succeed. A commit by itself is not evidence of acceptance.
