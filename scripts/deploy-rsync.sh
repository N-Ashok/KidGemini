#!/usr/bin/env bash
#
# kidgemini → EC2 deploy (same pattern as Ariantra-Platform/scripts/deploy-rsync.sh):
# build locally, rsync artifacts, install Linux prod deps only when the lockfile
# changes, pm2 restart. Runs as a SECOND Next app on the shared Ariantra box,
# behind Caddy (kidgemini.ariantra.com → 127.0.0.1:3001).
#
# node_modules is NOT copied (macOS natives don't run on Linux — better-sqlite3
# compiles on the box; needs build-essential + python3, see the runbook).
#
# One-time on the box:
#   - ~/kidgemini/.env with prod secrets (GEMINI_API_KEY, AUTH_*, PARENT_PIN,
#     Razorpay) and DATABASE_PATH=/var/lib/kidgemini/kidgemini.db (absolute!)
#   - sudo mkdir -p /var/lib/kidgemini && sudo chown "$USER" /var/lib/kidgemini
#   - Caddyfile block: kidgemini.ariantra.com { reverse_proxy 127.0.0.1:3001 }
#
# Configure via env vars or scripts/deploy.env (gitignored):
#   KIDGEMINI_SSH         ubuntu@<elastic-ip> or an SSH config alias  (required)
#   KIDGEMINI_REMOTE_DIR  app dir on EC2            (default ~/kidgemini)
#   KIDGEMINI_PM2_NAME    pm2 process name          (default kidgemini)
#   KIDGEMINI_PORT        next start port           (default 3001)
#   KIDGEMINI_HEALTH_URL  URL to curl after deploy  (optional)
#
# Usage:  npm run deploy        (or: bash scripts/deploy-rsync.sh)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$SCRIPT_DIR/deploy.env" ] && source "$SCRIPT_DIR/deploy.env"

SSH_TARGET="${KIDGEMINI_SSH:-}"
REMOTE_DIR="${KIDGEMINI_REMOTE_DIR:-~/kidgemini}"
PM2_NAME="${KIDGEMINI_PM2_NAME:-kidgemini}"
PORT="${KIDGEMINI_PORT:-3001}"
HEALTH_URL="${KIDGEMINI_HEALTH_URL:-}"

if [ -z "$SSH_TARGET" ]; then
  echo "✗ Set KIDGEMINI_SSH (e.g. export KIDGEMINI_SSH=ubuntu@<elastic-ip>)" >&2
  echo "  or copy scripts/deploy.env.example → scripts/deploy.env and fill it in." >&2
  exit 1
fi

cd "$REPO_DIR"

echo "→ [local] syncing brand kit CSS from the platform repo…"
bash "$SCRIPT_DIR/sync-brand.sh"

echo "→ [local] building (next build)…"
npm run build

echo "→ [local] shipping artifacts to $SSH_TARGET:$REMOTE_DIR …"
# top-level REMOTE_DIR, node_modules, .env and the SQLite data dir are never
# touched — only the listed artifacts are synced.
rsync -az --delete \
  --exclude='.next/cache' \
  .next public package.json package-lock.json next.config.js \
  "$SSH_TARGET:$REMOTE_DIR/"

echo "→ [local] installing prod deps (if lockfile changed) + restarting on EC2…"
ssh "$SSH_TARGET" 'bash -s' -- "$REMOTE_DIR" "$PM2_NAME" "$PORT" <<'REMOTE'
set -euo pipefail
DIR="$1"; PM2="$2"; PORT="$3"
DIR="${DIR/#\~/$HOME}"
cd "$DIR"
LOCK_SHA="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ ! -f .deploy-lock.sha ] || [ "$(cat .deploy-lock.sha 2>/dev/null)" != "$LOCK_SHA" ]; then
  echo "→ [remote] dependencies changed — npm ci --omit=dev (better-sqlite3 compiles here)"
  npm ci --omit=dev
  echo "$LOCK_SHA" > .deploy-lock.sha
else
  echo "→ [remote] dependencies unchanged — skipping install"
fi
pm2 restart "$PM2" --update-env || PORT="$PORT" pm2 start "npm run start" --name "$PM2"
pm2 save
echo "✓ [remote] restarted '$PM2'"
REMOTE

if [ -n "$HEALTH_URL" ]; then
  echo "→ [local] health check: $HEALTH_URL"
  if curl -fsS "$HEALTH_URL" >/dev/null; then echo "  ✓ healthy"; else echo "  ✗ health check failed" >&2; exit 1; fi
fi

echo "✓ Deploy finished."
