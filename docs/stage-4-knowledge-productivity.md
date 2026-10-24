# Stage 4 — Knowledge Base, Quick Replies and Support Productivity

**Implementation branch:** feature/stage-4-knowledge-productivity  
**Pull request:** [#38, Stage 4: Knowledge Base and staff productivity](https://github.com/Annant2122011/supportforge/pull/38)  
**Persistence:** PostgreSQL migration 14 (after Stage 3 migration 13); Neon remains the production source of truth.  
**Delivery status:** Increment 1 implemented; full Stage 4 exit criteria are not yet complete.

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

## Database and safety contract

- Tables are guild-scoped and every read/update includes the guild identifier.
- Articles and quick replies are archived/disabled instead of physically deleted through the command surface.
- Publishing, editing, archive operations, and synonym mutations use the server Settings audit stream when configured.
- No AI dependency, webhook, public API, production database operation or deployment is introduced.
- Search and feedback are ephemeral by default; article share and quick-reply use are explicit actions that post into a ticket channel.
- Migration verification now checks the new article, revision, synonym, usage, feedback, quick-reply and quick-reply revision tables.

## Remaining Stage 4 increments

1. Add a staff-only automatic article suggestion at form/ticket start with feedback loops, ensuring suggestions can never block ticket creation.
2. Add guarded related-ticket linking, templates and duplicate override audit, using existing ticket IDs and authorization rather than a separate ticket source of truth.
3. Extend safe workflows only with validated conditions/actions, immutable versions, preview, audit and rollback; no arbitrary graph execution.
4. Complete transcript archive navigation, content search and attachment access with retention/role checks and recovery metadata.
5. Add accessibility/mobile embed review, performance tests for large per-guild article sets and rate-limited usage metrics.
6. Expand PostgreSQL integration tests for data isolation, article status visibility, unique slug races, immutable revision correctness, synonym isolation, vote uniqueness, quick-reply department scopes and failed sends/telemetry.
7. Update product/operator documentation, then complete the full staged PR integration sequence and authorized non-production Discord acceptance.

## Acceptance criteria

- CI passes build, complete test suite and disposable PostgreSQL schema checks on the latest combined head.
- A test guild confirms public vs staff visibility, publishing/edit-to-draft, search/synonyms/fuzzy suggestions, feedback update behavior, share permissions, staff role/department boundaries, disabled templates, placeholder validation and mention-safe output.
- Large-guild test confirms pagination and bounded response bodies. The fuzzy fallback's 500-article candidate cap is visible in operator documentation.
- Restore and archival tests show article/reply history is not silently deleted.
- Stage 1 and Stage 2 release gates remain separately satisfied; successful Stage 4 CI is not a substitute for those gates.
