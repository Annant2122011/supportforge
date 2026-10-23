# Stage 2 — Administration and Operational Diagnostics

**Branch:** `feature/stage-2-localized-operational-excellence`  
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
- Form restoration appends a new immutable version for each form present in the checkpoint; it never rewrites prior form versions or submissions. Forms created after the checkpoint are not deleted; if one conflicts with the restored active route, rollback fails closed and asks the administrator to resolve the newer mapping first. A rollback does not restore Discord channel names, original messages or role state. Ticket records, transcripts and other guilds are not intentionally modified.
- The history document is bounded by checkpoint count; extremely large panel/config payloads still need stress testing before large multi-tenant scale.

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

## Required acceptance before Stage 2 can be called production-complete

- [x] Prior Stage 2-only source passed [ResolvX CI #1961](https://github.com/Annant2122011/supportforge/actions/runs/39958534108): TypeScript build, 151 tests passed, 0 failed, 0 skipped, and PostgreSQL verification.
- [ ] Re-run build, full tests and PostgreSQL verification on this H2-aware Stage 2 branch head.
- [ ] Test guild: missing/deleted panel, transcript, audit and Settings destinations show correct statuses without destructive action.
- [ ] Verify paginated health output shows every finding across all pages, including a server with many departments and custom panels.
- [ ] Test guild: deliberately remove bot permissions and verify clear warnings for each destination.
- [ ] Test guild: private-thread mode checks parent and thread permissions.
- [ ] Inject database connection failure and outbox-query failure; confirm reports say Error/Unknown.
- [ ] Create two configuration snapshots, confirm list order and per-guild isolation in the live test-guild.
- [ ] Restore a snapshot with correct and incorrect confirmation phrases in the live test-guild.
- [ ] Inject a test-only failure between configuration-document writes and verify checkpoint compensation in an isolated integration test.
- [ ] Exercise rollback of form routing and support-hours policies, including a newer active-form conflict.
- [ ] Confirm restore is audited and refreshes the public panel and Settings dashboard.
- [ ] Verify the restore leaves ticket records, transcripts, history and other guild configuration intact.
- [ ] Check Discord command registration and button routing in a non-production bot.
- [ ] Exercise configuration history under large panel lists and concurrent admin changes.
- [ ] Verify backup/restore of Neon independently; configuration checkpoints are not a substitute for database backups.

## Known limits

- This increment does not expose an HTTP health endpoint; diagnostics are available inside Discord to authorized administrators.
- A health command is a point-in-time probe, not continuous monitoring.
- Outbox aggregate checks rely on the current PostgreSQL schema and guild_id column.
- Diagnostics use the existing configuration-reader APIs; on a completely new guild, those APIs may initialize default JSON configuration documents. They do not repair or delete Discord resources.
- Discord and PostgreSQL cannot share a single atomic transaction. Configuration restore uses a checkpoint plus compensation, but operators must still inspect logs when compensation itself reports failure.
- Real-guild acceptance and a non-production Neon restore drill cannot be performed from CI alone.
