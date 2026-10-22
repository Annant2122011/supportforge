# ResolvX Stage A–E Inspection and Completion Record

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

## Stage E — Custom ticket panels and Settings dashboard builder

**Code status: administrator-facing builders implemented; live Discord acceptance pending.**

Stage E now includes separate visual builders for the public ticket panels and the server's private Settings dashboard.

### Public ticket panels

- Multiple panel definitions live in the existing Neon-backed guild configuration JSON document. There is no SQL migration for panel setup and no database reset.
- **Settings → Ticket Panels** provides guided creation of empty drafts, button building, target changes, label/emoji/style/confirmation editing, role restrictions, reordering, private preview, channel selection, safe publishing and confirmed deletion. Slash commands are also available: `/supportforge panel create/list/show/update/preview/publish/delete`.
- When adding a department button, admins choose a fixed tag or customer-selected tag from a paginated visual picker. They do not need to copy tag IDs into a form.
- Draft metadata includes title/instructions/footer, accent, author icon URL, thumbnail/banner URLs, and 1–25 ordered buttons.
- Targets are existing departments (with optional fixed tag or customer tag choice) or a specific active ticket form pinned to a concrete tag/version.
- Button access rules can be set at panel and individual button level. If both levels are restricted, a member must satisfy both. Admins with Manage Server/Administrator can use the panel.
- Optional confirmation prompts are ephemeral, identify their initiating user, and bind to the source published message. The runtime validates the public message/channel and role access when clicked; confirmation clicks are also revalidated, and the Cancel button remains usable even if the source panel becomes unavailable during confirmation.
- Published configuration is stored as a snapshot separately from the editable draft. Button IDs rotate on workflow retargeting; stale or copied component IDs are rejected. Panel definitions from older builder revisions that lack a published snapshot must be re-published once before their old buttons become active again; the detail view indicates that the draft needs publishing.
- Publishing creates a replacement message, persists its channel/message pointer and immutable button snapshot, and only then tries to remove the old message. When persistence fails, ResolvX restores the previous published pointer/snapshot in configuration, then attempts to remove the unregistered replacement and retain the previous panel. When Discord fails to delete an old message, the panel interaction guard makes that stale message nonfunctional and the UI warns the administrator.
- Removing a panel removes only the definition and known public panel message; ticket channels opened through that panel remain independent.
- Discord's five-row/25-component ceiling is respected. The private preview uses at most 20 buttons when it needs a navigation row; a published panel may use all 25.

### Settings dashboard builder

- **Settings → Settings Layout** customizes the Settings-channel title, description, footer, navigation order, individual control labels and emojis.
- Per-server values use the existing Neon-backed advanced-settings document; there is no SQL migration.
- Preview buttons are disabled, all built-in controls remain present, and semantic styles cannot be customized away: repair, refresh and Delete Everything remain available, with the destructive control retaining its danger style.
- The Settings dashboard customization is separate from public ticket panels, so an admin can change one without changing the other.

### Remaining boundary

The current workflow catalog supports department ticket creation and specific active ticket forms. A future pluggable workflow registry for arbitrary customer journeys is outside this Stage E implementation slice. Icons are public image URLs rather than uploaded files, and Discord messages still use a 5-row button grid instead of a freeform canvas. Publish cannot be a single atomic transaction across Discord and Neon; it uses a send-save-cleanup sequence with compensating cleanup and stale-button rejection.

Live acceptance is still required for actual role/permission behavior, public channel visibility, form routing, confirmation clicks, repeated publication, cleanup failures and server restarts. CI cannot prove these Discord-host-specific conditions.

## Automated verification

The current branch head was built and tested by GitHub Actions on commit `fdcc08526726330ffdca771c4a50ab1cc6ad6373`:

- [Build run 39187857351](https://github.com/Annant2122011/supportforge/actions/runs/39187857351) passed the TypeScript build and automated tests.
- [ResolvX CI run 39187857407](https://github.com/Annant2122011/supportforge/actions/runs/39187857407) passed build, tests and database verification.

Those runs include the custom-panel interaction-ID parser tests, Settings-button customization tests, target editor, visual department-tag picker, and user/source-bound confirmation handling. CI used disposable test data, not production Neon. Live acceptance remains outstanding.

## Required live acceptance checklist

- [ ] Deploy only to a non-production/test bot and test guild first.
- [ ] Check button and slash-command permissions independently.
- [ ] Verify ticket create/claim/close/reopen/archive and form submission.
- [ ] Test native channel deletion separately from Delete Ticket button confirmation/review.
- [ ] Test interrupted recovery and repeated retry without losing saved archives.
- [ ] Create two custom panels, preview both, publish them to separate channels, update/reorder buttons, republish, and delete one while confirming existing tickets remain.
- [ ] Add department buttons using both the "customer chooses a tag" option and a pinned tag selected from the dropdown; test a department with more than 24 tags to verify paging.
- [ ] Add a specific active form button, test wildcard-form tag selection, edit/retarget the button, then re-publish. Confirm that changed/deactivated form versions produce a clear repair path rather than silently switching schemas.
- [ ] Configure panel-level and button-level role rules, and test allowed, disallowed, admin-bypass, confirmation Continue, confirmation Cancel, and a stale/copied button interaction.
- [ ] Simulate Neon persistence failure during publish in a controlled test environment and confirm the old published panel pointer remains current and the unregistered replacement message is removed where possible.
- [ ] Reorder Settings controls; edit several labels/emojis (including clearing an emoji); preview the disabled layout; reset layout; confirm all controls remain and Delete Everything retains danger styling.
- [ ] Verify the intended Neon project, backups, migrations, and restore drill.
- [ ] Review deployment secrets and host watchdog configuration before deployment.

## Completion rule

Do not mark Stages A–E as 100% complete until automated checks remain green on the final code commit **and** the live acceptance checklist has been executed successfully in a controlled Discord environment. No merge or production deployment is implied by this record.
