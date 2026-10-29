# QueryFixr / SupportForge repository audit — 29 October 2026

**Review scope:** current consolidated Stage A–K baseline plus the Stage L implementation branch  
**Implementation PR:** [#43 — Stage L: durable QueryFixr SLA, queue and escalation operations](https://github.com/Annant2122011/supportforge/pull/43)  
**Production data store:** Neon PostgreSQL  
**Audit status:** remediation in progress; release acceptance is not yet complete

This report records repository issues confirmed during the current source review. It is not a claim that every line has received a formal security review. The repository has substantial existing functionality, and source presence alone is not treated as proof that a feature works against a real Discord guild or a restored database.

## Executive findings

The most important issues were reliability and truthfulness problems rather than cosmetic defects:

1. New inactivity warnings and destructive reset prompts were not consistently branded QueryFixr.
2. The first-response SLA path could treat a non-owner human message as a support reply without proving staff attribution.
3. SLA policies had mutable version numbers but did not consistently preserve an immutable snapshot for each change, including retirement.
4. The monitor cursor was held in process memory, so restarts could repeat/skip parts of a large ticket queue.
5. SLA notifications needed explicit durable delivery state, controlled retry, and a way to reconcile the case where Discord accepts a message but the database receipt write times out.
6. Historical alerts needed to be kept from being replayed as new alerts on first deployment of receipt tracking.
7. Business-hours SLA timing, Settings/button parity for Stage L, and an actual PostgreSQL smoke test for the new operational tables were missing from the baseline.
8. The first attempts to integrate the new Settings controls had TypeScript errors. CI surfaced these. Those errors were corrected and CI is being rerun on the latest PR head.

## Findings by severity

### High — misleading or unsafe operations

- **First-response attribution was too permissive.** The former query could infer a reply from any non-bot, non-owner archive message. That can include another customer or an unknown participant. The Stage L path now requires a durable message event with `messageAuthorType='staff'` before counting a response. If the archive/backfill or attribution evidence is incomplete, the clock is reported as unknown instead of guessing a breach.
- **Policy history was not fully immutable.** Updates and deactivation need a policy snapshot in the same transaction as the row mutation. Stage L writes a policy-version snapshot atomically on both save and retirement and backfills a baseline snapshot for existing policies.
- **SLA monitor progress was process-local.** The old in-memory cursor did not survive restart and had no shared-worker lease. Stage L stores a per-guild cursor and lease in PostgreSQL, advances the cursor only after a successful ticket evaluation, and releases the lease on completion/failure.
- **Alert delivery needed a proper durable lifecycle.** Stage L persists alert intent, attempts, error and retry time, a Discord message ID and delivery timestamp. Receipt markers allow a later sweep to reconcile an accepted Discord send if the subsequent database acknowledgement failed. A unique logical alert key prevents a second alert record.
- **Legacy alerts must not suddenly notify staff.** Migration 22 gives pre-existing alerts a `legacy` delivery status and only new alert intents start as `pending`. This avoids replaying an old alert backlog when a server first configures an SLA notification route.
- **Escalations must not repeat or use stale previews.** The preview records its guild, ticket, lifecycle cycle, policy ID/version and expiry. Sending atomically claims the preview once, rechecks live state, only sends an allowlisted supervisor/channel notice, and stores receipt/error state. Automatic reassignment and priority mutation remain disabled.
- **Factory-reset wording must match the accepted confirmation.** Runtime validation and user-facing English/Hindi/Bengali strings now use exactly `DELETE QUERYFIXR`; the slash-command input length is 16 characters to match that token. Old persisted inactivity markers remain readable, but new warnings use QueryFixr branding.

### High — Stage L operations and verification

- **Business-hours targets were absent.** Stage L now has an explicit business-hours mode using the existing support-hours timezone/DST interval engine. Pending time is subtracted only where it overlaps scheduled business time. Missing or disabled support-hours policy fails visibly rather than manufacturing a zero or elapsed-time result.
- **Queue snapshots needed durability and bounded storage.** Stage L saves guild-scoped queue snapshots including priority, age, status, department and assignment metadata. The queue order prioritizes severity and then age. Retention is bounded to the most recent 500 snapshots per guild.
- **Settings did not offer useful Stage L operations.** The dashboard now exposes policy list/create/edit/deactivate, queue view, ticket SLA evaluation, route configuration/disable, alert history/acknowledgement and escalation preview/send. Form actions call the same validated service methods used by slash commands.
- **Database verification was schema-light for Stage L.** The PostgreSQL verifier now checks the new tables/columns and executes rollback-safe SQL smoke tests for policy versions, duplicate alert suppression, monitor cursor/lease, guild isolation, queue snapshots and one-time escalation claims. This is not a substitute for an isolated restore drill using a backup.
- **Settings action auditing was incomplete.** The current branch records route disable, policy retirement, preview creation, acknowledgement, and escalation success/failure in the settings audit stream where the guild has an audit destination.

### Medium — UX and operational diagnostics

- **A branded warning should not be duplicated after an upgrade.** New warnings have QueryFixr markers and old ResolveX marker matching is retained for recovery/cancellation. This is intentional compatibility, not visible new branding.
- **Unknown historical response data must remain obvious.** Command and Settings SLA views show first response as unknown when the archive cannot support a reliable measure. This is more honest than displaying a fabricated “met” or “breached” status.
- **Queue and alert views need understandable states.** The Settings views show policy version, clock mode, pause mode, target values, notification route, delivery state, acknowledgement and preview expiry; empty states and failure messages are supplied through the strict locale keys.
- **Custom Settings layouts have to know about the new button.** The SLA section is registered in the configurable dashboard key set and now has a layout label and default emoji. Without those values, TypeScript correctly failed the build.
- **CI must be run on the exact head.** An initial Stage L build exposed a bad client reference and missing Settings layout mappings. These source errors were corrected. Do not interpret an earlier green baseline or an in-progress workflow as a pass for a later commit.

### Low / maintenance notes

- Search indexes may continue returning old wording after the source blob is corrected. Check the current branch file/commit rather than relying on an indexed snippet.
- Legacy brand mentions in migration, message-recognition and compatibility code can be intentional. They should only remain where needed to recognize previously stored messages/settings or historical evidence. Newly emitted user-facing text, errors and operational logs should say QueryFixr.
- The install workflow reports two high-severity npm audit findings in the observed CI logs. This audit did not apply a blind dependency-wide upgrade because dependency changes need their own lockfile, compatibility and test review. This remains a follow-up security item.

## Stage L changes in PR #43

- Additive PostgreSQL migration 22; prior migration IDs are unchanged.
- Immutable policy-version history and a baseline backfill.
- Wall-clock and business-hours SLA clocks for first response, staff claim and resolution.
- Durable monitor cursor/lease and retryable alert delivery receipts.
- Explicit notification-route configuration, alert list and acknowledgement.
- Persisted queue snapshots with bounded per-guild retention.
- One-shot escalation previews with policy/lifecycle checks and message-receipt reconciliation.
- Slash commands and Settings controls for the same operational service layer.
- English, Hindi and Bengali copy for the new Settings views.
- PostgreSQL verification coverage for Stage L tables and critical SQL shapes.

## Items still requiring acceptance

The following are release gates, not work that can truthfully be declared passed from editing source files:

1. **Exact-head GitHub Actions:** TypeScript build, unit tests and disposable-PostgreSQL verification must pass after the final branch commit. Some checks on earlier commits failed; they are not evidence for the latest head.
2. **Controlled Discord acceptance:** use a disposable test guild to exercise policy create/edit/disable, support-hour clock behavior, private permissions, route delivery, alert acknowledgement, stale/expired preview rejection and repeated send attempts.
3. **Isolated Neon restore drill:** restore a verified backup into a new, empty non-production Neon branch/database, record checksum/migration level/row counts/orphan checks and complete an application smoke test. Do not run this drill against production.
4. **Dependency vulnerability review:** resolve the two high-severity npm audit findings after inspecting the advisories and compatibility impact. Do not apply an unreviewed major upgrade simply to make the warning disappear.
5. **Known scope boundary:** business-hour SLA currently uses the configured weekly schedule and timezone; holidays and exceptional closures are explicitly outside the initial calendar model. Supervisor notification is the only escalation action; automated reassignment and priority change are intentionally not enabled.

## Release decision

**Do not merge or deploy solely on the basis of this document.** The branch is proposed in PR #43. Code status becomes complete only after exact-head CI passes; release status also needs the controlled Discord acceptance and isolated Neon restore record. Neon PostgreSQL remains authoritative and no SQLite production migration is proposed.
