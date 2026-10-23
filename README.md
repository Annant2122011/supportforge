# ResolvX

ResolvX is a Discord-first support ticket system. It uses Neon PostgreSQL as the live durable store and keeps Discord interactions on the same validated ticket-creation and lifecycle services regardless of whether the action starts from a slash command or a button.

## Current capabilities

- Ticket creation, assignment/claiming, priority, participants, notes, lifecycle state and audit history.
- Neon/PostgreSQL ticket repositories, migrations, transactional domain events and a durable retrying outbox.
- Versioned ticket forms, conditional fields across steps, answer validation and reusable form templates.
- Multiple custom ticket panels with department or form targets, ordered controls, role access, optional confirmation prompts, branding, safe publish/update and confirmed delete.
- A separate per-server Settings-channel dashboard builder for branding, navigation order, button labels and emojis, with a disabled preview that always retains recovery and reset controls.
- Ticket message archives and recovery workflows for supported Discord channel/ticket deletion cases.
- Settings dashboard with server-specific themes and button-based configuration flows.
- GitHub Actions CI plus an optional server-side systemd self-update watchdog.

Some roadmap areas remain partial: Stage E supports department and pinned-form workflows, while a general-purpose user-defined workflow graph remains future scope. Actual Discord permissions, role selects, publishing and confirmation interactions still require live test-guild acceptance before calling the product production-complete. See [the Stage A–E audit](docs/stages-a-to-e-audit.md) and [FEATURES.md](FEATURES.md).

## Product excellence programme

The four-stage improvement programme covers Stage A–H stabilization, operational diagnostics and safer administration, recovery and support operations, then the non-AI Knowledge Base and productivity features.

- [Four-stage programme architecture](docs/four-stage-excellence-programme.md)
- [Stage 1 stabilization and acceptance checklist](docs/stage-1-acceptance-checklist.md)
- [Stage 1 source audit and acceptance report](docs/stage-1-audit-and-acceptance-report.md)
- [Stage 2 administration and operational diagnostics](docs/stage-2-admin-operational-diagnostics.md)

These docs describe planned delivery and acceptance criteria, not a claim that every listed feature is already implemented or production-accepted.

## Requirements

- Node.js 22.5 or newer.
- A Discord application/bot with the required guild and channel permissions.
- A Neon PostgreSQL database. Configure the values documented in `.env.example`.
- GitHub/deployment secrets and a Linux/systemd host only if using automated server deployment.

SQLite is not an allowed live persistence provider. Legacy SQLite migration/repository files remain only for compatibility and tests. Set `SUPPORTFORGE_DATABASE_PROVIDER=postgres` (or `neon`) explicitly in production.

## Local setup

1. Clone the repository and switch to the intended branch.
2. Install dependencies:

   ```sh
   npm ci
   ```

3. Copy `.env.example` to `.env` and fill in the actual Discord and Neon credentials. Never commit `.env` or paste credentials into issues.
4. Apply PostgreSQL migrations and build:

   ```sh
   npm run db:migrate
   npm run build
   npm test
   ```

5. Register the slash commands and start the bot:

   ```sh
   npm run deploy-commands
   npm start
   ```

For development, `npm run dev` starts the TypeScript entry point directly. Do not run destructive PostgreSQL integration tests against production data; the integration suite deliberately refuses non-local database URLs.

## Build custom ticket panels

After setup, open **Settings → Ticket Panels**. This is the visual panel builder, intended for server administrators who should not have to edit source or routinely write JSON.

1. Create an empty panel draft.
2. Add buttons from existing departments or active ticket forms. The department builder includes a visual tag picker, so admins do not have to copy tag IDs.
3. Edit each button's label, emoji, style, optional tag, access roles and optional confirmation message.
4. Reorder buttons with Move Up / Move Down; preview the draft privately with disabled controls.
5. Publish to an accessible text channel. The builder stores the published snapshot before trying to remove the prior panel message.
6. Delete a panel only after confirmation. Tickets already created from that panel are retained.

The matching slash-command family is `/supportforge panel create/list/show/update/preview/publish/delete`. Commands cover panel metadata and JSON button replacement; the button-based builder is the recommended way to add, retarget and reorder individual controls. Blank drafts are valid but cannot be published until they have at least one valid button.

**Supported button target types**

A department target opens the regular department/tag ticket flow. A form target opens one specific active ticket form at the published version, pinned to a concrete tag. The target and permissions are checked again at click time. Panel and button allowed-role lists combine, and administrators can use the panel regardless of those role lists. Optional confirmation text is shown privately before opening the flow. Confirmation actions are bound to the initiating user and exact source panel message, and a changed form version requires the administrator to retarget and republish that form button.

Panel-level options include title, instructions, footer, accent color, author icon URL, thumbnail and banner image URL. Button styles are `primary`, `secondary`, `success`, and `danger`. A panel supports at most 25 buttons due to Discord's component limit. The private preview reserves the fifth row for navigation, so it shows the first 20 buttons when a draft has 21–25; published panels can use all 25.

Editing the draft does not change how the currently published panel behaves. Re-publishing saves a new published snapshot and message pointer before retiring the previous message. If a stale copy of a panel remains after a Discord cleanup failure, its interactions are rejected because they no longer originate from the currently published message. Older panel definitions created before published-snapshot tracking was added need a one-time republish from Settings → Ticket Panels; their old messages fail closed until the snapshot is registered.

## Build your server's Settings channel layout

Open **Settings → Settings Layout** from the persistent Settings dashboard. Servers can edit the Settings-channel title, description and footer, reorder navigation buttons, and customize each button's label and emoji. A private preview displays disabled controls. All built-in features remain present; repair, refresh and Delete Everything cannot be hidden, and destructive/security-relevant button styles cannot be changed by visual customization.

Settings-channel customization is stored separately from the public ticket panels, per server, in Neon-backed configuration. Changing it does not change a public ticket panel; changing a public panel does not alter the Settings-channel dashboard.

## Verification and rollout

The Build and ResolvX CI workflows run the TypeScript build, automated tests, and database verification. Keep PR #12 open until its final checks pass and live acceptance has been completed. Deploy to a test guild and non-production bot first. Do not merge or deploy a production build solely because a CI workflow is green.
The Build and SupportForge CI workflows run the TypeScript build, automated tests, and database verification. Stages A–G remain an open, stacked pull-request chain; PR #17 contains the consolidated source review and UI polish. Use a test guild and non-production bot before promotion. Do not merge or deploy a production build solely because a CI workflow is green.

- [Stage A–E inspection](docs/stages-a-to-e-audit.md)
- [Ticket archive and recovery behavior](docs/recovery-archive.md)
- [Slash-command and button parity](docs/interaction-parity.md)
- [Restore and deployment guide](docs/restore-and-deploy.md)
- [Stage A–G reverification and remaining acceptance checks](docs/stage-a-to-g-reverification.md)

## Stage F · Support hours, time zones and private-thread workspaces

Stage F is implemented on this feature branch in two increments: Part 1 provides the shared support-hours/time-zone engine, and Part 2 adds private-thread ticket workspaces and lifecycle controls. The branch still requires integration through the Stage A–E → Stage F pull-request chain and live Discord test-server acceptance before production rollout.

Support-hours policies are stored in the existing Neon-backed JSON-document repository under a separate support-hours document. This avoids coupling schedule rules to guild appearance settings and does not introduce a second database or SQL migration. Policy scopes resolve in this order: **ticket panel → department → server default**. An explicit disabled policy at a more-specific scope disables enforcement there; removing an override restores inheritance.

The Settings channel now has a **Support Hours** button with department and ticket-panel scope selectors, weekly schedule editing, timezone, enforcement, outside-hours behavior and clear-override controls. The selectors paginate when a server has more than 25 departments or panels. The equivalent slash-command group supports the same server, department and panel scopes:

- /supportforge settings support-hours action:show scope:guild
- /supportforge settings support-hours action:set-timezone scope:guild timezone:Asia/Kolkata
- /supportforge settings support-hours action:set-day scope:guild day:monday intervals:09:00-12:00,13:00-17:00
- /supportforge settings support-hours action:set-day scope:guild day:sunday intervals:closed
- /supportforge settings support-hours action:behavior scope:guild behavior:restrict
- /supportforge settings support-hours action:enable scope:guild
- /supportforge settings support-hours action:show scope:department scope-id:department-id
- /supportforge settings support-hours action:show scope:panel scope-id:panel-id

For a department or panel override, provide scope-id. Use valid IANA time-zone names, such as Asia/Kolkata or America/New_York; fixed UTC offsets are not accepted as time zones. Times use 24-hour HH:mm values. An interval can cross midnight, for example 22:00-02:00. Multiple intervals use commas. Overlapping intervals are rejected, including overlap across midnight.

When enforcement is enabled, every supported ticket-entry route checks the effective policy and final ticket submission checks it again. A blocked request receives a closed-hours notice and the next opening time when one can be calculated. Existing tickets and administrator actions are not disabled. Panels stay published when support is closed. Policy mutations and blocked intake are audited.

The schedule engine handles daylight-saving gaps and repeated local times deterministically, uses the same calculation path for status and next-opening time, and is covered by fake-time/unit tests. Live Discord acceptance testing is still required before production rollout. See [Stage F Part 1 architecture and acceptance notes](docs/stage-f-part-1-support-hours.md).

### Part 2: private-thread ticket workspaces

Select the workspace mode using **Settings → Ticket Workspace** or `/supportforge settings ticket-workspace`. It applies only to newly opened tickets. Existing dedicated text-channel tickets remain unchanged. In private-thread mode, ResolveX lazily creates a department-specific parent text channel and opens each new ticket as a private thread under it. The ticket owner is explicitly added; configured department staff and administrators can access tickets through Discord's private-thread permissions. The bot needs permission to view the parent, create/manage private threads, send messages in threads, and read message history. Each department should have a valid staff role configured before enabling this mode.

The private-thread controls support the normal ticket lifecycle (claim, unclaim, pending, resume, close, reopen and archive), along with participant add/remove, staff reassignment, priority, internal notes and staff history. The matching slash-command routes are available inside the private thread as well as the button controls. User-selection actions are bound to the initiating user and exact thread so stale or cross-thread controls fail closed.

Ticket and message metadata are stored using the existing Neon/PostgreSQL persistence and archive services. Confirmed deletion performs durable archival first and requires two confirmations; the deletion-review workflow remains available for accidental deletion recovery. The bot cannot recreate the original Discord channel ID or impersonate historical authors, so recovered messages retain the original channel/user attribution as metadata rather than pretending to be original Discord messages.

Private-thread policy tests verify lifecycle controls and that unknown persisted lifecycle values fail closed. The support-hours engine remains shared by both text-channel and private-thread intake paths. Live server acceptance is still required for real channel/thread creation, staff/owner access, permission changes, closure/reopening, deletion recovery and slash-command registration. See [Stage F Part 2 private-thread architecture and acceptance notes](docs/stage-f-part-2-private-threads.md).


## Stage G · Part 1: permission and close-lifecycle hardening

Stage G Part 1 centralizes ticket lifecycle authorization, makes closed/archived text tickets read-only, and hardens private-thread close/reopen ordering with durable outbox reconciliation. See [Stage G Part 1 architecture and acceptance notes](docs/stage-g-part-1-permissions-close.md). Stage G Part 2 is reserved for inactivity warnings and restart-safe automated closure; no inactivity auto-close runs as part of Part 1.


## Stage G Part 2: Ticket inactivity automation

Stage G Part 2 adds opt-in, per-server inactivity warnings and automatic closure with a grace period. It uses durable PostgreSQL activity metadata, recovers warning state after restarts, requires transcript delivery, and atomically rejects closure if activity changes. The default is disabled; administrators can manage it with the Settings dashboard's **Inactivity Automation** controls or `/supportforge settings inactivity`. See [the Stage G Part 2 design and acceptance checklist](docs/stage-g-part-2-inactivity.md).
