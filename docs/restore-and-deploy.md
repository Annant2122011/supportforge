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
