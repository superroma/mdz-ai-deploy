#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd ssh-keygen node
# usage: gen-deploy-key.sh <site>
site="${1:?site}"
ctl site-name --site="$site" >/dev/null
dir="$REPO_ROOT/secrets/$site"; mkdir -p "$dir"
key="$dir/deploy_key"
if [ -f "$key" ]; then log "deploy key exists: $key"; exit 0; fi
ssh-keygen -t ed25519 -N "" -C "mdz-$site-deploy" -f "$key" >/dev/null
chmod 600 "$key"
log "generated $key (+ $key.pub)"
