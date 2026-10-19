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

## Stage E — Custom ticket panels and Settings dashboard builder

**Code status: broad self-service baseline implemented; live Discord acceptance still required.**

The earlier single-panel-only model has been extended in this branch into two separate, server-configurable builders.

### Public ticket panel builder

- Multiple panel definitions persist in the existing Neon-backed guild configuration document; no SQL migration or database reset is required.
- Button-driven builder: **Settings → Ticket Panels**. Slash-command fallback: `/supportforge panel create/list/show/update/preview/publish/delete`.
- A guided UI can create an empty draft, add department/form buttons one at a time, edit button labels/emoji/style/confirmation, change a button target, reorder/remove controls, assign allowed roles at the panel and button level, preview, publish and delete with explicit confirmation.
- Branding includes panel name, title, instructions, footer, accent, author icon URL, thumbnail URL and banner image URL.
- Button targets: department ticket flow with an optional fixed tag (or a tag picker), or a specific active ticket form pinned to a concrete tag and form version.
- Button launch reuses the existing validated ticket/form flow. No separate ticket-creation implementation was introduced.
- Every public button is tied to the exact published channel/message and a stable per-button ID. A target change rotates the ID. Copied, stale and prior-revision buttons are rejected.
- Role rules at panel and button level are combined. Manage Server/Administrator bypasses role restrictions; other members must meet the configured role rule at each restricted level.
- Optional confirmation prompts are ephemeral, bound to the initiating user and source public message, and checked again on click before starting the validated target flow.
- Draft and published configuration are separate. Editing a draft does not reinterpret a button already displayed to customers.
- Publishing sends a replacement message, saves the new published snapshot/pointer, then tries to retire the previous message. If the database write fails, the replacement is removed where possible so the old panel remains the current published version. A stale orphan after a cleanup failure is rejected by the runtime route.
- Panel deletion removes only the panel definition and known published message, never tickets created from that panel.
- Discord's constraints are enforced: at most 25 buttons; the private preview reserves one of five rows for navigation and displays the first 20 buttons when needed; the published panel can use all 25.

### Settings channel dashboard builder

- The Settings dashboard has independent per-server title, description and footer.
- Administrators can reorder its navigation buttons and customize each button's label and emoji using the visual **Settings Layout** editor.
- A private disabled-control preview is available.
- Every built-in control remains in the dashboard. Customization cannot remove or hide repair, refresh, or Delete Everything, nor change semantic button styles such as the destructive reset style.
- Settings presentation is stored in the existing Neon-backed advanced-settings JSON document, with defaults and validation for older saved configurations; no SQL migration is needed.

### Remaining scope and reliability boundaries

- Button target types are department and specific active ticket form. A future pluggable workflow registry (arbitrary admin-defined business workflows) is not part of this Stage E slice.
- Icons are provided as validated image URLs rather than uploads. Published panels remain constrained by Discord's five-row/25-component grid.
- Discord message sends and Neon writes cannot be one atomic transaction. Publication compensates on persistence failure and rejects stale buttons, but a failed Discord cleanup can leave a visible, nonfunctional old message that an administrator may need to remove.
- A CI pass does not prove actual permissions, message visibility, role-select UX, Discord rate-limit behavior or every interruption case. Those need the live acceptance checklist below.

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
