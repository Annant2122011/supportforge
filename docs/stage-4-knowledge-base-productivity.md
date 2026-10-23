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

- Persistent, versioned replies with category, tags and optional role restrictions.
- The placeholder allowlist is limited to `{user}`, `{username}`, `{ticket_id}`, `{ticket_number}`, `{department}`, `{priority}` and `{staff}`. Unknown placeholders are rejected.
- Sending is restricted to configured staff within an active managed ticket. Discord mention parsing is disabled, and sent replies are audited.
- Deletes require explicit confirmation; save/delete actions are admin-only.

### Related tickets

- Same-guild link records have composite foreign keys, canonical ID ordering and duplicate-link protection.
- Link/unlink do not merge records or alter lifecycle state. Links require an explicit confirmation to remove.
- Because links can expose ticket metadata across departments, all related-ticket management/list commands are admin-only in this increment. A later staff-level implementation must enforce access to both tickets, not merely the source ticket.

### Workflow templates

- Versioned catalog of JSON templates with strict allowlisted condition fields/actions, bounded array counts and configured-ID validation.
- Unknown keys, arbitrary JavaScript/SQL and lifecycle bypass actions are rejected.
- Template preview states that templates are **not executable**. Catalogue enablement is only metadata; no automatic ticket execution is implemented until a separate execution plan reuses domain services, authorization, lifecycle guards, durable audit and outbox.

## Stage 1 and Stage 2 acceptance truth

- Stage 1 recorded CI #2052 passed build, 138/138 tests, zero skips and disposable PostgreSQL verification.
- Stage 2 recorded CI #2065 passed build, 172/172 tests, zero skips and disposable PostgreSQL verification.
- Stage 3 recorded CI #2155 passed build, 186/186 tests, zero skips and disposable PostgreSQL schema verification.
- These CI runs are different commits and are not evidence that all four-stage code passes together until the Stage 4 head CI is green.
- PR chain remains #33 (main baseline cleanup) → #31 (Stage 1) → #32 (Stage 2) → #34 (Stage 3) → Stage 4 PR.
- Test-guild acceptance, actual command registration in a non-production guild and a successful restore into a new isolated Neon database remain blocked/not run. No stage may be marked production-accepted until these are executed and evidence is recorded.

## Release readiness checklist

- [ ] The ordered PR chain is reviewed and merged without bypassing CI.
- [ ] The exact combined Stage 4 head passes TypeScript build, all tests with zero skips, PostgreSQL migration/integrity verification and command registration limit tests.
- [ ] An authorized test guild validates commands and role access independently from buttons, private ticket threads, stale revisions, staff-only articles, quick replies, related ticket privacy, and unauthorized actions.
- [ ] A backup is generated from a non-production Neon source; manifest checksum is verified; restore into a freshly created empty non-production target completes; schema migration level, table counts, ticket/event/outbox integrity and an application-level smoke test are recorded.
- [ ] A failed restore drill is repeated only after inspecting the isolated target; never switch the restore script to drop/clean populated targets.
- [ ] Audit logs are checked for correct actors and absence of user-written body/comment content in operational telemetry.
- [ ] Stage H2 remaining Settings pages, panel previews and selected report translations are either finished or explicitly retained as an accepted release limitation.
- [ ] Large-guild tests cover more than one SLA sweep batch, concurrent policy edits, backup size limits, high message counts and role changes during article/reply access.

## Known limits retained intentionally

1. Workflow templates are validated and stored but do not execute actions.
2. SLA scan has a bounded batch per guild; large-guild throughput/restart rotation needs verified load tests before promising an alert deadline.
3. Recovery message segment markers reduce duplicate replay after partial failure, but cross-system exactly-once delivery cannot be guaranteed when Discord accepts a send and the bot cannot read recent history again.
4. The backup/restore scripts are guarded utilities, not automatic production rollback. Actual Neon backup/restore acceptance must be run against a disposable non-production target.
5. Stage 1/2 live environment gates remain blocked; CI-only evidence is not production acceptance.

**Completion policy:** All implementation, CI, test-guild and database restore evidence must be reported separately. Do not mark the programme complete merely because all feature files exist.
