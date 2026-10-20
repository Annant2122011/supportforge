# Restore & Update

SupportForge has two related but separate recovery jobs:

1. **Discord infrastructure recovery** runs from the existing Neon PostgreSQL-backed configuration and ticket records. It recreates missing managed core categories/channels where possible, reconciles the support/settings/audit/transcript panels, repairs department categories based on both live ticket channels and durable ticket rows, and recovers ticket records from surviving channel metadata.
2. **Code deployment** runs in GitHub Actions, not inside the Discord bot process. The bot requests the deployment workflow using a repository-scoped GitHub token. Pushes to `main` also trigger the same workflow automatically.

The combined **Settings → Repair System → Restore & Update** button performs the Discord recovery and then requests deployment. The slash command `/supportforge restore` does the same. Ordinary Normal Repair remains available without restarting the application.

## Required GitHub Actions repository secrets

This workflow targets an existing Linux server running SupportForge as a systemd service. Add these repository secrets under **Settings → Secrets and variables → Actions**:

- `DEPLOY_HOST`: server hostname or IP
- `DEPLOY_USER`: SSH account used for deployment
- `DEPLOY_SSH_KEY`: private key for that account
- `DEPLOY_KNOWN_HOSTS`: verified SSH host-key line(s) for the server (do not blindly trust an unverified `ssh-keyscan` result)
- `DEPLOY_PATH`: path to the existing SupportForge Git clone on the server
- `DEPLOY_SERVICE_NAME`: systemd unit name for the bot
- `DEPLOY_PORT`: optional SSH port; defaults to 22

The deployment account must be able to fetch the repository, run Node/npm and the database migration/verification scripts, and restart the configured systemd service with `sudo`. Restrict its sudo rules to the specific service where possible. Keep the server's `.env` outside Git tracking and preserve the Neon connection variables.

## Enable the one-click trigger inside Discord

Set `GITHUB_DEPLOY_TOKEN` in the bot server's secret environment. Use a **fine-grained personal access token** scoped only to this repository with **Actions: write**. Do not commit it, put it in the database, or display it in logs. Restart the bot once after adding the variable.

After this workflow is merged into `main` and the secrets are set:

- Every push to `main` automatically starts the deployment workflow.
- **Restore & Update** runs the Discord repair and dispatches a deployment of `main`.
- GitHub Actions shows the deployment result and logs. The bot reports whether the request was accepted; acceptance means queued, not yet completed.

## Safety and limitations

- The workflow deploys the latest `main`, not an unmerged feature branch.
- It updates the existing server checkout, installs dependencies, builds TypeScript, runs PostgreSQL migrations and verification, then restarts the service.
- If deployment fails, the workflow attempts to restore the prior source commit and restart the service. This is a source rollback, not a database backup; take normal Neon backups and keep migrations backward-compatible.
- SSH host-key checking is strict. Configure a verified `DEPLOY_KNOWN_HOSTS` value.
- Discord does not provide an undelete API for deleted channels, categories, or messages. SupportForge can create replacement managed infrastructure and update saved references, but deleted message history cannot be recreated unless it was separately archived. A deleted ticket channel's old snowflake cannot be resurrected.
- If the bot host is not a Linux systemd server, adapt the workflow's remote deployment step to the actual host platform before enabling it. Do not add a shell command executor to the bot itself.
- Neon PostgreSQL remains the authoritative database. This feature does not reset ticket or configuration data and does not introduce SQLite.


## Hybrid automatic updates (GitHub trigger + server watchdog)

ResolveX has three coordinated safeguards:

1. The existing GitHub Actions workflow deploys when a commit reaches main.
2. The bot's commit monitor requests a deployment workflow run when it detects a newer main commit, if GITHUB_DEPLOY_TOKEN is configured. This is a fallback trigger, not a substitute for server deployment.
3. An independent systemd timer runs scripts/self-update.sh every two minutes. It checks origin/main, builds and verifies the new source, runs PostgreSQL migrations, restarts the service and verifies that systemd reports it active. This works even if the bot process has crashed. GitHub Actions and the watchdog share a file lock and the same-commit check to avoid overlapping or redundant installs.

A Git commit changes repository source; it does not replace JavaScript already loaded by a running Node process. The workflow/watchdog therefore build and restart the bot process. New UI or category behaviour appears only if the new code contains reconciliation logic for those elements.

### Server-side watchdog setup required from the owner

The checked-in systemd files are templates. Edit them for the actual host before enabling them:

1. Place the repository on a persistent Linux server with systemd, Node.js/npm, Git, flock, and PostgreSQL network access. The deploy path must be a dedicated Git checkout of this repository.
2. Edit deploy/systemd/resolvex-self-update.service so ExecStart points to the actual absolute path of scripts/self-update.sh. Set User and Group to the intended unprivileged deployment account. It needs write access to the checkout and permission to restart only the configured bot service.
3. Install the units and create the environment file (substitute your actual paths/service name):

   sudo cp deploy/systemd/resolvex-self-update.service /etc/systemd/system/

   sudo cp deploy/systemd/resolvex-self-update.timer /etc/systemd/system/

   sudo nano /etc/resolvex-update.env

   Example environment values:
   - SUPPORTFORGE_DEPLOY_PATH=/opt/resolvex
   - SUPPORTFORGE_SERVICE_NAME=supportforge
   - SUPPORTFORGE_UPDATE_LOCK=/tmp/resolvex-deploy.lock

4. Ensure the service user can fetch the repository (if private), run npm scripts and restart the configured systemd service. Configure least-privilege sudo rules for that one service rather than unrestricted sudo.
5. Run sudo systemctl daemon-reload, then sudo systemctl enable --now resolvex-self-update.timer. Verify with systemctl list-timers resolvex-self-update.timer and inspect failures with journalctl -u resolvex-self-update.service.
6. Configure the GitHub Actions deployment secrets listed above. Put GITHUB_DEPLOY_TOKEN in the bot server's secret environment only if you want the bot monitor's optional dispatch fallback; the push workflow and watchdog do not depend on that bot token.
7. Keep the bot .env out of Git. Set TICKET_ARCHIVE_MAX_ATTACHMENT_BYTES to a limit that fits the Neon storage budget. Take Neon backups and monitor archive growth.

The current workflow and watchdog target Linux + systemd. If ResolveX runs on Windows, a container platform, or a managed host without SSH/systemd, this deployment template must be adapted to that host instead of enabling it as-is. Do not run the bot's deployed repository from a developer's working tree.

### Ticket archive rollout

The new Neon migration creates the durable message, channel snapshot, attachment and recovery tables. Existing channel history is backfilled in background pages of 100 messages. Let backfill catch up before relying on native-delete recovery for older conversations. Ticket-button deletion explicitly finishes the archive before deleting the channel. A native deletion can happen before background backfill reaches old messages, in which case only already archived history is recoverable.

The archive includes attachment bytes when the CDN file can be fetched and fits TICKET_ARCHIVE_MAX_ATTACHMENT_BYTES. Larger or unavailable files retain metadata and are reported as unavailable during replay. This limit does not make Discord deleted-message APIs available; the archive is the recovery source.
