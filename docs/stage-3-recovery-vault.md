# Stage 3 — Recovery Vault and Measurable Support Operations

**Implementation branch:** `feature/stage-3-recovery-vault-operations`  
**Pull request:** [#34](https://github.com/Annant2122011/supportforge/pull/34)  
**Stack:** PR #34 → Stage 2 PR #32 → Stage 1 PR #31 → baseline cleanup PR #33  
**Production persistence:** Neon PostgreSQL. The scripts use explicit connection variables; no production database operation or Discord deployment is implied by these source changes.

## Implemented source scope

### 1. Recovery Vault and transparent recovery previews
- Existing ticket/message archive stores channel snapshots, message and edit metadata, attachment metadata/bytes where available, recovery intent, review answers and replacement-channel IDs in PostgreSQL.
- Settings recovery detail and administrator-only `/supportforge diagnostics recovery-preview` show the available snapshot, historic backfill status, archived/deleted message counts, attachment byte availability, and previously replayed records before restoration.
- Ticket-button deletion remains separate from native Discord deletion and cannot be restored unless its review explicitly says **deleted by mistake**.
- Replayed messages are clearly attributed to the bot with original author/channel/message IDs and timestamps. ResolvX never impersonates historical authors. Reactions and original Discord message/channel IDs cannot be recreated.

### 2. Restart-tolerant replay and restore concurrency
- Each replay segment has a deterministic recovery marker; retries inspect recent destination history and the durable replay ledger before sending it again.
- A failure while replaying one archived message stops the current replay attempt before later messages push its segment markers out of recent history.
- Concurrent restoration attempts for the same guild/ticket/deletion source are serialized using a PostgreSQL session advisory lock. The lock is released on success or failure and PostgreSQL drops it when the session closes.
- These mechanisms reduce duplicate replay and duplicate-channel races, but they do **not** guarantee cross-system exactly-once delivery: Discord and PostgreSQL do not share a transaction. A segment can still be duplicated if a send succeeds, the marker cannot be recovered from destination history, and the ledger write fails.

### 3. Neon/PostgreSQL backup and isolated restore utilities
- `npm run db:backup` uses the authoritative unpooled PostgreSQL connection, custom-format `pg_dump`, `pg_restore --list`, SHA-256, and an atomic manifest.
- `npm run db:restore` requires an explicit non-production confirmation and target label, validates the archive/manifest checksum and size, refuses the source host/database, requires an empty target, and restores in one transaction without `--clean` or dropping populated objects.
- Restore then runs application migrations and checks the expected migration level plus ticket-event referential integrity.
- Utilities and guard validations are implemented. No authorized isolated Neon backup/restore drill has been performed, so operational recoverability remains **unverified**.

### 4. Ticket metrics, SLA and CSAT
- Persistent SLA policies support guild-wide and department/priority-specific scope, first-response and resolution targets, a warning ratio, and pause-while-pending behaviour.
- Resolution timing starts a new cycle after reopen. Alert records are de-duplicated by ticket/policy/target/severity/policy version/lifecycle cycle. Large-guild scans rotate a bounded cursor; SLA policies are deactivated rather than physically deleted so alert history remains.
- The supervised SLA worker reports through Stage 2's operational task telemetry.
- `/supportforge diagnostics sla-list`, `sla-set`, `sla-delete`, `sla-check`, and `metrics` expose administration and ticket/aggregate reporting. The optional `/supportforge feedback rate` flow and aggregate `feedback summary` use per-ticket/user duplicate-vote protection.
- Automated calculations and schema tests are present. Live timing, load, permissions and alert delivery in a real Discord test guild remain unverified.

## Automated evidence and Stage 1/2 re-audit

### Recorded runs before the current recovery-lock increment
- Stage 1: [CI #2052](https://github.com/Annant2122011/supportforge/actions/runs/39972706424), build passed, 138/138 tests, zero skipped, disposable PostgreSQL verification passed.
- Stage 2: [CI #2065](https://github.com/Annant2122011/supportforge/actions/runs/39974451567), build passed, 172/172 tests, zero skipped, disposable PostgreSQL verification passed.
- Stage 3 PR #34 current head `d5245a8dcefc213a74c6469e56234357350ecc6c` passed [CI #2396](https://github.com/Annant2122011/supportforge/actions/runs/40054056156): build passed, 194/194 tests, zero skipped, and disposable PostgreSQL verification passed.
- The passing suite includes the durable recovery segment ledger integration test and the PostgreSQL advisory-lock test. These tests validate persistence and locking behavior on disposable CI PostgreSQL; they do not demonstrate live Discord replay behavior or a Neon backup/restore drill.

| Acceptance gate | Result |
|---|---|
| Source and tests for recovery preview, durable replay segments, backup/restore safeguards, SLA and CSAT | Implemented; CI #2396 passed on the current Stage 3 head |
| Build/test against disposable PostgreSQL | Prior Stage 3 head passed; rerun required after the current increment |
| Live Discord deletion/recovery/permissions/429/restart scenarios | **Blocked / not run** |
| Isolated Neon backup and restore, including checksum/schema/row-count/application smoke test | **Blocked / not run** |
| Real SLA alert timing and large-guild throughput | **Blocked / not run** |
| Production acceptance | **Not accepted** |

## Combined-stack integration evidence

The Stage 3 replay ledger and archive service are included in the Stage 4 integration branch. PR #36 head `e8127ed1efdd780df65ff03f3f1572d1a01313a2` passed [CI #2512](https://github.com/Annant2122011/supportforge/actions/runs/40084712275): build passed, 222/222 tests passed, zero skipped, and disposable PostgreSQL verification passed. The run verifies the recovery table and checks that completed segments have destination IDs; it still does not prove live Discord replay behavior or an actual Neon restore drill.

## Remaining risk-based work
1. Run the non-production Discord acceptance checklist for native deletion, accidental/intentional ticket-button deletion, concurrent restore clicks, restore restart windows, long histories, missing members/channels and unavailable attachments.
2. Create a backup from a disposable source, restore it into a newly created empty Neon branch/database, then record checksum, schema migration level, core row counts, orphan checks and application smoke-test evidence.
3. Exercise SLA cursor rotation over multiple batches, pause/resume across pending/reopen cycles, concurrent policy edits, repeated worker failures and notification rate limits in CI/test guild.
4. Stress backup file size, restore duration, archive volume and operational metrics on a disposable environment.
5. Continue Stage H2 locale completion for the remaining Settings pages, panel previews and selected reports under the Stage 1/2 release gate.

**Release rule:** green CI, a valid dump file and an empty-target restore script are not proof of an actual Neon restore drill. Report source review, CI, test-guild acceptance, database restore and deployment as separate outcomes.
