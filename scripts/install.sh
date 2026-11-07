#!/usr/bin/env bash
# Copies mods/pr-panel/ into Herdr's mods folder and checks it. Herdr reloads it live.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="$HOME/.config/herdr-app/mods/pr-panel"
mkdir -p "$DEST"
# jsconfig.json and *.d.ts are written by Herdr itself; leave them alone.
rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' mods/pr-panel/ "$DEST/"
herdr-app check "$DEST"
