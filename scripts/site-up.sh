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

compose_cmd() {
  docker compose -p "mdz-$site" --project-directory "$REPO_ROOT/compose" \
    --env-file "$env" -f "$REPO_ROOT/compose/docker-compose.site.yml" "$@"
}
compose_cmd up -d --build

# Stale-mount guard: a bind mount binds an inode, not a path. If sites/<site>/repo
# was replaced (e.g. re-cloned) while a container from a prior 'up' was running,
# that container keeps serving the OLD, now-empty inode — the site shows no pages
# and the sidecar crash-loops on "Not a git repository". If the host tree is a git
# repo but the mdz container can't see /data/repo/.git, the mount is stale; a
# --force-recreate re-binds both services to the current directory.
if [ -d "$REPO_ROOT/sites/$site/repo/.git" ]; then
  stale=1
  for _ in 1 2 3; do
    if compose_cmd exec -T mdz test -d /data/repo/.git 2>/dev/null; then stale=0; break; fi
    sleep 1
  done
  if [ "$stale" = 1 ]; then
    warn "mdz-$site: stale bind mount of sites/$site/repo (container can't see /data/repo/.git); recreating"
    compose_cmd up -d --force-recreate
  fi
fi
log "site mdz-$site up"
