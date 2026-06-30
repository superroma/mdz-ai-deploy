#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker
# usage: seed-admin.sh <site> <owner_email>   (prints the magic link)
site="${1:?site}"; email="${2:?owner_email}"
env="$REPO_ROOT/secrets/$site/.env"; [ -f "$env" ] || die "missing $env"
base="$(grep -E '^BASE_DOMAIN=' "$env" | cut -d= -f2- || true)"
[ -n "$base" ] || die "BASE_DOMAIN not found in $env"
domain="$site.$base"
docker compose -p "mdz-$site" exec -T -e "BACKEND_URL=https://$domain" mdz \
  node packages/backend/dist/cli/admin.js add-user "$email" admins
