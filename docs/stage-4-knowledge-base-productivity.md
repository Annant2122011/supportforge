# Stage 4 — Knowledge, Productivity and Release Readiness

**Implementation branch:** `feature/stage-4-knowledge-base-productivity`  
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

- Versioned catalog of JSON templates with strict allowlisted conditions/actions, bounded array counts and configured-ID validation. Updates require the current version and return to disabled state for review; revision history is durable and soft-deleted definitions remain inspectable.
- /supportforge workflow execute performs **manual, administrator-only execution on the current active ticket**, requiring an enabled current version and the exact RUN <template-id> v<version> confirmation. It evaluates the saved conditions against the current ticket snapshot before creating any action steps.
- The durable PostgreSQL execution ledger records each run and step, the actor, template-version snapshot, attempts, result metadata and safe error codes. A ticket-scoped PostgreSQL advisory lock prevents two bot processes from starting or resuming competing runs for the same ticket.
- Allowed actions use existing metadata/outbox services for priority, department and tag changes. Cross-department tag changes are blocked. Quick replies suppress mentions and include a stable recovery marker.
- /supportforge workflow runs, resume, and resolve-step provide an explicit recovery route. Completed steps are skipped; database updates are reconciled against current ticket state; ambiguous sends scan channel history for the marker. If history is unavailable or does not cover the send window, the run stops for admin review instead of automatically resending. Choosing retry requires a typed confirmation that acknowledges possible duplicate delivery.
- Unknown keys, arbitrary JavaScript/SQL, unsupported actions and lifecycle bypass actions are rejected. **Automatic/background workflow triggers remain disabled**; an admin must explicitly execute each run.

## 2026-10-24 refinement increment

- Added PostgreSQL advisory locking around restoration of the same guild/ticket/deletion path, preventing concurrent bot processes from creating competing replacement channels.
- Extracted deterministic recovery segment markers into a pure helper and added coverage for stable identity, distinct segments, and marker extraction. These markers reduce replay duplication but do not promise cross-system exactly-once delivery.
- Added guarded saves for quick replies and workflow templates. Create is distinct from update; an update must supply the current `expected-version` shown in the list. Two concurrent updates with the same version cannot both succeed.
- Added disposable-PostgreSQL integration tests for concurrent quick-reply edits, disabled-state preservation, stale workflow writes, Knowledge Base publication/revision safety, public/staff/role access, hidden search results and duplicate article ratings.
- These additions require the new PR-head CI run to complete before they are marked verified.

## 2026-10-24 integrity and release-safety refinement

- Quick replies now write immutable revision snapshots in the same PostgreSQL transaction as create/update/delete; delete is a version-checked soft delete. `/supportforge quick-reply history` can inspect retained versions, including deleted records.
- Workflow templates now retain immutable snapshots for create/update/enable/disable/delete, with compare-and-swap on expected version and soft delete. `/supportforge workflow history` exposes the ledger. Catalog enablement remains non-executable metadata.
- The restore utility now refuses a target matching either currently configured `DATABASE_URL` or `DATABASE_URL_UNPOOLED` before changing process-local variables; malformed configured URLs fail closed. The archive-source mismatch, empty-target, checksum, explicit confirmation, migration and orphan checks remain in force.
- The PostgreSQL verifier requires quick-reply/workflow history tables and checks for orphaned productivity revisions, in addition to the existing Knowledge Base insert/update search-vector smoke test inside a rolled-back transaction.
- SLA task telemetry now marks a partial sweep as failed if any ticket could not be evaluated, while continuing with other guilds and preserving already persisted/idempotent alerts.
- Knowledge Base article paging supports 7 pages at 3,500 characters, matching the service's 20,000-character article limit.

These changes require CI on the latest exact PR head. The older passing CI run below is retained as historical evidence only and does not certify this refinement commit.

## Stage 1 and Stage 2 acceptance truth

- Stage 1 recorded CI #2052 passed build, 138/138 tests, zero skips and disposable PostgreSQL verification.
- Stage 2 recorded CI #2065 passed build, 172/172 tests, zero skips and disposable PostgreSQL verification.
- Stage 3 recorded CI #2155 passed build, 186/186 tests, zero skips and disposable PostgreSQL schema verification.
- These CI runs are different commits and are not evidence that all four-stage code passes together until the Stage 4 head CI is green.
- PR chain remains #33 (main baseline cleanup) → #31 (Stage 1) → #32 (Stage 2) → #34 (Stage 3) → Stage 4 PR.
- Test-guild acceptance, actual command registration in a non-production guild and a successful restore into a new isolated Neon database remain blocked/not run. No stage may be marked production-accepted until these are executed and evidence is recorded.

## Manual workflow execution safety contract

- A workflow must be enabled and the exact current version must be named in the confirmation phrase. Conditions are evaluated against the current durable ticket state.
- The service rejects non-active tickets, cross-server definitions, missing configured departments/tags/replies, and unsupported actions.
- Each run and step is durably ledgered before the action is attempted. The ticket-scoped advisory lock prevents concurrent execution from separate bot processes.
- Run history records no quick-reply body or customer message content in its operational event. Message delivery is identified with a stable marker and the resulting Discord message ID when known.
- A crash after an external send but before ledger update triggers marker reconciliation. If the bot cannot read enough history to prove absence/presence, it must stop for manual review. The operator can explicitly mark the send completed or acknowledge possible duplication before retry.
- Automated/background execution is deliberately disabled until a separate trigger/replay policy is reviewed.

## Release readiness checklist

- [ ] The ordered PR chain is reviewed and merged without bypassing CI.
- [ ] The exact combined Stage 4 head passes TypeScript build, all tests with zero skips, PostgreSQL migration/integrity verification and command registration limit tests.
- [ ] An authorized test guild validates commands and role access independently from buttons, private ticket threads, stale revisions, staff-only articles, quick replies, related ticket privacy, and unauthorized actions.
- [ ] A backup is generated from a non-production Neon source; manifest checksum is verified; restore into a freshly created empty non-production target completes; schema migration level, table counts, ticket/event/outbox integrity and an application-level smoke test are recorded.
- [ ] A failed restore drill is repeated only after inspecting the isolated target; never switch the restore script to drop/clean populated targets.
- [ ] Audit logs are checked for correct actors and absence of user-written body/comment content in operational telemetry.
- [ ] Workflow execution covers condition mismatch, stale template version, concurrent run lock, step retry after database mutation, marker reconciliation after send success, incomplete-history manual review, and explicit duplicate-risk acknowledgement.
- [ ] Stage H2 remaining Settings pages, panel previews and selected report translations are either finished or explicitly retained as an accepted release limitation.
- [ ] Large-guild tests cover more than one SLA sweep batch, concurrent policy edits, backup size limits, high message counts and role changes during article/reply access.

## Known limits retained intentionally

1. Workflow templates run only through explicit administrator confirmation on the current ticket; there are no automatic/background triggers. Ambiguous quick-reply delivery can require human resolution, and a manually confirmed retry can duplicate a message if channel history was incomplete.
2. SLA scan has a bounded batch per guild; large-guild throughput/restart rotation needs verified load tests before promising an alert deadline.
3. Recovery message segment markers reduce duplicate replay after partial failure, but cross-system exactly-once delivery cannot be guaranteed when Discord accepts a send and the bot cannot read recent history again.
4. The backup/restore scripts are guarded utilities, not automatic production rollback. Actual Neon backup/restore acceptance must be run against a disposable non-production target.
5. Stage 1/2 live environment gates remain blocked; CI-only evidence is not production acceptance.

**Completion policy:** All implementation, CI, test-guild and database restore evidence must be reported separately. Do not mark the programme complete merely because all feature files exist.


## Latest combined Stage 4 CI — 2026-10-23

The current Stage 4 PR head `106b25a399d13a1012b093131b1c7719bd25529d` passed [ResolvX CI #2249](https://github.com/Annant2122011/supportforge/actions/runs/40007820017): TypeScript build passed, **196/196 tests passed**, zero skipped, and disposable PostgreSQL verification passed. The database verification checks the Stage 3 and Stage 4 tables and performs insert/update smoke tests against the Knowledge Base search-vector trigger inside a rolled-back transaction. Synthetic rows are not retained.

This is combined-code CI evidence only. Test-guild role/command acceptance and an isolated non-production Neon backup/restore drill remain unrun. The Knowledge Base/quick-reply commands now check the staff role configured for the current ticket’s department before sharing or sending into that ticket.
