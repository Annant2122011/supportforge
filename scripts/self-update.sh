#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${SUPPORTFORGE_DEPLOY_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SERVICE_NAME="${SUPPORTFORGE_SERVICE_NAME:-supportforge}"
LOCK_FILE="${SUPPORTFORGE_UPDATE_LOCK:-/tmp/resolvex-deploy.lock}"

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock 9

cd "$REPO_DIR"
if [[ ! -d .git ]]; then
  echo "Not a Git checkout: $REPO_DIR" >&2
  exit 2
fi

old_sha="$(git rev-parse HEAD)"
target_sha=""
rollback() {
  status=$?
  trap - ERR
  if [[ "$status" -ne 0 && -n "$old_sha" ]]; then
    echo "QueryFixr update failed. Attempting source rollback to $old_sha." >&2
    git checkout -B main "$old_sha" || true
    git reset --hard "$old_sha" || true
    npm ci || true
    npm run build || true
    npm run deploy-commands || true
    npm run db:migrate || true
    sudo systemctl restart "$SERVICE_NAME" || true
    sudo systemctl is-active --quiet "$SERVICE_NAME" || true
  fi
  exit "$status"
}
trap rollback ERR

git fetch --prune origin main
target_sha="$(git rev-parse origin/main)"
if [[ "$target_sha" == "$old_sha" ]]; then
  echo "QueryFixr is already current at $target_sha."
  trap - ERR
  exit 0
fi

echo "Updating QueryFixr from $old_sha to $target_sha."
git checkout -B main "$target_sha"
git reset --hard "$target_sha"
npm ci
npm run build
npm test
npm run db:migrate
npm run db:verify
npm run deploy-commands
sudo systemctl restart "$SERVICE_NAME"
sleep 3
sudo systemctl is-active --quiet "$SERVICE_NAME"

trap - ERR
echo "QueryFixr deployment succeeded at $target_sha."
