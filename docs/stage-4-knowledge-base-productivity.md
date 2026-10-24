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
- [ ] Stage H2 detailed support-hours/workspace/storage/manual/repair pages, remaining custom-panel builder shell copy and fuller report rule/category details are finished or explicitly retained as release limitations. Current Settings/localization coverage and test evidence are tracked in `docs/stage-h-translation-architecture.md`.
- [ ] Large-guild tests cover more than one SLA sweep batch, concurrent policy edits, backup size limits, high message counts and role changes during article/reply access.

## Known limits retained intentionally

1. Workflow execution is manual and admin-confirmed only; no automatic triggers exist. Templates containing department reassignment are rejected by the executor until Discord permission/category reconciliation is implemented through the established routing path.
2. SLA scan has a bounded batch per guild; large-guild throughput/restart rotation needs verified load tests before promising an alert deadline.
3. Recovery message segment markers reduce duplicate replay after partial failure, but cross-system exactly-once delivery cannot be guaranteed when Discord accepts a send and the bot cannot read recent history again.
4. The backup/restore scripts are guarded utilities, not automatic production rollback. Actual Neon backup/restore acceptance must be run against a disposable non-production target.
5. Stage 1/2 live environment gates remain blocked; CI-only evidence is not production acceptance.

**Completion policy:** All implementation, CI, test-guild and database restore evidence must be reported separately. Do not mark the programme complete merely because all feature files exist.


## Historical combined Stage 4 CI — 2026-10-23

Historical evidence only: earlier Stage 4 candidate head `106b25a399d13a1012b093131b1c7719bd25529d` passed [ResolvX CI #2249](https://github.com/Annant2122011/supportforge/actions/runs/40007820017) with 196/196 tests, zero skipped, and disposable PostgreSQL verification. That was not the consolidated PR #39 code head; the tested consolidated source head and current evidence are recorded below.

This is combined-code CI evidence only. Test-guild role/command acceptance and an isolated non-production Neon backup/restore drill remain unrun. The Knowledge Base/quick-reply commands now check the staff role configured for the current ticket’s department before sharing or sending into that ticket.


## Consolidated branch and schema sequence

This implementation is carried by the consolidated Stage 4 review on top of the latest Stage 3 Recovery Vault branch. Stage 3 migration 13 owns the durable replay-segment ledger; the Knowledge Base, quick-reply and safe-workflow catalog schema now uses migrations 14–18 for the article, quick-reply, related-ticket, workflow-catalog, revision and execution-audit schemas. Only CI on the exact consolidated PR #39 head can verify this combined code and schema. Live Discord acceptance and an isolated non-production Neon restore drill remain separate release gates.


## Latest consolidated Stage 4 CI — 2026-10-24

- Review target: [PR #39](https://github.com/Annant2122011/supportforge/pull/39). Tested source-code head: `dd740bd0b6721a13c41705468dd78607a4b91af2`; later commits in this document only update acceptance notes.
- [ResolvX CI #2574](https://github.com/Annant2122011/supportforge/actions/runs/40094178966) passed: TypeScript build passed, **212/212 tests passed**, zero skipped, and disposable PostgreSQL verification passed.
- The current increment adds admin-confirmed `workflow execute`, `workflow resume` and `workflow runs` slash commands; execution is manual only. Department reassignment is intentionally blocked until category and Discord role-permission reconciliation can be safely reused.
- The pull request remains open and unmerged. Live non-production Discord acceptance, actual command registration/permission testing in a test guild, and an isolated non-production Neon backup/restore drill remain **not run**. No deployment or production acceptance is claimed.


## Stage I — Second increment: contextual Knowledge Base suggestions

The underlying article store/search is the first increment. The missing ticket integration is now implemented in this candidate:

- `/supportforge knowledge suggest <query>` is available only in an active managed ticket and requires the staff role configured for that ticket's department (or server management permission).
- The response is ephemeral and tenant-scoped. It lists the deterministic PostgreSQL/typo-tolerant search results, but only medium/high confidence results receive direct-share buttons. A low-confidence/no-result result does not block ordinary human support.
- Clicking Share revalidates the original channel ID, guild, active ticket status, the actor's current department staff role, article publication state, visibility and article role restrictions. It never trusts the old search result as authorization.
- Sharing posts a clearly labelled, size-bounded excerpt to the same ticket, suppresses automatic mentions, and leaves the ticket open. Usage metrics and audit-channel notifications are best-effort after successful delivery, so an observability failure does not falsely tell staff that a posted article failed.
- Search synonym expansion now matches complete canonical terms and multi-word phrases, then evaluates each expansion as an independent PostgreSQL OR branch and scores typo-tolerant metadata against the best matching variant. This avoids the previous failure mode where appending every synonym made all of them mandatory AND terms. Pure tests cover phrase matches, substring collisions, independent alternatives and confidence-gated share eligibility.
- No AI or model provider is used. Semantic/RAG retrieval remains outside Stage I and is not implied by this deterministic implementation.

## Stage J — Quick Replies architecture

### Target architecture

```text
Ticket panel button ─┐
                     ├─> Interaction adapter
/supportforge quick-reply send ┘
                             │
                             v
                 Active-ticket + guild guard
                 Department staff + role gate
                             │
                             v
                   Quick Reply service
           Load enabled current reply by guild ID
           Resolve allowlisted placeholders only
           Re-check version/access at send time
                             │
                             v
                 Discord delivery boundary
              allowedMentions.parse = []
                             │
                             v
               Durable PostgreSQL revision
               + ticket audit event / telemetry
```

### Contracts and invariants

1. **One authoritative store:** Neon PostgreSQL remains the production source of truth. `quick_replies` stores the current row; `quick_reply_revisions` preserves immutable create/update/delete/restore snapshots. Do not introduce a live JSON or SQLite store.
2. **One sender:** slash and button entry points use `sendQuickReplyInTicket`. The sender rechecks same-guild/current-channel identity, active ticket state, the ticket department's configured staff role, reply enablement and any extra allowed-role restrictions.
3. **Safe rendering:** only `{user}`, `{username}`, `{ticket_id}`, `{ticket_number}`, `{department}`, `{priority}` and `{staff}` are valid. Missing values resolve to empty strings or a harmless customer/support label; no templates execute code. Discord automatic mention parsing remains disabled.
4. **Concurrency and history:** create versus update is explicit; updates/deletes require the current version; stale edits fail instead of overwriting another administrator's work; restoration creates a new version and never rewrites history.
5. **Thin entry points:** `/supportforge quick-reply send`, the standard ticket-panel button and the private-thread ticket-panel button all delegate to the shared sender. The UI selector must filter disabled replies and revalidate at selection time.
6. **Observability:** sends record the reply ID/version and actor in ticket audit history. User-written response bodies are not copied into operational telemetry.

### Implementation progress

**Part 1 is implemented and CI-verified:** the Quick Reply button opens a staff/role-filtered select menu in both standard ticket channels and private threads. Selecting an item and using `/supportforge quick-reply send` call the same delivery service, which rechecks ticket state, department authorization and reply enablement. Template validation rejects unknown, malformed and nested placeholders; sends disable automatic mention parsing. The exact source head passed CI #2739 (216 tests, zero skips, disposable PostgreSQL verification).

**Part 2 implementation is present in the current source:** the ticket-panel picker applies query/category/exact-tag filters in the PostgreSQL query and paginates in 25-option pages; `/supportforge quick-reply list` exposes the same filters; and administrator-only `/supportforge quick-reply metrics` shows privacy-safe aggregate usage counts. Migration 18 adds durable send intents and usage events. Each send is tied to the Discord interaction, guild, ticket, actor, reply and a stable hidden marker. Completed sends are idempotent; ambiguous outcomes are marked `uncertain` and the service attempts marker-based reconciliation without blindly resending. Automatic mention parsing remains disabled. Pure tests cover tag normalization and marker identity; the disposable-PostgreSQL suite checks ledger persistence, while more exhaustive Discord delivery/race/failure-injection tests and large-guild stress testing remain acceptance work.

## Re-audit status and remaining release gates

- Historical source head `6faf61c73d49e73b6771200209ef1858474ad377` passed [CI #2815](https://github.com/Annant2122011/supportforge/actions/runs/40102848466): TypeScript build passed, 217/217 tests passed, zero skipped, and disposable PostgreSQL verification passed. This is historical evidence only.
- The catalog regression on head `216867d5e1cf76139d888c6bae17156dbbc82efb` was fixed by adding the eight missing Bengali use-case preset labels. Corrected implementation head `f4515d6d69adb62f78d1f31ca7e73cd584c6fcef` passed [CI #40106837586](https://github.com/Annant2122011/supportforge/actions/runs/40106837586): TypeScript build passed, 220/220 tests passed, zero skipped, and disposable PostgreSQL verification passed.
- Stage I's deterministic Knowledge Base and contextual in-ticket suggestions/share flow are implemented in this candidate; Stage J's filtered/paginated quick-reply picker, aggregate metrics and durable send-intent/reconciliation path are also present. Automated tests exist, but authorized live acceptance and additional interaction/DB failure-path and large-guild stress tests remain required.
- Stage H's English, Hindi and Bengali catalogs now each contain 1049 matching unique keys. The draft now localizes the remaining custom-panel shell fallback/author/preview copy, ticket-form settings screens and modals, report selection/review, and report-rule/category slash-command outputs. Automated localization tests were added; verify this updated head in CI before merge.
- Consolidated implementation head `1afce9199e612736745f7264e92337c657b904b4` passed both CI verification jobs: TypeScript build passed, 228/228 tests passed, zero skipped, and PostgreSQL verification passed ([run A](https://github.com/Annant2122011/supportforge/actions/runs/40122028940), [run B](https://github.com/Annant2122011/supportforge/actions/runs/40122025777)). The ordered PR chain remains unmerged. Authorized Discord test-guild acceptance and a backup/restore drill into a newly created isolated non-production Neon database remain not run. No production merge, deployment, production database operation or 100% production acceptance is claimed.
