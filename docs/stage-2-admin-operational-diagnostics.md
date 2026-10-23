# Stage 2 — Administration and Operational Diagnostics

**Branch:** `feature/stage-2-localized-operational-excellence`  
**Review:** [PR #32](https://github.com/Annant2122011/supportforge/pull/32)  
**Production store:** existing Neon PostgreSQL configuration and outbox tables. No new live database, SQL migration or AI dependency is introduced by this diagnostic slice.

## Delivered in this increment

### System Health

- `/supportforge diagnostics health`
- Settings → Repair System → Run Diagnostics.
- Reports gateway/guild availability, Neon/PostgreSQL connectivity and migration level, guild-scoped outbox queue health, managed channel targets and permission gaps, default/custom panel messages, draft/published panel role and routing consistency, form version/mapping consistency, department roles/tags, support-hours scopes/time zones, retention ranges, inactivity thresholds/exemptions, and private-thread setup when applicable.
- Every finding has a stable reference ID, severity, details and suggested next step. Results are paginated at 10 findings per embed so a large server cannot silently hide later failures by overflowing one category field. The slash commands accept an optional `page`; the Settings dashboard has Previous/Next controls.
- Failed database or queue checks are reported as failed/unknown, never marked healthy by default.
- Connection strings, passwords and raw database errors are not displayed in Discord.

### Setup Doctor

- `/supportforge diagnostics setup-doctor`
- Settings → Repair System → Setup Doctor.
- Gives detailed setup/readiness findings without executing destructive repair actions.
- The existing Repair System remains responsible for repairs. Administrators must review a warning and intentionally choose a repair; diagnostics never rename or delete a channel automatically.

### Configuration history

- `/supportforge diagnostics snapshot`
- `/supportforge diagnostics snapshots`
- `/supportforge diagnostics restore-snapshot snapshot-id:<id> confirmation:"RESTORE <id>"`
- Settings has Save Snapshot and View Snapshots controls; selecting a snapshot opens a two-step review/confirmation flow.
- Each checkpoint stores this guild's existing guild-config and advanced-settings documents, support-hours policies, and the latest version/routing definition for existing forms in the current Neon/PostgreSQL-backed app-document system. The latest 10 checkpoints per guild are retained. History writes use a PostgreSQL transaction advisory lock so separate bot processes do not overwrite each other's checkpoint list.
- Restore requires the exact confirmation phrase, saves a pre-restore checkpoint, attempts compensation if a configuration/service step fails, refreshes the public panel and Settings dashboard, and logs the actor/action. Guild and advanced-setting documents are replaced from the snapshot rather than merged with newer keys.
- Form restoration appends a new immutable version for each form present in the checkpoint; it never rewrites prior form versions or submissions. Forms created after the checkpoint are not deleted; if one conflicts with the restored active route, rollback fails closed and asks the administrator to resolve the newer mapping first. The selected checkpoint is retained alongside the automatic pre-restore checkpoint even when restoring the oldest of ten saved entries. A fresh preflight comparison rejects changes detected while the restore is being prepared. A rollback does not restore Discord channel names, original messages or role state. Ticket records, transcripts and other guilds are not intentionally modified.
- The history document is bounded by checkpoint count; extremely large panel/config payloads still need stress testing before large multi-tenant scale.

### Background-task and reconciliation health

- System Health/Setup Doctor now includes tracked outcomes for the durable outbox worker, hourly retention sweep, inactivity sweep, daily audit summary/reconciliation, GitHub update monitor, active-form cache refresh, pending form-submission recovery, ticket-archive backfill, managed-resource startup reconciliation and developer-audit startup reconciliation.
- A scheduled task with no observed run is a warning rather than a false green. One-time reconciliation that was intentionally skipped because a guild has no prior managed setup is informational. Repeated failures escalate after three consecutive failures; a later success clears the consecutive-failure state.
- Findings contain only task name, elapsed duration, generic error class and a safe next step. Raw exception text, connection strings and credentials are not retained in operational task telemetry.
- This telemetry is process-local and resets on restart. It is meant to spot stalled/failing workers during a running process, not to replace persistent alerting, external uptime monitoring, or the durable outbox records. Diagnostics remain read-only.
- Added deterministic tests for unknown/stale/running task states, per-guild isolation, repeated failure escalation, recovery after success, intentional skips, and secret-safe error reporting.

### Existing Stage A–H capabilities reused instead of duplicated

- The ticket-history control already queries the audit/event trail; the Stage 2 work reuses it instead of creating a second timeline store.
- Ticket creation already calls the durable active-ticket lookup and retains a Discord-topic compatibility fallback for older tickets, avoiding another duplicate-ticket implementation.
- The public panel builder already includes draft previews, immutable published snapshots and stale-button rejection; diagnostics direct administrators to those existing tools.
- The existing database-backed ticket/event/outbox architecture remains authoritative.

## How diagnostic results are classified

- **OK:** the specific checked condition passed.
- **Warning:** a configuration or threshold needs review, but the report cannot prove immediate data loss.
- **Error:** a required destination, database connection or key prerequisite failed.
- **Unknown:** a dependency prevented the check from running; unknown is not silently converted to OK.

Outbox heuristics currently warn for failed jobs, more than 50 pending jobs, a pending item older than 15 minutes, or a processing lease older than 10 minutes. These are initial operational thresholds, not SLA guarantees, and should be tuned using observed traffic before production policy depends on them.

## Stage 1 audit findings carried forward

- Replaced recursive branding replacement with exact default-only migrations so custom guild text is preserved.
- Added strict Discord Snowflake string validation for saved panel/button role IDs. The earlier malformed escaped digit pattern could reject all valid persisted role IDs during config normalization; the shared validator preserves valid IDs, deduplicates them and rejects malformed values.
- Corrected retention summary wording when the timer is disabled.
- CI evidence and live Discord acceptance remain separate.

## Acceptance status

### Automated acceptance: PASS

- [x] Final combined Stage 2 + Stage H2 CI passed on the telemetry and restore-integration test head: [ResolvX CI #2063](https://github.com/Annant2122011/supportforge/actions/runs/39974255192). TypeScript build passed, **172 tests passed, 0 failed, 0 skipped**, and disposable PostgreSQL verification passed.
- [x] The test run explicitly exercised restore compensation after an injected support-hours validation failure. It verifies the previously applied guild and advanced settings are restored and the selected checkpoint remains available.
- [x] PostgreSQL integration coverage verifies configuration snapshots list newest-first and are isolated between guild IDs.
- [x] The destructive restore integration test refuses to run unless both `DATABASE_URL` and `DATABASE_URL_UNPOOLED` use `localhost` or `127.0.0.1`. This protects production Neon from the test path.
- [x] Synthetic pagination test verifies 23 findings are all visible across three pages without duplicate or dropped finding references.
- [x] Unit coverage checks that failed outbox deliveries are errors, large/stale queues are warnings, empty diagnostic results remain UNKNOWN, and telemetry warns on unobserved scheduled tasks, flags stuck/repeated failures, resets failure streaks after success and omits raw error strings.
- [x] The slash-command registration regression test recursively checks the 25-option cap and duplicate sibling names.
- [x] Disposable PostgreSQL verification reports required tables, referential integrity and active outbox lease state as verified.

### Live/environment acceptance: BLOCKED

The following checks require an authorized non-production Discord guild/bot or a separate non-production Neon target. They are not represented as passed merely because CI is green.

- [BLOCKED] Run `/supportforge diagnostics health` and `/supportforge diagnostics setup-doctor` through Discord as an administrator; confirm the Settings buttons, refresh, page controls and command registration work against the actual bot.
- [BLOCKED] In a test guild, remove/restore bot permissions and delete/recreate panel, transcript, audit and Settings destinations; check the findings and confirm diagnostics never mutate Discord resources.
- [BLOCKED] Exercise diagnostics against a large configured guild with many departments, forms and custom panels, and confirm the live pages show every finding.
- [BLOCKED] Verify private-thread parent and thread permissions, including a deliberate missing-permission case.
- [BLOCKED] Inject a live/staging PostgreSQL connection failure and an outbox-query failure; confirm the rendered report says Error/Unknown and never displays credentials or raw database errors.
- [BLOCKED] Use Settings controls to save/list multiple snapshots, validate user-bound review, reject a wrong confirmation phrase, accept a correct phrase, and verify the public panel and Settings dashboard refresh after restore.
- [BLOCKED] In the test guild, exercise form-routing and support-hours rollback, including a newer active-form conflict, and verify tickets, transcripts, audit events, Discord roles/channels and other guilds remain unchanged.
- [BLOCKED] Stress large configuration histories/panel payloads and concurrent admin edits during restore.
- [BLOCKED] Independently restore a Neon backup into a separate non-production Neon branch/database. A configuration snapshot is not a PostgreSQL backup.

## Known limits

- This increment does not expose an HTTP health endpoint; diagnostics are available inside Discord to authorized administrators.
- Background-task last-run tracking is process-local and resets on restart. It can detect failures/staleness during the current process but cannot prove that a task was healthy before the last restart.
- A health command is a point-in-time probe, not continuous monitoring.
- Outbox aggregate checks rely on the current PostgreSQL schema and guild_id column.
- Diagnostics use the existing configuration-reader APIs; on a completely new guild, those APIs may initialize default JSON configuration documents. They do not repair or delete Discord resources.
- Discord and PostgreSQL cannot share a single atomic transaction. Configuration restore uses a checkpoint plus compensation, but operators must still inspect logs when compensation itself reports failure.
- Real-guild acceptance and a non-production Neon restore drill cannot be performed from CI alone.
