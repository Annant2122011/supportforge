# ResolveX

ResolveX is a Discord-first support ticket system. It uses Neon PostgreSQL as the live durable store and keeps Discord interactions on the same validated ticket-creation and lifecycle services regardless of whether the action starts from a slash command or a button.

## Current capabilities

- Ticket creation, assignment/claiming, priority, participants, notes, lifecycle state and audit history.
- Neon/PostgreSQL ticket repositories, migrations, transactional domain events and a durable retrying outbox.
- Versioned ticket forms, conditional fields across steps, answer validation and reusable form templates.
- Multiple custom support panels with ordered department buttons, theme/accent and image options, private draft preview, publish/update and confirmed delete.
- Ticket message archives and recovery workflows for supported Discord channel/ticket deletion cases.
- Settings dashboard with server-specific themes and button-based configuration flows.
- GitHub Actions CI plus an optional server-side systemd self-update watchdog.

Some roadmap areas remain partial. In particular, custom panel buttons currently target existing ticket departments rather than arbitrary named workflows, and live acceptance in a Discord test server is still required before treating A–E as production-complete. See [the Stage A–E audit](docs/stages-a-to-e-audit.md) and [FEATURES.md](FEATURES.md).

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

## Build a custom support panel

The administrator UI is available from **SupportForge Settings → Custom Panels** after setup/refresh. It provides draft creation, panel selection, private preview, draft editing, channel selection for publishing, and a two-step delete confirmation.

The equivalent slash-command flow is:

- `/supportforge panel create`: create a draft with a name, title, description, and ordered `buttons-json` array.
- `/supportforge panel list` and `show`: find and inspect panel IDs and routing targets.
- `/supportforge panel update`: change content or replace/reorder the ordered buttons array.
- `/supportforge panel preview`: display a private preview with disabled ticket controls.
- `/supportforge panel publish`: publish/update the panel in a standard text channel.
- `/supportforge panel delete`: remove a panel only after explicit confirmation.

Example button schema (replace the department IDs with IDs from your own server):

```json
[
  { "departmentId": "billing", "label": "Billing Support", "emoji": "💳", "style": "primary" },
  { "departmentId": "technical", "label": "Technical Help", "emoji": "🛠️", "style": "success" }
]
```

Allowed button styles are `primary`, `secondary`, and `success`. Each target department must already exist. Button order follows array order. Published buttons reuse the standard validated `ticket:create:<departmentId>` flow; previews disable the controls. Deleting a panel never deletes tickets already created from it.

## Verification and rollout

The Build and SupportForge CI workflows run the TypeScript build, automated tests, and database verification. Keep PR #12 open until its final checks pass and live acceptance has been completed. Deploy to a test guild and non-production bot first. Do not merge or deploy a production build solely because a CI workflow is green.

- [Stage A–E inspection](docs/stages-a-to-e-audit.md)
- [Ticket archive and recovery behavior](docs/recovery-archive.md)
- [Slash-command and button parity](docs/interaction-parity.md)
- [Restore and deployment guide](docs/restore-and-deploy.md)
