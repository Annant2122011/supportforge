# Stage 1 and Stage 2 — Definition, Evidence and Acceptance Matrix

**Snapshot date:** 2026-10-23  
**Current review order:** PR #33 → PR #31 → PR #32 → PR #34 → PR #36  
**Production persistence:** Neon PostgreSQL. No SQLite migration or production data switch is part of these stages.

## Status language

- **Source implemented** means reviewed code exists on the relevant feature branch; it does not mean merged or deployed.
- **CI passed** means the specific commit passed build, tests and disposable PostgreSQL checks.
- **Environment accepted** requires recorded execution in an authorized non-production Discord guild and an isolated non-production Neon target.
- **Production accepted** requires all prior gates and the explicitly approved release process. No stage is production-accepted in this snapshot.

## Stage 1 — Stabilization, data safety and acceptance

### Definition of complete
1. Reconcile branches and PR bases; keep the alternate QueryFixr branding branch separate.
2. Review Stages A–H against source and tests: persistence/provider policy, transaction/outbox state transitions, ticket metadata and lifecycle, forms, panels, support hours/private threads, permissions/inactivity and localization.
3. Fix confirmed content-preservation defects and cover them with regression tests.
4. Ensure migrations only alter exact known application-owned defaults and do not rewrite user-created department, tag, panel, button, footer or confirmation copy.
5. Ensure slash-command schemas remain within Discord option limits.
6. Finish or explicitly enumerate remaining language coverage, including Settings screens, panel previews and selected reports.
7. Publish test-guild acceptance steps for permissions, components, modals/attachments, panel publish rollback, support-hours/DST, private threads, inactivity races, transcript/recovery, Discord 429s and database interruptions.
8. Prove build/test/PostgreSQL CI, then separately execute a non-production backup/restore drill and test-guild acceptance.

### Evidence matrix

| Area | Current evidence | Outstanding gate |
|---|---|---|
| Managed defaults versus custom content | Regression tests verify only exact built-in defaults migrate | Test a pre-existing server configuration fixture in the controlled acceptance environment |
| Panel role restrictions and immutable snapshots | Unit/CI tests cover IDs, normalization and role policy | Verify actual published button registration and permissions in a test guild |
| Retention summary and inactivity policy | Regression tests cover disabled timer, activity reset, exemptions and compare-and-close | Verify restart/race behavior in a test guild |
| Forms and modal/attachment flows | Automated service tests cover validation/version/conditional/attachment metadata | Test actual Discord modals, uploaded attachments, stale interactions and limits |
| Support hours/private threads | Service tests cover boundary/overnight/DST and private-thread policy | Verify actual Discord roles/permissions and an observed DST transition |
| Localization H2 | Locale registry, fallback/interpolation and selected English/Hindi/Bengali lifecycle strings pass tests | Settings pages, panel previews and selected reports are still partial; perform live locale acceptance |
| Build/tests/PostgreSQL | [CI #2052](https://github.com/Annant2122011/supportforge/actions/runs/39972706424): build passed, 138/138 passed, zero skipped, disposable PostgreSQL passed | Re-run against the final ordered Stage 1 head after merging #33 baseline cleanup |
| Test-guild acceptance | Not run | **BLOCKED** pending authorized non-production bot/guild |
| Neon restore | Disposable PostgreSQL is not a Neon restore drill | **BLOCKED** pending backup artifact and a freshly isolated non-production Neon target |

### Current Stage 1 decision
**Source and recorded CI evidence: substantial. Stage exit criteria: not yet met.** PR #31 remains an open draft based on PR #33's cleanup branch. Review/merge #33 first, retarget #31 to `main`, run the final combined CI, then record live acceptance.

## Stage 2 — Administration and operational intelligence

### Definition of complete
1. Setup Doctor produces actionable configuration/permission findings without making destructive repairs.
2. System Health covers database/migration level, outbox health, channel/role access, panels/forms/routing, support hours, inactivity and managed resources; bad/unknown dependencies never report healthy by default.
3. Diagnostics are paginated, secret-safe and return a stable reference, severity and recommended next step.
4. Repairs require an explicit action, are safe/idempotent where practical and report the actual outcome.
5. Configuration snapshots cover the intended per-server configuration and policy documents; restore shows a diff, requires exact confirmation, makes a pre-restore checkpoint and records audit history.
6. Ticket event history remains the source for ticket activity; duplicate-ticket checks reuse existing active-ticket lookup and retain an explicit override for genuinely separate issues.
7. Task telemetry covers background worker state and repeated failures, while clearly documenting that process-local telemetry resets on restart.
8. Stress-test concurrent admins, compensation failure, large guilds and stale interactions. Separately run Discord and Neon acceptance.

### Evidence matrix

| Area | Current evidence | Outstanding gate |
|---|---|---|
| System Health / Setup Doctor | Implemented at `/supportforge diagnostics health` and `setup-doctor`, with Settings entry points and paginated safe findings | Validate actual missing permissions and repair/re-check flow in a test guild |
| Configuration history | Snapshot/list/preview/restore; stale fingerprints, pre-restore checkpoint and immutable form-version handling | Stress large snapshots and simultaneous admin edits; inject compensation failure |
| Task telemetry | Outbox, retention, inactivity, audit/reconciliation, updater, forms and archive jobs reported; secret-safe generic errors | Telemetry is process-local; restart and external alerting acceptance remains open |
| Duplicate-ticket prevention / ticket history | Existing durable ticket lookup and event stream are reused | Test concurrent creation and event pagination in a real test guild |
| Build/tests/PostgreSQL | [CI #2065](https://github.com/Annant2122011/supportforge/actions/runs/39974451567): build passed, 172/172 passed, zero skipped, disposable PostgreSQL passed | Re-run on final combined Stage 2 head after Stage 1 is integrated |
| Test-guild acceptance | Not run | **BLOCKED** pending authorized non-production bot/guild |
| Neon restore | Not run against Neon | **BLOCKED** pending isolated Neon branch/database and recorded checksum/schema/data integrity report |

### Current Stage 2 decision
**Source and recorded CI evidence: substantial. Stage exit criteria: not yet met.** PR #32 remains an open draft stacked on PR #31. It must only be reviewed after #33 and #31 are integrated in order. The automated check does not establish production Neon connectivity, backup recovery or actual Discord permissions.

## Cross-stage release gate

The following must remain separate report fields:

1. Source review and PR merge state.
2. Exact commit SHA for automated build/test/database verification.
3. Non-production Discord test-guild result, including command registration, button access and permission checks.
4. Non-production Neon backup/restore result, including checksum, migration level, core row counts, orphan checks and a bot/application smoke test.
5. Deployment and post-deploy health result.

Do not infer one status from another. In particular, green CI does not prove live Discord acceptance or recoverability of a Neon backup.
