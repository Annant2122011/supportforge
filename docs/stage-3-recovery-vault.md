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
- Each replay segment has a deterministic recovery marker and its own durable PostgreSQL intent row (`ticket_recovery_replay_segments`) with pending/completed status, attempt count/start time, destination Discord message ID and a safe error class.
- On retry, completed segments are skipped; pending segments search destination history from their persisted attempt timestamp for the deterministic marker, then reconcile to completed if the send was accepted before the database write failed. The history scan continues backwards until older than that timestamp, rather than examining only the newest 100 messages.
- A failure while replaying one archived message stops the current replay attempt before later messages obscure the uncertain segment. Database ledger errors are distinguished from Discord attachment-send errors and cannot be silently reported as an unavailable file.
- Concurrent restoration attempts for the same guild/ticket/deletion source are serialized using a PostgreSQL session advisory lock. The lock is released on success or failure and PostgreSQL drops it when the session closes.
- These mechanisms substantially narrow the duplicate window and recover the common send-succeeded/ledger-write-failed case, but they do **not** guarantee cross-system exactly-once delivery: Discord and PostgreSQL do not share a transaction. Duplicates remain possible if destination history is inaccessible/truncated by platform limits, the marker is removed/altered, or the post-send result is otherwise unknowable.

### 3. Neon/PostgreSQL backup and isolated restore utilities
- `npm run db:backup` uses the authoritative unpooled PostgreSQL connection, custom-format `pg_dump`, `pg_restore --list`, SHA-256, and an atomic manifest.
- `npm run db:restore` requires an explicit non-production confirmation and target label, validates the archive/manifest checksum and size, refuses the source host/database, requires an empty target, and restores in one transaction without `--clean` or dropping populated objects.
- Restore then runs application migrations and checks the expected migration level plus ticket-event referential integrity.
- A second target guard compares the destination against the bot's currently configured `DATABASE_URL` and `DATABASE_URL_UNPOOLED` before any process-local environment switch. Malformed configured URLs fail closed; credentials are never printed.
- Utilities and guard validations are implemented. No authorized isolated Neon backup/restore drill has been performed, so operational recoverability remains **unverified**.

### 4. Ticket metrics, SLA and CSAT
- Persistent SLA policies support guild-wide and department/priority-specific scope, first-response and resolution targets, a warning ratio, and pause-while-pending behaviour.
- Resolution timing starts a new cycle after reopen. Alert records are de-duplicated by ticket/policy/target/severity/policy version/lifecycle cycle. Large-guild scans rotate a bounded cursor; SLA policies are deactivated rather than physically deleted so alert history remains.
- The supervised SLA worker reports through Stage 2's operational task telemetry. A sweep with per-ticket evaluation failures is recorded as failed rather than falsely healthy, while processing continues for other guilds and durable successful alerts remain deduplicated.
- `/supportforge diagnostics sla-list`, `sla-set`, `sla-delete`, `sla-check`, and `metrics` expose administration and ticket/aggregate reporting. The optional `/supportforge feedback rate` flow and aggregate `feedback summary` use per-ticket/user duplicate-vote protection.
- Automated calculations and schema tests are present. Live timing, load, permissions and alert delivery in a real Discord test guild remain unverified.

### Recovery segment ledger — current increment

- Added an isolated-restore guard preventing a restore from targeting either active database URL.
- Corrected SLA worker telemetry so partial ticket failures cannot appear as a successful sweep.
- Added PostgreSQL migration 13 for durable per-segment send intent and reconciliation.
- Expanded `db:verify` to require the new ledger table.
- Added a PostgreSQL integration test for pending/completed segment state and stored Discord message identity, plus pure marker tests covering determinism and extraction.
- CI must pass on this exact branch head before the increment is considered automated-verified.

## Automated evidence and Stage 1/2 re-audit

### Latest exact-head evidence

- Stage 3: [CI #2389](https://github.com/Annant2122011/supportforge/actions/runs/40053953590) for `f16b73dac24e5885875d632db959f9f0e012c071`, build passed, **194/194 tests**, zero skipped, disposable PostgreSQL verification passed.

| Acceptance gate | Result |
|---|---|
| Source and tests for recovery preview, replay markers, backup/restore safeguards, SLA, CSAT and durable segment ledger | Implemented; latest CI passed on head f16b73d |
| Build/test against disposable PostgreSQL | **PASS**: CI #2389, 194 tests, zero skipped; DB schema/integrity verification passed |
| Live Discord deletion/recovery/permissions/429/restart scenarios | **Blocked / not run** |
| Isolated Neon backup and restore, including checksum/schema/row-count/application smoke test | **Blocked / not run** |
| Real SLA alert timing and large-guild throughput | **Blocked / not run** |
| Production acceptance | **Not accepted** |

## Remaining risk-based work
1. Run the non-production Discord acceptance checklist for native deletion, accidental/intentional ticket-button deletion, concurrent restore clicks, restore restart windows, long histories, missing members/channels and unavailable attachments.
2. Create a backup from a disposable source, restore it into a newly created empty Neon branch/database, then record checksum, schema migration level, core row counts, orphan checks and application smoke-test evidence.
3. Exercise SLA cursor rotation over multiple batches, pause/resume across pending/reopen cycles, concurrent policy edits, repeated worker failures and notification rate limits in CI/test guild.
4. Stress backup file size, restore duration, archive volume and operational metrics on a disposable environment.
5. Continue Stage H2 locale completion for the remaining Settings pages, panel previews and selected reports under the Stage 1/2 release gate.

**Release rule:** green CI, a valid dump file and an empty-target restore script are not proof of an actual Neon restore drill. Report source review, CI, test-guild acceptance, database restore and deployment as separate outcomes.


## Combined Stage 3 + Stage 4 tree verification — 2026-10-24

The Stage 3 reliability changes were integrated into the Stage 4 branch without replacing either stage's migration work. The merged migration set contains IDs 1–15, including migration 13 for recovery replay segments, migration 14 for Knowledge Base/quick replies, and migration 15 for related-ticket links. The combined head `deda4ffb5ef58f60db3fc00cb52103329d78d161` passed [ResolvX CI #2514](https://github.com/Annant2122011/supportforge/actions/runs/40084718577): **200/200 tests**, zero skipped, plus build and disposable PostgreSQL verification. The verifier confirmed recovery segments, Knowledge Base, quick-reply, related-link tables and zero orphan/stale lease records in the disposable database.

**Still blocked:** an authorized non-production Discord recovery test and a real restore of a verified backup into an isolated non-production Neon target. These are release gates, not things CI can simulate by waving a green checkmark at PostgreSQL.
