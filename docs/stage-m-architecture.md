# Stage M — Customer Satisfaction (CSAT)

**Plan:** two parts, with Part 1 implemented on branch `stage-m-csat-part-1`  
**Depends on:** Stage L durable PostgreSQL operations in PR #43  
**Persistence:** Neon PostgreSQL remains authoritative  
**Non-goals:** AI sentiment inference, public rating feeds, staff leaderboards, or exposing raw customer comments to every administrator

## Why Stage M is split

The existing baseline has a normalized 1–5 rating domain function, a response table, a manual `/supportforge feedback rate` command, duplicate-vote protection, and an aggregate summary command. That is a useful seed, not a complete CSAT workflow: survey delivery is not automatic, there is no durable survey lifecycle or delivery receipt, and the reporting model does not show invitation/response coverage.

Part 1 establishes a reliable, private, observable lifecycle. Part 2 adds the manager-facing analytics and governance surfaces only after invitation/response counts have authoritative definitions.

## Part 1 — durable survey lifecycle and private collection

### Data ownership and transaction boundary

- Add an additive PostgreSQL migration 23. Do not renumber previous migrations or introduce SQLite.
- Keep `support_csat_responses` as the authoritative rating/comment record to preserve existing command and aggregation contracts.
- Add `support_csat_survey_settings` with explicit per-guild opt-in, enable timestamp, delay/expiry settings, actor and update timestamp. Surveys default to disabled so an upgrade never starts DMing customers without an administrator choosing it.
- Add `support_csat_surveys` as the durable invitation state machine: pending → sending → sent → responded; pending/sent may expire, and terminal delivery failure/cancellation is recorded rather than silently dropped. A unique guild/ticket key prevents a reopened ticket from generating duplicate invitations for the same ticket.
- Persist closure-event identity/time, due/expiry time, attempts/next attempt, last error, delivery receipt message/channel IDs, and response time. Backfill is not used to DM historical closed tickets: only closure events after the setting's enable timestamp are eligible.
- Use transactions and row locks for claiming a due survey and committing a response. The existing unique response constraint remains the last line of defense against repeat ratings.
- Preserve the manual rate command. If it receives a rating for a ticket with an outstanding survey, the monitor reconciles the invitation to responded.

### Delivery lifecycle

1. A scheduler observes durable `ticket.status_changed` events whose target status is closed, checks that the ticket is still closed/archived, checks the guild opt-in, and idempotently enqueues one survey for an eligible ticket.
2. A bounded worker claims due surveys with PostgreSQL row locking/leases and sends a private DM. No rating request is posted to the public ticket channel.
3. The DM provides one-click ratings 1–5 and an optional written-comment action. Rating is recorded immediately; the optional comment is separate and limited to the ticket owner.
4. A persistent receipt marker in the DM lets the worker reconcile a Discord send that succeeded while the database receipt write timed out. Retry is bounded with backoff; a blocked/closed DM becomes a visible failed delivery after the retry budget.
5. Expiry, manual ratings, deleted tickets and disabled settings are reconciled. The scheduler is guild-scoped and idempotent; restarting the bot must not create duplicate surveys or invitations.
6. Every submission rechecks ticket owner, guild, ticket state, survey expiry and uniqueness in the database. Component IDs are untrusted input and cannot establish ownership.

### Privacy and abuse controls

- Default-off opt-in, private DM only, one rating per ticket/owner, rate limited by the durable survey/response state, 1–5 whole-number ratings, comments capped at 500 characters.
- Do not include free-text comments in routine logs or aggregate dashboards. Error logs carry survey IDs and sanitized failure reasons, not the submitted comment.
- Raw comments remain administrator-restricted and are not part of Part 1's aggregate surfaces.
- A reopen does not reset the existing one-response-per-ticket key. Survey invitation identity and ticket-response identity remain aligned.
- Survey expiry is explicit and does not delete a submitted response. Retention/deletion controls must be audited separately in Part 2.

### Part 1 acceptance

- Migration 23 is additive and verified against disposable PostgreSQL.
- Unit tests cover survey status transitions, valid/invalid ratings, expiry boundaries, opt-in boundaries, duplicate submissions, and privacy-safe comment validation.
- PostgreSQL smoke tests cover guild scoping, unique invitation identity, enqueue idempotency, delivery lease recovery, response commit, and manual-response reconciliation.
- CI passes on the exact branch head.
- Controlled Discord acceptance confirms a DM prompt, blocked-DM handling, button/modal acknowledgement, and no public-channel disclosure. CI success alone does not prove these external flows.

## Part 2 — insights, governance, and manager UX

- Add coverage-aware CSAT reporting: eligible tickets, surveys queued/sent/failed/expired, responses, response rate, average rating, distribution, positive/neutral/negative counts and trend comparisons. Every percentage must show its denominator and time window.
- Add department/tag/priority/time-window filters with minimum-cohort thresholds to avoid identifying one customer's feedback in small groups.
- Keep the summary aggregate-only by default; expose comment review only through a distinct privileged workflow with pagination, audit events, retention notices and explicit comment visibility.
- Add Settings UI parity for enable/disable, delay/expiry, status/delivery failures, test-preview and reporting. Slash commands and Settings buttons call the same validated service functions.
- Add bounded CSV export only for aggregate rows; neutralize formula-leading cells and enforce row/byte limits. Raw comments and user IDs are not in aggregate exports.
- Add delivery/response coverage diagnostics and operational health for queues stuck in sending, retries exhausted, stale invitations and inconsistent response/survey records.
- Extend privacy/retention controls, help copy, English/Hindi/Bengali translations, and the interaction parity registry.

### Part 2 acceptance

- Query-level PostgreSQL tests cover aggregates, windows, filters, minimum-cohort behavior, CSV safety, and guild isolation.
- UI tests cover empty/error states, pagination and authorized comment access.
- Controlled Discord acceptance covers role gates, translations, retry/delivery state, repeat votes and comment privacy.
- Restore a verified backup into an isolated non-production Neon database and verify survey/response linkage, migration state, row counts and orphan checks before release.

## Cross-cutting rules

- No synthetic ratings and no inferred ratings from ticket status.
- No sentiment inference by AI; sentiment is derived only from the rating thresholds already used by the product (positive ≥4, neutral 3, negative ≤2).
- Missing invitation history means coverage is unknown, not that satisfaction is high.
- No production deployment or production database mutation is part of this stage's implementation branch.
- The Stage L PR #43 must be merged/accepted before this stacked Stage M PR is merged into `main`.


## Part 2 implementation — reporting, manager UX and privacy governance

Part 2 is implemented additively on top of Part 1 and uses PostgreSQL migration 24. It does not replace the existing response table or the /feedback rate path.

### Reporting definitions

- **Eligible closed tickets** are the persisted survey-ledger entries plus currently eligible, post-enable closed tickets that have not yet been swept into the ledger. Deleted tickets are excluded.
- **Invitations sent** count only survey rows with a confirmed sent_at receipt.
- **Survey responses** count an owner's rating only when the invitation has a confirmed delivery time and the response was recorded at or after that time.
- **Response rate** is survey responses divided by invitations sent. It is null when no invitation was delivered.
- **Delivery coverage** is invitations sent divided by eligible closed tickets. The report displays both numerator and denominator.
- Existing/manual ratings remain visible in the total ratings aggregate but are never misclassified as responses to an invitation that was not sent.
- Reports compare the selected window with the immediately preceding equal-length window and support department, tag and priority filters/breakdowns.

### Privacy, comments and governance

- A per-guild minimum cohort size defaults to 5 and is configurable from 1 to 100. Rating averages, distributions and group rows below the configured threshold are suppressed.
- Aggregate CSV exports contain no customer IDs, ticket IDs, comments or per-user data. Cells are protected against spreadsheet formula injection; exports are limited to 1,000 rows and 1 MB.
- Raw comments are excluded from all aggregate reports and exports. A separately permissioned comment-review command shows at most five records per page. Access is granted to Manage Server/Administrator or the configured reviewer role, and each successful review is audited without copying comment text into the audit record.
- Comment retention defaults to 180 days and is configurable from 1 to 3,650 days. The scheduled retention sweep clears expired comment text, records the redaction timestamp and audit count, and preserves the rating.
- Governance, comment access, survey enable/disable and timing updates are written to the per-guild CSAT audit history.

### Manager interface and commands

- The server Settings dashboard includes Customer Satisfaction controls for enable/disable, a privacy/timing configuration modal, and a 30-day report view.
- /supportforge feedback report supports date windows, department/tag/priority filters, and group breakdowns.
- /supportforge feedback export emits the privacy-safe aggregate CSV.
- /supportforge feedback comments is restricted to administrators and the configured reviewer role.
- /supportforge feedback survey-governance manages cohort threshold, comment retention and reviewer role.
- Existing survey status/enable/disable/configure and manual rate commands remain available. Automatic surveys remain off by default.

### Part 2 verification

- Unit tests cover percentage denominators, zero-sample behavior, cohort suppression, trend deltas and CSV formula-injection handling.
- Disposable PostgreSQL verification exercises migration 24, governance setting persistence, unique invitation handling, response linkage, manual-rating versus delivered-survey distinction, comment redaction with rating preservation, audit persistence and guild isolation in a transaction that is rolled back.
- CI verification does not deploy the bot or apply migrations to the production Neon database. Discord DM acceptance and a separate isolated non-production Neon restore drill remain release gates.
