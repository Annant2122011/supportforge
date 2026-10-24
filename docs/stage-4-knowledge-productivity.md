# Stage 4 — Knowledge Base, Quick Replies and Support Productivity

**Implementation branch:** feature/stage-4-knowledge-productivity  
**Pull request:** [#38, Stage 4: Knowledge Base and staff productivity](https://github.com/Annant2122011/supportforge/pull/38)  
**Persistence:** PostgreSQL migration 14 (after Stage 3 migration 13); Neon remains the production source of truth.  
**Delivery status:** Core Knowledge Base, quick replies, related-ticket links and archived transcript search are implemented; full Stage 4 exit criteria still require controlled acceptance and the remaining workflow/productivity checks.

## Increment 1 — Deterministic Knowledge Base

### Article lifecycle

- Create a draft article with title, body, category, tags and public/staff visibility.
- Edit an article with immutable revision snapshots. Editing a published article returns it to draft so a change cannot silently replace published guidance.
- Explicitly publish and archive articles. Archive keeps the article and history, but removes it from normal search.
- View/search articles by stable article ID or slug; share a published article into an active managed ticket from a configured staff member.
- View immutable article revision metadata and submit a helpful/not-helpful vote. Each user has one current vote per article; later feedback updates that vote rather than inflating the count.

### Search behavior

- PostgreSQL full-text search uses a stored weighted search vector: title is highest priority, category/tags are boosted, and body content contributes normally.
- Per-guild synonym mappings are configurable; no search text is saved in usage telemetry.
- When normal search produces no result, a bounded edit-distance pass offers clearly labelled possible matches over at most 500 recently updated published articles. This fallback is intended for modest per-guild libraries; larger installations should move typo ranking into an indexed search strategy rather than increasing the in-memory scan without bound.
- Search results are deterministic and do not use AI. Low-confidence suggestions never block a customer from opening a normal support ticket.
- Public articles are visible to everyone. Staff-only articles require administrator or configured department staff access.
- Usage counters store article/action/time aggregates; reports do not expose individual users, raw queries or private ticket bodies.

## Increment 1 — Staff quick replies

- Create, edit, disable/archive and list saved responses.
- Scope each response globally or to a configured department; use is permitted only in an active managed ticket and only by assigned department staff or an administrator.
- Supported placeholders: {user}, {ticket_number}, {department}, {channel}, {guild}. Unknown placeholders are rejected.
- Expanded replies disable automatic mentions; values beginning with @ are neutralized to avoid accidental mass or user pings.
- Immutable quick-reply revisions and usage events are stored in PostgreSQL. Metrics return aggregate use counts.
- A reply is sent before its usage event is recorded. If that telemetry write fails, the sent reply is not falsely reported as unsent; the failure is logged for operator follow-up.

## Related-ticket links

- `/supportforge related link`, `list` and `unlink` maintain guild-scoped relationships between two existing durable tickets.
- Links are idempotent, self-links and cross-guild references are rejected, and duplicate link attempts return the existing relationship instead of adding a second copy.
- The command requires Manage Server/Administrator or configured staff roles covering both ticket departments. Listing filters links whose other ticket belongs to a department the staff member cannot access.
- Unlinking is a soft removal that preserves the link, actor and removal timestamp.

## Archived transcript search

- `/supportforge ticket search-archive` searches archived message text within one durable ticket, rather than scanning every guild transcript.
- Search is available to administrators and configured staff for the target ticket's department. The service independently verifies ticket/guild identity.
- Results are bounded to ten rows maximum, return short context snippets with author/time/message metadata, disable mentions, and omit attachment URLs and staff-only audit-channel notes.
- No match reports the archive/backfill limitation; it does not claim the ticket never contained matching text.

## Database and safety contract

- Tables are guild-scoped and every read/update includes the guild identifier.
- Articles and quick replies are archived/disabled instead of physically deleted through the command surface.
- Publishing, editing, archive operations, and synonym mutations use the server Settings audit stream when configured.
- No AI dependency, webhook, public API, production database operation or deployment is introduced.
- Search and feedback are ephemeral by default; article share and quick-reply use are explicit actions that post into a ticket channel.
- Migration verification checks the recovery replay segment ledger plus the article, revision, synonym, usage, feedback, quick-reply, quick-reply revision and related-ticket link tables. Transcript search uses the existing archive tables, not a duplicate transcript store.

## Remaining Stage 4 increments

1. Add optional article suggestions to supported form/ticket entry points. Suggestions must be staff/customer-visibility filtered and must never delay or block ticket creation.
2. Implement a deliberately constrained workflow v1 only after a concrete trigger/action allowlist, immutable versions, preview, audit, idempotency and compensation behavior are covered by tests. Do not add arbitrary graph execution or actions that bypass ticket permissions/state transitions.
3. Expand transcript archive navigation and attachment-reference browsing with retention, department permission and recovery-state checks; transcript text search is implemented in this increment.
4. Add realistic scale/rate-limit and concurrency tests for large per-guild article catalogs, search usage telemetry, concurrent article slug creation, related-link races and concurrent restore operations.
5. Complete the authorized non-production Discord acceptance, isolated Neon backup/restore drill and ordered merge/retest of PRs #33 → #31 → #32 → #34 → #38. Do not mark the product production-ready solely because feature-branch CI is green.

## Acceptance criteria

- CI passes build, complete test suite and disposable PostgreSQL schema checks on the latest combined head.
- A test guild confirms public vs staff visibility, publishing/edit-to-draft, search/synonyms/fuzzy suggestions, feedback update behavior, share permissions, staff role/department boundaries, disabled templates, placeholder validation and mention-safe output.
- Large-guild test confirms pagination and bounded response bodies. The fuzzy fallback's 500-article candidate cap is visible in operator documentation.
- Restore and archival tests show article/reply history is not silently deleted.
- Stage 1 and Stage 2 release gates remain separately satisfied; successful Stage 4 CI is not a substitute for those gates.


## Latest combined CI evidence — 2026-10-24

The combined Stage 3 + Stage 4 head `deda4ffb5ef58f60db3fc00cb52103329d78d161` passed [ResolvX CI #2514](https://github.com/Annant2122011/supportforge/actions/runs/40084718577): build passed, **200/200 tests passed**, zero skipped, and the PostgreSQL schema/integrity verifier passed, including recovery replay segments, Knowledge Base, quick replies and related-ticket links. This is automated evidence only. Test-guild acceptance and isolated non-production Neon restore remain outstanding.


## Current PR-head verification — 2026-10-24

The current PR #38 head `13e989a1c284fdecee8e9c056237d6b5d0d2fbff` passed [GitHub Actions run #40085125143](https://github.com/Annant2122011/supportforge/actions/runs/40085125143): TypeScript build passed, **201/201 tests passed**, zero skipped, and PostgreSQL schema/integrity verification passed. The workflow also emitted dependency deprecation warnings and expected simulated-failure logs from failure-path tests; the job concluded successfully. This verifies the current PR head in a disposable PostgreSQL environment, not live Discord behavior or a Neon restore drill.