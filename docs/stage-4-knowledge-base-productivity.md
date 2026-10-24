# Stage 4 — Knowledge, Productivity and Release Readiness

**Implementation branch:** `feature/stage-4-complete-consolidated`  
**Review target:** Stage 3 PR #34  
**Production store:** Neon PostgreSQL remains authoritative. No data migration was executed on production, and no production deploy is implied.

## Deliverables implemented in this candidate

### Deterministic Knowledge Base

- PostgreSQL-backed articles with draft/published/archived state, public/staff visibility, allowed-role gates and per-guild unique slugs.
- Immutable content revisions and stale-write protection using an expected current revision.
- Publish/archive operations require the current revision. Archive is terminal to preserve history; old content can be copied to a new revision when the article remains editable.
- PostgreSQL full-text search with weighted title/category/tags/summary/body matching, plus bounded typo-tolerant metadata fallback.
- Per-guild synonyms, result-confidence labels, no-result fallback text, per-article helpful votes with one vote per user, and aggregate article search/view/share metrics.
- Search usage records article IDs and event types rather than raw customer queries.
- Sharing posts a summary in the current active managed ticket, keeps the ticket open, disables automatic mentions, and logs a ticket event.

### Quick replies

- Persistent, versioned replies with category, tags and optional role restrictions. Updating an existing reply requires its current version; concurrent/stale edits are rejected instead of silently overwriting newer content. Editing preserves enabled/disabled state unless the admin explicitly changes it.
- The placeholder allowlist is limited to `{user}`, `{username}`, `{ticket_id}`, `{ticket_number}`, `{department}`, `{priority}` and `{staff}`. Unknown placeholders are rejected.
- Sending is restricted to configured staff within an active managed ticket. Discord mention parsing is disabled, and sent replies are audited.
- Deletes require explicit confirmation; save/delete actions are admin-only.

### Related tickets

- Same-guild link records have composite foreign keys, canonical ID ordering and duplicate-link protection.
- Link/unlink do not merge records or alter lifecycle state. Links require an explicit confirmation to remove.
- Because links can expose ticket metadata across departments, all related-ticket management/list commands are admin-only in this increment. A later staff-level implementation must enforce access to both tickets, not merely the source ticket.

### Workflow templates

- Versioned catalog of JSON templates with strict allowlisted condition fields/actions, bounded array counts and configured-ID validation. Updating an existing template requires its current version; stale writes are rejected, and changed templates are returned to disabled catalogue state for review.
- Unknown keys, arbitrary JavaScript/SQL and lifecycle bypass actions are rejected.
- Admin-only `/supportforge workflow execute`, `runs` and `resume` expose explicit, manually confirmed execution inside the same active managed ticket. The execution ledger persists a template snapshot, conditions, per-step status/attempts, error classes and outbound message IDs in PostgreSQL. Resume is guarded by guild/ticket/channel identity and a PostgreSQL advisory lock. No automatic ticket-event triggers are enabled.
- The current manual executor supports validated priority updates, tag updates and quick-reply sends. Quick-reply sends suppress unsolicited mentions, use stable recovery markers and persist the destination message ID for reconciliation.
- `assign_department` remains accepted for template validation/preview but is deliberately blocked by the executor until the existing routing flow's Discord category and role-permission reconciliation is safely reusable. The preview marks such templates as not executable; the runner refuses them before any workflow step is created or executed. This prevents a metadata-only department change from accidentally leaving stale staff access in Discord.

## 2026-10-24 refinement increment

- Added PostgreSQL advisory locking around restoration of the same guild/ticket/deletion path, preventing concurrent bot processes from creating competing replacement channels.
- Extracted deterministic recovery segment markers into a pure helper and added coverage for stable identity, distinct segments, and marker extraction. These markers reduce replay duplication but do not promise cross-system exactly-once delivery.
- Added guarded saves for quick replies and workflow templates. Create is distinct from update; an update must supply the current `expected-version` shown in the list. Two concurrent updates with the same version cannot both succeed.
- Added disposable-PostgreSQL integration tests for concurrent quick-reply edits, disabled-state preservation, stale workflow writes, Knowledge Base publication/revision safety, public/staff/role access, hidden search results and duplicate article ratings.
- These additions were included in consolidated PR #39 and verified by exact-head CI #2574 on 2026-10-24 (212/212 tests, zero skips, disposable PostgreSQL verification passed).

## 2026-10-24 integrity and release-safety refinement

- Quick replies now write immutable revision snapshots in the same PostgreSQL transaction as create/update/delete; delete is a version-checked soft delete. `/supportforge quick-reply history` can inspect retained versions, including deleted records.
- Workflow templates now retain immutable snapshots for create/update/enable/disable/delete, with compare-and-swap on expected version and soft delete. `/supportforge workflow history` exposes the ledger. Catalogue enablement permits explicit manual runs after review; it never schedules or triggers automatic execution.
- The restore utility now refuses a target matching either currently configured `DATABASE_URL` or `DATABASE_URL_UNPOOLED` before changing process-local variables; malformed configured URLs fail closed. The archive-source mismatch, empty-target, checksum, explicit confirmation, migration and orphan checks remain in force.
- The PostgreSQL verifier requires quick-reply/workflow history tables and checks for orphaned productivity revisions, in addition to the existing Knowledge Base insert/update search-vector smoke test inside a rolled-back transaction.
- SLA task telemetry now marks a partial sweep as failed if any ticket could not be evaluated, while continuing with other guilds and preserving already persisted/idempotent alerts.
- Knowledge Base article paging supports 7 pages at 3,500 characters, matching the service's 20,000-character article limit.

The latest consolidated implementation is verified by exact-head CI #2574 below. The earlier CI runs in this file are retained as historical evidence and do not replace the latest run.

## Stage 1 and Stage 2 acceptance truth

- Stage 1 recorded CI #2052 passed build, 138/138 tests, zero skips and disposable PostgreSQL verification.
- Stage 2 recorded CI #2065 passed build, 172/172 tests, zero skips and disposable PostgreSQL verification.
- Stage 3 recorded CI #2155 passed build, 186/186 tests, zero skips and disposable PostgreSQL schema verification.
- The consolidated Stage 4 candidate now has exact-head CI evidence recorded below; the earlier stage-specific CI runs remain historical evidence for their respective commits.
- Intended review order remains PR #33 (baseline cleanup) → #31 (Stage 1) → #32 (Stage 2) → #34 (Stage 3) → PR #39 (consolidated Stage 4). PR #36 is an older alternate Stage 4 candidate.
- Test-guild acceptance, actual command registration in a non-production guild and a successful restore into a new isolated Neon database remain blocked/not run. No stage may be marked production-accepted until these are executed and evidence is recorded.

## Release readiness checklist

- [ ] The ordered PR chain is reviewed and merged without bypassing CI.
- [x] The consolidated Stage 4 head passed TypeScript build, 212/212 tests with zero skips, disposable PostgreSQL migration/integrity verification and the CI command-registration checks (CI #2574).
- [ ] An authorized test guild validates commands and role access independently from buttons, private ticket threads, stale revisions, staff-only articles, quick replies, related ticket privacy, and unauthorized actions.
- [ ] A backup is generated from a non-production Neon source; manifest checksum is verified; restore into a freshly created empty non-production target completes; schema migration level, table counts, ticket/event/outbox integrity and an application-level smoke test are recorded.
- [ ] A failed restore drill is repeated only after inspecting the isolated target; never switch the restore script to drop/clean populated targets.
- [ ] Audit logs are checked for correct actors and absence of user-written body/comment content in operational telemetry.
- [ ] Stage H2 remaining Settings pages, panel previews and selected report translations are either finished or explicitly retained as an accepted release limitation.
- [ ] Large-guild tests cover more than one SLA sweep batch, concurrent policy edits, backup size limits, high message counts and role changes during article/reply access.

## Known limits retained intentionally

1. Workflow execution is manual and admin-confirmed only; no automatic triggers exist. Templates containing department reassignment are rejected by the executor until Discord permission/category reconciliation is implemented through the established routing path.
2. SLA scan has a bounded batch per guild; large-guild throughput/restart rotation needs verified load tests before promising an alert deadline.
3. Recovery message segment markers reduce duplicate replay after partial failure, but cross-system exactly-once delivery cannot be guaranteed when Discord accepts a send and the bot cannot read recent history again.
4. The backup/restore scripts are guarded utilities, not automatic production rollback. Actual Neon backup/restore acceptance must be run against a disposable non-production target.
5. Stage 1/2 live environment gates remain blocked; CI-only evidence is not production acceptance.

**Completion policy:** All implementation, CI, test-guild and database restore evidence must be reported separately. Do not mark the programme complete merely because all feature files exist.


## Latest combined Stage 4 CI — 2026-10-23

The current Stage 4 PR head `106b25a399d13a1012b093131b1c7719bd25529d` passed [ResolvX CI #2249](https://github.com/Annant2122011/supportforge/actions/runs/40007820017): TypeScript build passed, **196/196 tests passed**, zero skipped, and disposable PostgreSQL verification passed. The database verification checks the Stage 3 and Stage 4 tables and performs insert/update smoke tests against the Knowledge Base search-vector trigger inside a rolled-back transaction. Synthetic rows are not retained.

This is combined-code CI evidence only. Test-guild role/command acceptance and an isolated non-production Neon backup/restore drill remain unrun. The Knowledge Base/quick-reply commands now check the staff role configured for the current ticket’s department before sharing or sending into that ticket.


## Consolidated branch and schema sequence

This implementation is carried by the consolidated Stage 4 review on top of the latest Stage 3 Recovery Vault branch. Stage 3 migration 13 owns the durable replay-segment ledger; the Knowledge Base, quick-reply and safe-workflow catalog schema now uses migrations 14–17 for the article, quick-reply, related-ticket, workflow-catalog, revision and execution-audit schemas. Only CI on the exact consolidated PR #39 head can verify this combined code and schema. Live Discord acceptance and an isolated non-production Neon restore drill remain separate release gates.


## Latest consolidated Stage 4 CI — 2026-10-24

- Review target: [PR #39](https://github.com/Annant2122011/supportforge/pull/39), exact head `dd740bd0b6721a13c41705468dd78607a4b91af2`.
- [ResolvX CI #2574](https://github.com/Annant2122011/supportforge/actions/runs/40094178966) passed: TypeScript build passed, **212/212 tests passed**, zero skipped, and disposable PostgreSQL verification passed.
- The current increment adds admin-confirmed `workflow execute`, `workflow resume` and `workflow runs` slash commands; execution is manual only. Department reassignment is intentionally blocked until category and Discord role-permission reconciliation can be safely reused.
- The pull request remains open and unmerged. Live non-production Discord acceptance, actual command registration/permission testing in a test guild, and an isolated non-production Neon backup/restore drill remain **not run**. No deployment or production acceptance is claimed.
