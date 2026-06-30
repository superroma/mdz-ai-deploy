#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
# Refresh every site's admin token. Run on a timer.
shopt -s nullglob
for d in "$REPO_ROOT"/sites/*/; do
  site="$(basename "$d")"
  "$REPO_ROOT/scripts/mint-site-admin-secret.sh" "$site" || warn "re-mint failed for $site"
done
