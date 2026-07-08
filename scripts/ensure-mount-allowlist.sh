#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd node
# usage: ensure-mount-allowlist.sh   (adds the sites/ root with allowReadWrite=true)
allowlist="$HOME/.config/nanoclaw/mount-allowlist.json"
sites_root="$REPO_ROOT/sites"
mkdir -p "$(dirname "$allowlist")"
updated="$(ctl merge-allowlist-root --file="$allowlist" --path="$sites_root" --rw=true --desc="mdz site content")"
printf '%s\n' "$updated" > "$allowlist"
log "mount allowlist now grants RW on $sites_root (field: allowReadWrite). nanoclaw v2 re-reads it by mtime — no restart needed."
