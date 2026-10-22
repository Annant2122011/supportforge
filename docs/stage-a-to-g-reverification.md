# ResolveX Stages A–G Reverification Record

**Review date:** 20 October 2026  
**Review branch:** `feature/stage-a-to-g-audit-ui`  
**Review baseline:** Stage G Part 2 branch, stacked after the open Stage A–E, F1, F2 and G1 pull requests  
**Live datastore requirement:** Neon/PostgreSQL remains authoritative. No migration to SQLite, production database edits, merge to `main`, or deployment was performed in this review.

## Result summary

The source and requirements were reviewed from Stage A through Stage G against `FEATURES.md`, the Stage A–E inspection record, the Stage F/G design notes, and the interaction-parity checklist. Several concrete consistency/safety issues were corrected in this review branch. This does **not** mean every item in the long-range master feature registry is implemented or that live Discord acceptance has been completed.

| Stage | Reviewed implementation | Status after source review |
|---|---|---|
| A — Reliability and audit | Shared lifecycle and authorization logic, early interaction acknowledgement paths, bounded/retry-aware outbox processing, defensive parsing, auditable actors and startup reconciliation | Core foundation implemented; live Discord/permission/rate-limit acceptance remains |
| B — Persistence | PostgreSQL ticket/event/document repositories, migrations, Neon/PostgreSQL default provider, no silent live SQLite fallback | Core implementation present; production Neon credentials, migration, backup and restore drill not verified here |
| C — State machine, metadata and outbox | Explicit ticket states, transactional lifecycle/event/outbox updates, retry and reconciliation, status-safe metadata updates | Automated transaction coverage present; live worker restart / long Retry-After / permission-failure fault injection remains |
| D — Forms | Versioned definitions, templates, multi-step/conditional flows, server-side validation and durable submission association | Substantial implementation and tests; real Discord modal, attachment, stale-session and recovery acceptance remains |
| E — Panels and Settings builder | Visual multi-panel draft/publish flow, published snapshots, stale-button rejection, per-server Settings layout | Builder and regression tests present; Discord publishing/role/cleanup-failure acceptance remains; arbitrary general-purpose workflow graphs and native uploaded icon assets are outside this slice |
| F — Support hours and private threads | IANA timezone policies, scoped policy inheritance, final intake checks, private-thread workspace mode and lifecycle service | Source and policy tests present; actual server permissions, thread API behavior and recovery need live acceptance |
| G — Permission/lifecycle and inactivity | Shared authorization, closed-ticket ACL/private-thread locks, opt-in inactivity warning/grace scheduler, transcript-before-close, activity guard, PostgreSQL compare-and-close | Automated checks present; test-guild acceptance remains. Inactivity exemption controls are only partially implemented, as detailed below |

## Fixes made during this review

- Changed ticket-message activity writes to use metadata-only persistence, not a lifecycle transition carrying a potentially stale status. This prevents a message event that races claim/unclaim/close from reapplying the status captured earlier by the event handler.
- Added a recent-human-message reconciliation check around inactivity warnings and the close path. The sweep scans recent Discord history against the saved activity anchor; it refuses to act if history cannot be checked back to the anchor within its safety cap. Additional checks run around transcript upload and immediately before the compare-and-close operation.
- Revalidates the inactivity policy generation before warning delivery and at multiple close checkpoints. A scheduler run holding an old enabled policy will cancel its warning/close attempt after an administrator changes the policy.
- Clears and visibly cancels inactivity warnings when a ticket is manually closed/archived, when automation is disabled, when activity restarts the timer, or when the ticket becomes exempt.
- Exempts critical tickets, tickets marked by supported durable `vip`, `activeEscalation`, or `inactivityExempt` metadata, tickets in configured exempt departments, and tickets whose owner or assigned staff holds a configured exempt role. The Settings dashboard and `/supportforge settings inactivity` both expose the role/department controls.
- Adds PostgreSQL regression coverage that metadata updates preserve lifecycle status, alongside the existing compare-and-close/stale-anchor integration coverage.
- Reconciles the Settings dashboard summary with the implemented inactivity policy and workspace mode; changes the misleading retention label from “Unlimited/forever” to “No timer (365-day maximum)”.
- Groups Settings controls by workflow. An exact untouched legacy default order migrates to the grouped layout; custom server order is preserved.
- Updates the feature registry and interaction parity document so inactivity auto-close is no longer listed as wholly planned.

## Remaining partial scope and limits

- The inactivity feature remains `BUILT / PARTIAL` pending live acceptance and failure-injection: the Settings dashboard and slash-command fallback now configure exempt roles and departments, while ticket-specific `vip`, `activeEscalation`, and `inactivityExempt` metadata remain supported. The 1,000-message history scan cap remains a deliberate fail-safe; sustained high-volume tickets can pause auto-close until history can be proven.
- A database commit and a Discord send cannot be part of one distributed atomic transaction. Deterministic markers, upload receipts, transaction guards, and outbox reconciliation reduce duplicate/missed side effects; they cannot guarantee mathematical exactly-once delivery through every process/network interruption.
- A 1,000-message scan cap is deliberate fail-safe behavior. If the scheduler cannot prove the channel history back to the activity anchor within that cap, it pauses instead of guessing. Very busy channels may therefore need a longer audit/history limit or a dedicated durable activity cursor in a later increment.
- CI uses a disposable local PostgreSQL instance. It does not prove that the production Neon project is migrated, backed up, or restorable.
- The current PR chain remains open and stacked. Code from an open feature branch is not running in production merely because GitHub Actions passes.

## Verification performed

- Stage A–E requirements and audit notes checked alongside the Stage F/G design records.
- Master feature status and slash-command/button-parity documentation cross-checked against current source.
- Added tests cover policy exemptions, recent human activity selection, Settings dashboard summaries, default-layout migration, and preservation of custom layout order.
- PostgreSQL integration suite asserts that a stale activity anchor cannot close a ticket and that a valid close commits lifecycle/metadata events and outbox work.
- Final second-round GitHub Actions run on review head `bdbd80ae9ee90120e47e8275c47948ae62976116`: [run #1197](https://github.com/Annant2122011/supportforge/actions/runs/39399683798) — Build passed; **117 tests passed, 0 failed**; PostgreSQL verification passed.
- The first review CI pass caught a genuine TypeScript narrowing error in terminal-warning cleanup. The code was corrected to use the stable channel ID in the asynchronous error callback, and the full build/test/database workflow then passed.
- The second pass also caught a malformed three-column/extra-cell entry in the interaction-parity table. The table row was corrected, and run #1197 passed on the corrected documentation head.

## Live acceptance still required

Before promotion, run the documented checks in a non-production bot and test guild: permissions for each department and workspace mode; button/slash independence; support-hours boundaries and DST; forms and attachments; panel publish/retarget/cancel and failed persistence; manual and automated close races; transcript access failures; inactivity warning/reply/restart/disable flows; private-thread archive/lock behavior; deletion review/recovery; and outbox retries under 429, missing-channel, permission, and database failures. Confirm the intended Neon project, secrets, host deployment setup, and backup/restore drill separately.

**Completion rule:** report code review and CI separately from live acceptance. No source inspection or automated run makes an untested production server “perfect”.
