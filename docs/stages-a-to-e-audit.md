# ResolveX Stage A–E Inspection and Completion Record

**Inspection date:** 18 October 2026  
**Branch inspected:** `feature/forms-settings-panel`  
**Persistence requirement:** Neon PostgreSQL remains the live source of truth. SQLite is not an allowed live provider.  
**Deployment safety:** No merge to `main` and no production deployment was performed.

## Executive status

Stages A–D have substantial implementation in the branch and relevant automated coverage. Stage E previously lacked multiple configurable public panels; a first usable custom multi-panel builder has now been implemented with both slash-command and Settings-button entry points. This is not a claim that all A–E work is production-complete: live Discord acceptance and a production-Neon rollout remain external verification steps.

## Stage A — Reliability, audit and interaction safety

**Code status: implemented foundation; live acceptance pending.**

Reviewed implementation includes the shared ticket lifecycle transition policy, repository-level transition assertions, ticket creation leases for duplicate-create races, defensive form/component routing, conservative user-supplied regex validation, server-side answer validation, PostgreSQL transaction boundaries, bounded retry handling, and actor attribution in durable audit/event records.

Checks found:
- Ticket lifecycle transitions are checked in both the PostgreSQL repository and the legacy repository implementation.
- The active runtime provider defaults to PostgreSQL and rejects `SUPPORTFORGE_DATABASE_PROVIDER=sqlite` rather than silently falling back.
- Ticket forms validate submitted values on the server rather than trusting the modal.
- Discord interaction timing, permissions in the target server, and real REST partial-failure/rate-limit behavior cannot be established from a source inspection alone.

Remaining acceptance: exercise key actions under a real test guild, including insufficient permissions, stale interactions, rate limits, and partial Discord REST failures.

## Stage B — Neon persistence, domain records and repositories

**Code status: implemented foundation; production Neon rollout not verified.**

Reviewed implementation includes the PostgreSQL migration runner, PostgreSQL ticket/event/JSON-document repositories, transactional ticket state and metadata updates, durable ticket records, and a database-backed guild configuration document. The provider tests cover the default and explicit Neon/PostgreSQL aliases and assert that SQLite cannot become the live persistence provider.

The code still contains legacy SQLite repository and migration tooling for compatibility/testing. That tooling is not a live-runtime fallback: provider selection rejects SQLite. Do not run the legacy SQLite migration script as part of normal deployment.

Remaining acceptance: confirm required environment variables and credentials against the intended Neon project, run the deployment migration safely against that database, verify the backup/restore process, and confirm the production data is intact. CI's disposable database verification is not proof that the production Neon project was migrated.

## Stage C — Ticket state machine, durable metadata, domain events and outbox

**Code status: implemented foundation with automated transaction/retry coverage; live fault-injection pending.**

Reviewed implementation includes explicit ticket status transitions, PostgreSQL transactions that commit ticket changes together with event history and outbox intents, atomic outbox claims using `FOR UPDATE SKIP LOCKED`, retry-after-aware backoff, stale-processing recovery, and durable event publication/reconciliation. Invalid status transitions are asserted before persistence changes.

Delivery is at-least-once by design. A worker may restart after a Discord side effect but before saving its completion marker; publishers must reconcile against durable state and use stable event identities. This is not the same as exactly-once external delivery.

Remaining acceptance: simulate a worker restart during publish, a Discord 429 with a long Retry-After, a missing channel, a permission failure, and a PostgreSQL interruption. Verify that events remain diagnosable and retries do not corrupt ticket state.

## Stage D — Advanced ticket forms

**Code status: substantial feature implementation and unit coverage; real-guild acceptance pending.**

Reviewed implementation includes immutable/versioned form schemas, Neon-backed form definitions and submission snapshots, creation leases, active form routing cache, multi-step forms, conditional visibility based on earlier steps, reusable templates, guided creation and advanced-schema authoring paths, and server-side field validation. Current limits are explicit in code: up to 25 custom fields, at most three custom fields per step, and up to ten steps, leaving space in step one for the normal subject/description fields. Conditional fields must depend on earlier steps.

Automated tests cover schema and answer validation, conditional visibility, empty multi-select answers, validation of injected answers for hidden fields, and other unsafe/malformed input cases.

Remaining acceptance: exercise every supported field type in Discord, test an expired or stale modal, update a form while a user is mid-flow, attach real supported files, and verify submissions recover/link correctly after ticket-channel creation fails.

## Stage E — Multiple custom panels, live preview and Start Ticket

**Code status: implemented baseline; richer F-002 features remain partial.**

The previous single-panel-only model was not sufficient for the roadmap. This branch now adds:

- Multiple panel definitions persisted in the existing Neon-backed guild configuration document, with legacy configs normalized safely.
- Slash-command management: `/supportforge panel create/list/show/update/preview/publish/delete`.
- A **Settings → Custom Panels** button flow to create drafts, select saved panels, preview, edit, choose a publish channel, and confirm deletion.
- Configurable title, description, footer, optional six-digit accent color, optional thumbnail/banner URLs, and 1–25 ordered buttons.
- Server-side validation that every button targets an existing department, with supported button styles and optional emoji.
- A private preview with disabled buttons; publishing activates the buttons.
- Stable reuse of `ticket:create:<departmentId>`, so all custom panel buttons enter the same validated ticket-creation flow as the standard panel.
- Persisted published channel/message IDs; republishing edits the existing message when possible and attempts to remove the previous message after moving a panel.
- Explicit deletion confirmation. Deleting a panel removes its definition and known panel message, but never deletes the tickets created from it.
- The Settings-panel preview limits visible preview controls to 20 when a draft has 21–25 buttons, reserving a row for navigation within Discord's five-row message limit. Publishing includes all configured buttons.
- Deleting a panel definition remains possible if the panel's Discord channel was deleted beforehand; the cleanup treats a missing channel/message as already removed and still removes the definition.

Remaining F-002 scope: arbitrary named workflows (rather than department-only targets), panel-level permission rules, optional workflow confirmation messages, a custom icon, richer ordering controls beyond supplying the ordered JSON list, and live Discord acceptance. Publishing to another channel is an external Discord/database sequence, not an atomic transaction. If message publication succeeds but Neon persistence fails, an orphaned message may need manual cleanup.

## Automated verification

The final custom-panel code and tests passed both GitHub workflows on commit `201f615df3216183f6e0f1698e25c50183ceabf9`:

- [Build workflow run 39151203369](https://github.com/Annant2122011/supportforge/actions/runs/39151203369)
- [SupportForge CI run 39151203413](https://github.com/Annant2122011/supportforge/actions/runs/39151203413)

The Build job completed the TypeScript build and automated tests. SupportForge CI completed build, tests, and database verification. The verified code includes the Stage E settings-button branding editor, the 25-button/five-row regression test, safe cleanup when a published panel's channel has already been deleted, and the custom panel manager. Later commits that update this audit and feature status are documentation-only.

## Required live acceptance checklist

- [ ] Deploy only to a non-production/test bot and test guild first.
- [ ] Check button and slash-command permissions independently.
- [ ] Verify ticket create/claim/close/reopen/archive and form submission.
- [ ] Test native channel deletion separately from Delete Ticket button confirmation/review.
- [ ] Test interrupted recovery and repeated retry without losing saved archives.
- [ ] Create two custom panels, preview both, publish them to separate channels, update/reorder buttons, republish, and delete one while confirming existing tickets remain.
- [ ] Verify the intended Neon project, backups, migrations, and restore drill.
- [ ] Review deployment secrets and host watchdog configuration before deployment.

## Completion rule

Do not mark Stages A–E as 100% complete until automated checks remain green on the final code commit **and** the live acceptance checklist has been executed successfully in a controlled Discord environment. No merge or production deployment is implied by this record.
