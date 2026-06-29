#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker
: "${ACME_EMAIL:?ACME_EMAIL required (export it before calling)}"
docker network inspect mdz_edge >/dev/null 2>&1 || docker network create mdz_edge
docker compose -p mdz-edge-caddy --project-directory "$REPO_ROOT/platform" \
  -f "$REPO_ROOT/platform/docker-compose.platform.yml" up -d
log "platform (shared Caddy) up on mdz_edge"
