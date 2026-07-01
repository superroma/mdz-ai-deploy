#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
umask 077
require_cmd node openssl
# usage: render-site-env.sh <site> <base_domain> <content_repo> [mdz_ref=main] [branch=main]
# mdz_ref defaults to main (latest mdz, incl. Part B's mint-admin-token); pass a
# commit SHA instead for a reproducible build.
site="${1:?site}"; base="${2:?base_domain}"; repo="${3:?content_repo}"; ref="${4:-main}"; branch="${5:-main}"
ctl site-name --site="$site" >/dev/null
dir="$REPO_ROOT/secrets/$site"; mkdir -p "$dir"
jwt="$(openssl rand -hex 32)"
ctl render-env --site="$site" --base="$base" --repo="$repo" --ref="$ref" --jwt="$jwt" --branch="$branch" > "$dir/.env"
chmod 600 "$dir/.env"
log "wrote $dir/.env"
