# ResolveX Stage 1 and Stage 2 — Scope, Exit Contract and Evidence

**Current dependency chain:** PR #33 → PR #31 → PR #32 → PR #34 → PR #38.  
**Production persistence:** Neon PostgreSQL.  
**Important distinction:** Stage 1/2 automated CI has passed on recorded earlier heads, but neither stage is production-accepted. A source review, CI result, test-guild result, backup/restore drill and deployment are separate evidence categories.

## Stage 1 — Stabilization, data safety and acceptance

### Purpose

Make the existing Stage A–H product a trustworthy baseline before adding new capability. Stage 1 is a stabilization/acceptance gate, not a reimplementation of every feature.

### Scope and required evidence

| Workstream | Required result | Evidence required to exit |
|---|---|---|
| Branch and merge integrity | Reconcile the PR stack; keep QueryFixr rebrand separate; no unrelated migration or cleanup | PR #33 reviewed/merged first; #31 retargeted to main; #31 reviewed against the real main baseline; dependency map updated |
| Configuration preservation | Only exact application-owned defaults may be normalized; custom names, tag text, panel copy, custom footers and settings must survive | Regression tests plus migration review; preserve data/config.json, backups, migration history and all durable archive/recovery records |
| Durable ticket lifecycle | State transitions, actor metadata, events and outbox changes remain consistent through errors/retries | Unit and PostgreSQL integration tests for concurrent changes, rollback, retries, stale activity and replayed jobs |
| Forms and panels | Validation, versions, routing, stale interactions, role checks, publish compensation, button/command parity | CI tests plus test-guild modal, routing and publish/edit/retry checks |
| Support hours, private workspaces and inactivity | Time-zone/DST boundaries, access, close/reopen and restart behavior are safe | Deterministic boundary tests plus test-guild permission and restart scenarios |
| Localization | Supported locales, per-key English fallback and Discord length boundaries work without changing user-generated content | English, Hindi and Bengali test-guild acceptance; remaining H2 Settings pages, panel previews and report surfaces checked |
| Data safety | No silent provider switch; Neon remains authoritative | Production-provider policy and disposable PostgreSQL checks pass; non-production backup restored to a separate isolated target and checked independently |
| Release acceptance | High-risk flows are exercised, not merely compiled | Signed-off checklist with incident/run references; no critical failures or unknown destructive behavior |

### Stage 1 stop conditions

Do not promote or report production acceptance if any data-preservation regression exists, if the current PR tree is not tested against the intended base, if a critical interaction is untested, or if isolated restore is not demonstrated. Missing environment access means BLOCKED, not PASS.

## Stage 2 — Administration and operational intelligence

### Purpose

Let authorized administrators detect misconfiguration and operational failures, understand impact, and perform controlled repairs without terminal access or destructive guesswork.

### Scope and required evidence

| Workstream | Required result | Evidence required to exit |
|---|---|---|
| Setup Doctor and diagnostics | Read-only findings cover gateway/database/migration, permissions, managed resources, panels/forms/routing, support hours, retention, inactivity, private threads, outbox and scheduled jobs | Finding IDs stable; paginated result completeness; failures/unknown states never appear healthy; no secrets or raw database messages leaked |
| Safe repairs | Repairs are explicit, authorization-checked, idempotent where practical and return truthful outcomes | Failure injection for permission/API/database errors; every repair re-checks its result; no unrelated channel/role deletion or rename |
| Configuration history | Versioned, guild-scoped checkpoints include supported settings/forms/panels/hours; preview and stale-state detection precede restore; prior revisions remain auditable | Tests for compensation failure, concurrent edits, large snapshots, newer-form conflicts and restore isolation |
| Ticket timeline | Uses the existing event/audit history rather than a competing source of truth | Stable ordering, actor attribution, pagination, private note filtering and recovery-event coverage |
| Duplicate-ticket controls | Existing open-ticket checks are visible, deterministic and allow a reasoned override for separate issues | Race tests and test-guild creation tests; no accidental blocking of distinct issues |
| Access and interaction polish | Commands and buttons perform equivalent operations where promised; mobile-friendly embeds; useful errors and no action-by-button dead ends | Command registration, role/permission, button staleness and interaction-timeout tests |
| Operational telemetry | Scheduled-task state distinguishes unobserved, stale, running, failed and recovered outcomes | Restart limitations documented; durable outbox state verified separately; no telemetry presented as external uptime monitoring |

### Stage 2 stop conditions

Stage 2 is not accepted if diagnostics hide later results, report unknown checks as healthy, disclose secrets, or a repair acts on the wrong resource. Rollback must fail closed on stale state and preserve audit history. Concurrent-admin, restore-compensation and real Discord permission scenarios must be executed in a non-production guild.

## Ordered integration and reporting protocol

1. Review and merge #33 only after its CI-cleanup change is understood.
2. Retarget #31 to main, rerun CI on the changed base, review and merge.
3. Retarget #32 onto the integrated Stage 1 head, rerun CI, review and merge.
4. Rebase #34, then #38, only after each predecessor is integrated. Rerun the full suite after each changed base.
5. Run a controlled non-production Discord acceptance plan and an isolated Neon backup/restore drill. Never use production data for destructive acceptance tests.
6. Record each gate as PASS, FAIL, BLOCKED, or NOT RUN, with commit/run/incident evidence. Do not infer a PASS from source inspection alone.

## Evidence currently recorded

- Stage 1 CI [#2052](https://github.com/Annant2122011/supportforge/actions/runs/39972706424): TypeScript build passed, 138/138 tests passed, zero skipped, disposable PostgreSQL checks passed.
- Stage 2 CI [#2065](https://github.com/Annant2122011/supportforge/actions/runs/39974451567): TypeScript build passed, 172/172 tests passed, zero skipped, disposable PostgreSQL checks passed.
- PRs #33, #31 and #32 were still drafts at the latest branch audit; the actual test-guild run and isolated Neon restore are BLOCKED / NOT RUN.
- Stage 3 recorded additional CI for archive preview, SLA/CSAT/metrics, and backup/restore tooling; these remain distinct from a successful live Neon restore drill.
- Stage 4 PR #38 adds KB/quick-reply capability. Its status depends on CI for the current head and controlled acceptance; no later-stage feature can waive Stage 1/2 gates.
