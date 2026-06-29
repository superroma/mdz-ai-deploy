#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker node
# usage: site-up.sh <site>
site="${1:?site}"
ctl site-name --site="$site" >/dev/null
env="$REPO_ROOT/secrets/$site/.env"; [ -f "$env" ] || die "missing $env (run render-site-env.sh)"
key="$REPO_ROOT/secrets/$site/deploy_key"; [ -f "$key" ] || die "missing deploy key $key"
mode="$(stat -f '%Lp' "$key" 2>/dev/null || stat -c '%a' "$key")"
[ "$mode" = "600" ] || die "deploy key must be chmod 600 (is $mode): $key"
docker compose -p "mdz-$site" --project-directory "$REPO_ROOT/compose" \
  --env-file "$env" -f "$REPO_ROOT/compose/docker-compose.site.yml" up -d --build
log "site mdz-$site up"
