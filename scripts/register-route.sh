#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd node
# usage: register-route.sh <site> <domain>   (writes the snippet only; caller runs caddy-reload.sh)
site="${1:?site}"; domain="${2:?domain}"
ctl site-name --site="$site" >/dev/null
dest="$REPO_ROOT/platform/caddy/sites/$site.caddy"; mkdir -p "$(dirname "$dest")"
http=""; [ "$(edge_mode)" = tunnel ] && http="--http=true"
ctl render-snippet --domain="$domain" --site="$site" $http > "$dest"
log "wrote $dest (edge=$(edge_mode))"
