#!/usr/bin/env bash
# Refresh the local copy of the Ariantra brand kit CSS (public/brand/) from the
# platform repo, where it is GENERATED from theme.ts (scripts/build-brand-css.mjs).
# kidgemini serves its own copy so the header never depends on another origin.
# Runs automatically before deploy; override the source with ARIANTRA_PLATFORM_DIR.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLATFORM_DIR="${ARIANTRA_PLATFORM_DIR:-$REPO_DIR/../Ariantra-Platform}"
SRC="$PLATFORM_DIR/public/brand/ariantra-brand.v1.css"

if [ ! -f "$SRC" ]; then
  echo "✗ Brand CSS not found at $SRC" >&2
  echo "  Set ARIANTRA_PLATFORM_DIR, or run 'npm run build:brand' in the platform repo first." >&2
  exit 1
fi

mkdir -p "$REPO_DIR/public/brand"
cp "$SRC" "$REPO_DIR/public/brand/ariantra-brand.v1.css"
# Favicon ships with the kit too (SVG generated, PNGs rastered from it — see
# build-favicon-raster.mjs in the platform repo).
for f in ariantra-favicon.svg ariantra-favicon.png apple-touch-icon.png; do
  [ -f "$PLATFORM_DIR/public/brand/$f" ] && cp "$PLATFORM_DIR/public/brand/$f" "$REPO_DIR/public/brand/$f"
done
echo "✓ brand CSS + favicons synced from $PLATFORM_DIR/public/brand/"
