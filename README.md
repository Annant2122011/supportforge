# ResolveX

ResolveX is a Discord-first support ticket system. It uses Neon PostgreSQL as the live durable store and keeps Discord interactions on the same validated ticket-creation and lifecycle services regardless of whether the action starts from a slash command or a button.

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

The Build and SupportForge CI workflows run the TypeScript build, automated tests, and database verification. Keep PR #12 open until its final checks pass and live acceptance has been completed. Deploy to a test guild and non-production bot first. Do not merge or deploy a production build solely because a CI workflow is green.

- [Stage A–E inspection](docs/stages-a-to-e-audit.md)
- [Ticket archive and recovery behavior](docs/recovery-archive.md)
- [Slash-command and button parity](docs/interaction-parity.md)
- [Restore and deployment guide](docs/restore-and-deploy.md)
