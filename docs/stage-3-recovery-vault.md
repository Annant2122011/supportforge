# Stage 3 — Recovery Vault and Measurable Support Operations

**Implementation branch:** `feature/stage-3-recovery-vault-operations`  
**Stack:** PR #34 draft → Stage 2 PR #32 → Stage 1 PR #31 → baseline cleanup PR #33  
**Persistence:** Neon PostgreSQL remains authoritative. No production backup, restore, migration, or Discord mutation is performed by this implementation slice.

## Increment 1: recovery completeness preview

### Implemented in source

- A pure domain summarizer classifies native Discord deletion versus ticket-button deletion eligibility. Ticket-button restoration remains blocked unless the recorded review answer is explicitly **Yes, deleted by mistake**.
- Recovery preview reads existing PostgreSQL archive records and reports whether the channel snapshot exists, whether historic backfill is complete, archived/deleted message counts, latest archived timestamp, attachment metadata versus stored bytes, oversized or metadata-only attachments, pending/failed attachments, and messages already recorded in the replay ledger.
- The Settings recovery detail view includes a read-only recovery preview before its existing restore action.
- Administrator-only `/supportforge diagnostics recovery-preview` offers an independent slash-command entry path.
- The preview reports gaps instead of claiming content is recoverable when the archive does not contain the required bytes or historical messages.
- Restored messages continue to be attributed to the bot with original author/channel/message identifiers and timestamp. Historical users are never impersonated.

### Tests added

- `tests/recoveryPreview.test.ts` covers source eligibility, explicit accidental-deletion review, incomplete channel/history records, missing attachment bytes and invalid count normalization.
- These are unit tests for preview classification, not yet full PostgreSQL integration tests for every recovery failure window.

## Automated CI evidence

The Stage 3 implementation head `aef0b1501dccf52ac55aff041a033a23fd7ddcf0` passed [ResolvX CI #2090](https://github.com/Annant2122011/supportforge/actions/runs/39994584123): TypeScript build passed, **176/176 tests passed**, zero skipped, and disposable PostgreSQL verification passed. The initial CI attempt exposed one test assertion whose expected warning text did not match the implemented wording; that assertion was corrected and the subsequent run passed. This is not live Discord acceptance or a production Neon restore drill.

## Confirmed risks carried forward

1. **Replay duplicate window:** Discord message sends and Neon ledger writes cannot be one transaction. If send succeeds but the replay ledger write fails, a retry can duplicate some output. Existing ledgering reduces repeats but cannot prove exactly-once delivery. A later increment must improve the operation ledger and add injected-failure recovery tests without claiming cross-system exactly-once semantics.
2. **Incomplete archive:** messages not yet captured by backfill cannot be inferred after channel deletion. Ticket-button deletion does a full backfill before deletion; native deletion may leave only content already archived. The preview surfaces that boundary.
3. **Attachments:** attachment metadata may survive when bytes were too large, inaccessible, pending, or failed. Only archived bytes are counted as directly restorable.
4. **External backup/restore:** the existing per-server configuration checkpoint is not a database backup. Stage 3 must document and prove a real Neon backup/restore drill using an isolated non-production target. No such verified drill is currently evidenced.
5. **Persistent job observability:** Stage 2 operational task telemetry is process-local and resets on restart. Stage 3 still needs restart/failure-window tests across the durable outbox, archive workers, transcript delivery and recovery.
6. **Metrics/SLA/CSAT:** no Stage 3 acceptance is claimed for metric definitions, SLA pause/resume rules, CSAT duplicate-vote protection or privacy-aware operational aggregates yet.

## Stage 1/2 re-audit snapshot — 2026-10-23

| Gate | Evidence | Current result |
|---|---|---|
| Stage 1 TypeScript build, test suite, disposable PostgreSQL | [CI #2052](https://github.com/Annant2122011/supportforge/actions/runs/39972706424), 138/138 tests, zero skipped | Automated checks passed on the recorded Stage 1 head |
| Stage 2 TypeScript build, test suite, disposable PostgreSQL | [CI #2065](https://github.com/Annant2122011/supportforge/actions/runs/39974451567), 172/172 tests, zero skipped | Automated checks passed on the recorded Stage 2 head |
| Baseline cleanup | [PR #33](https://github.com/Annant2122011/supportforge/pull/33) | Open draft; must be reviewed before Stage 1 integration |
| Stage 1 | [PR #31](https://github.com/Annant2122011/supportforge/pull/31) | Open draft, temporarily based on #33; after #33 merge, retarget to `main` |
| Stage 2 | [PR #32](https://github.com/Annant2122011/supportforge/pull/32) | Open draft stacked on #31 |
| Non-production Discord interaction/permission acceptance | No authorized test-guild run supplied | Blocked / not run |
| Isolated non-production Neon backup/restore drill | No authorized isolated target and restore evidence supplied | Blocked / not run |
| Stage H2 locale coverage | Branch notes still list Settings pages, panel previews and selected reports as incomplete | Partial |
| Stage 2 large-guild/concurrent-admin stress and compensation failure injection | Not evidenced as completed | Open |

## Next Stage 3 increments

1. Strengthen recovery-operation idempotency and restart reconciliation around every Discord send, Neon ledger write and replacement-channel creation window; add PostgreSQL integration/failure-injection tests.
2. Define and document safe Neon backup and isolated restore verification. Treat restore success, row-count/integrity checks and post-restore application verification as separate outcomes.
3. Add privacy-aware operational metric definitions and deterministic database queries for response time, resolution time, backlog and reopened/aged tickets.
4. Add per-server/department/priority SLA rules with explicit pause/resume, exemptions, threshold alerts and audit events.
5. Add optional CSAT with duplicate-vote prevention, configurable retention and permission-filtered aggregate reporting.
6. Expand recovery tests to large histories, unavailable channels/members/attachments, restart between each persisted step and concurrent restore attempts.

**Release rule:** source changes and green CI are not a substitute for non-production Discord acceptance or a successful isolated Neon restore drill. No feature should be marked production-accepted until the evidence is recorded.


## Latest Stage 3 verification — 2026-10-23

The current Stage 3 PR head `ba16f7a80ab3ea1dd048ac204558612c905ae6d5` passed [ResolvX CI #2234](https://github.com/Annant2122011/supportforge/actions/runs/40007138117): TypeScript build passed, **186/186 tests passed**, zero skipped, and disposable PostgreSQL schema/integrity verification passed, including SLA policy, CSAT response and SLA alert tables.

Follow-up reliability hardening included a rotating bounded SLA scan cursor (so a guild with more than one batch is not permanently stuck on the first 250 IDs) and deactivation rather than physical deletion of SLA policies, preserving alert history. This still does not prove real-guild SLA timing/load behavior or an actual Neon backup/restore drill.
