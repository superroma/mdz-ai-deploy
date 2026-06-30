#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker node onecli
# usage: mint-site-admin-secret.sh <site>   (mints + upserts the per-site admin token in OneCLI)
site="${1:?site}"
ctl site-name --site="$site" >/dev/null
env="$REPO_ROOT/secrets/$site/.env"; [ -f "$env" ] || die "missing $env"
base="$(grep -E '^BASE_DOMAIN=' "$env" | cut -d= -f2- || true)"; [ -n "$base" ] || die "no BASE_DOMAIN in $env"
host="$(ctl site-api-host --site="$site" --base="$base")"
secret_name="$(ctl admin-secret-name --site="$site")"
# Mint a fresh token inside the site's mdz container (it holds this site's JWT_SECRET)
token="$(docker compose -p "mdz-$site" exec -T mdz node packages/backend/dist/cli/admin.js mint-admin-token "agent-admin@$host")"
[ -n "$token" ] || die "mint-admin-token produced no token for $site"
# Upsert into OneCLI: create if absent, else update the value
if onecli secrets list 2>/dev/null | grep -qw "$secret_name"; then
  onecli secrets update --name "$secret_name" --value "$token"
else
  onecli secrets create --name "$secret_name" --type generic --value "$token" \
    --host-pattern "$host" --header-name "Authorization" --value-format "Bearer {value}"
fi
log "refreshed OneCLI secret $secret_name for https://$host"
