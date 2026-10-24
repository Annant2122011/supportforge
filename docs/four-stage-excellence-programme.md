# ResolveX Four-Stage Product Excellence Programme

**Status:** Consolidated Stage 4 source-code head `3d3dae5d07e06cd47989b8c2e283943a66fcf01f` passed [CI #2739](https://github.com/Annant2122011/supportforge/actions/runs/40101705001) (216/216 tests, zero skips, disposable PostgreSQL passed). Later commits update acceptance documentation only. Live Discord acceptance and isolated Neon restore remain not run.  
**Product surface:** Discord-first ResolveX  
**Production persistence:** Neon PostgreSQL; SQLite is not an allowed live provider  
**Delivery policy:** Small, reviewable commits and pull requests. No production deployment is implied by source changes or green CI.

This programme groups the requested product improvements into four delivery stages. It is separate from the existing master roadmap labels A–R. Each programme stage is split into narrow implementation increments; it is not one enormous feature branch.

**Current incremental status:** [Stage 3 Recovery Vault implementation and acceptance gaps](stage-3-recovery-vault.md) and [Stage 4 Knowledge Base/productivity candidate](stage-4-knowledge-base-productivity.md).

**Stage 1/2 acceptance evidence:** [Definitions, evidence and outstanding gates](stage-1-2-definition-and-acceptance-matrix.md).

## Non-negotiable engineering rules

- Preserve existing guild configuration, ticket records, message archives, migration history, and recovery metadata.
- Keep Neon PostgreSQL as the production source of truth. Do not add a second live SQLite persistence path.
- Use the existing domain services, repositories, event history, durable outbox and authorization checks rather than duplicating business logic in handlers.
- Maintain independent slash-command and button-based entry paths for major operations. A slash command that only displays a button is not equivalent functionality.
- Destructive changes require explicit authorization, preview where appropriate, and confirmation. Never silently delete tickets or rewrite unrelated server configuration.
- Do not translate or rebrand arbitrary user-generated content as part of a system migration.
- Report source review, automated CI, test-guild acceptance, production database verification and deployment as separate states.
- AI is not required for any feature in this programme. Stage I's Knowledge Base starts with deterministic search.

## Stage 1 — Stabilization, data safety and acceptance

### Scope

Stabilize the existing Stages A–H implementation before adding more user-facing surface area.

1. Reconcile the current branch/PR chain and determine which changes are actually in `main`, without merging unrelated work or the alternate QueryFixr rebrand.
2. Review the existing reliability, persistence, state machine/outbox, forms, panels, support-hours/private-thread, lifecycle/inactivity and localization implementations against their acceptance criteria.
3. Fix confirmed defects and add regression tests for them.
4. Verify custom configuration and historical data are preserved by migrations. The initial confirmed issue fixed in this stage was recursive brand substitution across all persisted strings; migrations now target exact application-owned defaults only.
5. Complete the Stage H locale controls and translation coverage in the intended branch, then test English, Hindi and Bengali behaviour, fallback and Discord limits. Keep this dependent on the H2 implementation being reviewed and merged in the proper order.
6. Produce a non-production Discord acceptance checklist covering permissions, command/button parity, form modal/attachment flows, panel publishing, support-hours boundaries and daylight-saving transitions, private threads, inactivity races, transcript delivery, recovery and 429/database-failure paths.
7. Verify build, tests and PostgreSQL integration checks in CI, then separately perform a backup/restore drill and test-guild acceptance.

### Deliverables

- Confirmed branch/PR dependency map and a clean review baseline.
- Confirmed fixes with regression coverage.
- Stage A–H status matrix marking each item as verified in source, passing in CI, accepted in a test guild, or still blocked.
- A release-readiness checklist with evidence and explicit remaining limitations.

### Exit criteria

No known data-rewriting migration silently changes custom server content; required CI checks pass on the final reviewed commit; high-risk Discord interactions pass in a test guild; the intended Neon database and backup/restore process are independently verified. A green CI run alone is not sufficient.

## Stage 2 — Administration and operational intelligence

### Deliverables

1. **Setup Doctor:** a guided configuration verifier for bot permissions, department staff roles, managed channels, transcript access, form routing, panel targets, workspace/thread permissions, retention and required configuration.
2. **System Health & Diagnostics:** actionable checks for database connectivity/migration state, stuck or retrying outbox jobs, repeated Discord rate limits, inaccessible channels/roles, failed schedulers, stale panels and incomplete reconciliation.
3. **Safe repair actions:** each issue includes severity, explanation, suggested remedy, reference ID, execution result and re-check. Repairs are idempotent where possible and never silently delete unrelated objects.
4. **Configuration history and rollback:** versioned snapshots for settings, panels, forms, routing policies, support-hours rules and appearance; a diff/preview before rollback; restored configurations create new audit history rather than erasing prior revisions.
5. **Preview-before-publish:** show the intended changes, affected panels/forms and validation warnings; reject stale drafts that would overwrite a newer revision without confirmation.
6. **Ticket activity timeline:** ordered lifecycle, assignment, priority, participant, internal-note, transcript, closure and recovery events with pagination and actor metadata.
7. **Duplicate-ticket prevention:** transparent checks for a member's active tickets by owner/category/status/time, with an existing-ticket shortcut and a documented override for separate issues.
8. **Interaction and accessibility polish:** consistent labels, useful status summaries, paginated histories, clear errors, keyboard/screen-reader-friendly wording where Discord permits, fewer redundant clicks and compact mobile-friendly layouts.

### Exit criteria

Administrators can diagnose common misconfiguration without terminal access, safe repairs report truthful outcomes, snapshots preserve server-specific settings, rollback is auditable, and core controls remain available through both slash-command and button workflows.

## Stage 3 — Recovery Vault and measurable support operations

### Deliverables

1. **Recovery Vault:** build on the current ticket/message archive and accidental-deletion recovery services. Store sufficient durable metadata to reconstruct ticket state, actor attribution, timestamps, attachment references and supported message history.
2. **Recovery preview:** before restoring, show what can be restored, what is missing and what will be recreated. Restored messages explicitly identify original author/channel/time metadata; the bot must never impersonate historical authors.
3. **Backup and restore operations:** create and document safe backups, retention, restore checkpoints and a verified restore procedure for Neon data. A backup is not considered valid until a restore drill succeeds.
4. **Deletion intent distinction:** keep native accidental-deletion recovery separate from intentional ticket deletion; retain the existing multi-step confirmation and audit trail.
5. **Durable job recovery:** cover restart, duplicate-delivery and partial Discord/DB failure windows for transcript uploads, outbox processing, scheduled warnings and closure. Use stable operation identities and reconciliation; do not claim exactly-once delivery across two systems that cannot share a transaction.
6. **Operational metrics:** measure ticket volume, first response, resolution duration, backlog, reopened/aged tickets, outbox health and article/ticket outcomes where data supports the measurement.
7. **SLA policies:** define configurable first-response and resolution targets by server/department/priority, with pause/resume rules, warning thresholds, exemptions and an audit trail.
8. **CSAT:** collect optional post-resolution feedback, protect against repeated votes, respect retention settings and produce useful aggregates without exposing private ticket content.
9. **Operational dashboards/reports:** provide paginated, privacy-aware summaries and transparent definitions for every metric.

### Exit criteria

Recovery has passed destructive-scenario testing in a non-production guild; Neon backup/restore has been demonstrated; lifecycle jobs resume safely after restart; SLA calculations are deterministic and auditable; CSAT/reporting respects permissions and retention.

## Stage 4 — Support productivity and product differentiation

### Deliverables

1. **Stage I Knowledge Base without AI:** CRUD for articles, categories and tags; drafts/publishing/archiving; article revisions; deterministic PostgreSQL full-text search; title/tag/category boosts; synonym mapping; typo-tolerant matching; confidence-aware no-result fallback; permission filtering; and usage/helpfulness metrics.
2. **KB-to-ticket integration:** relevant article suggestions for customers or support staff, a controlled way to share articles and a clear fallback to ordinary ticket support. Low-confidence matches must not block human support.
3. **Stage J quick replies:** reusable, permission-controlled staff responses with placeholders, category/tag organization, safe validation and usage reporting. Keep canned replies distinct from full KB articles.
4. **Ticket productivity:** related-ticket linking, safe duplicate detection, configurable ticket templates and well-audited workflow automation built on existing domain services.
5. **Workflow execution:** reviewed templates support explicit admin-confirmed `/supportforge workflow execute`, `/workflow resume` and `/workflow runs` commands against an active ticket. Actions are allowlisted and recorded in a durable PostgreSQL step ledger; no automatic triggers run. Department reassignment stays blocked until ticket category and Discord role-permission reconciliation can be safely reused.
6. **Transcript access improvements:** searchable/archive navigation, clear retention status, permission checks and reliable attachment references, respecting the Recovery Vault contract.
7. **Expanded quality programme:** broad regression suites, realistic failure injection, command-registration checks, performance tests and documented acceptance for supported Discord workspace modes.
8. **Deployment and ecosystem readiness:** consistent release process, operator docs, secure webhook/API boundaries and a web dashboard/API only after the Discord-first workflows and multi-tenant authorization model are stable.
9. **Branding/commercial polish:** coherent server themes, clear feature gating and honest premium/demo behaviour. Real billing must not be implied by demo-only entitlements.

### Exit criteria

Knowledge Base and quick replies are persistent, permission-safe and usable without AI; workflow execution is audited and recoverable; support metrics have documented definitions; transcripts obey retention/access rules; and release readiness is evidenced through CI and controlled acceptance.

## Consolidated acceptance status — 2026-10-24

- **Stage 1:** acceptance definition and evidence matrix are documented. Historical CI #2052 passed 138 tests; the later combined candidate also passes CI. Live Discord acceptance and isolated Neon backup/restore remain outstanding. Stage H now has 262 complete translation keys across all supported locales with placeholder parity and localizes the Settings dashboard, Support Hours, Ticket Workspace, Storage, Staff Manual picker, Repair and other selected Settings/report/panel-preview screens; detailed manual content, remaining builder/subpage copy, fuller report copy and live locale acceptance remain open.
- **Stage 2:** Setup Doctor, health diagnostics and safe configuration-history flows are documented and implemented on the stacked feature branch. Historical CI #2065 passed 172 tests; real test-guild repair/re-check and Neon restore acceptance remain outstanding.
- **Stage 3:** [PR #34 CI #2396](https://github.com/Annant2122011/supportforge/actions/runs/40054056156) passed 194/194 tests with zero skips and PostgreSQL verification. Live recovery/destructive scenarios, large-guild SLA tests, and the isolated Neon restore drill remain unrun.
- **Stage 4:** [Consolidated PR #39 tested source head CI #2739](https://github.com/Annant2122011/supportforge/actions/runs/40101705001) passed build, 215/215 tests with zero skips and disposable PostgreSQL verification. Stage I ticket-specific article suggestions and Stage J Part 1 quick-reply button/command parity are implemented in the candidate. Workflow execution is manual and admin-confirmed only; department reassignment is deliberately blocked pending safe Discord permission/category reconciliation.
- **PR/release state:** PR #39 remains open and unmerged. No test-guild acceptance, live Neon restore, or production deployment is claimed. Keep the PR chain in order: #33 → #31 → #32 → #34 → #39.

## Current Stage 1 implementation log

- Added `src/core/domain/managedBrandDefaults.ts` to restrict branding migration to exact known built-in defaults.
- Updated `src/services/configService.ts` so department names, tags, custom panel titles/descriptions, button labels, confirmation copy and non-default footers are not rewritten during load.
- Updated `src/services/advancedSettingsService.ts` so only exact default appearance/dashboard titles and footers are eligible for migration; custom descriptions, tag content and button customizations are preserved.
- Added regression coverage in `tests/managedBrandDefaults.test.ts`.
- Automated validation and real-guild acceptance must still be reported separately after CI runs.
