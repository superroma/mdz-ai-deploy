#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker
docker compose -p mdz-edge-caddy exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose -p mdz-edge-caddy exec -T caddy caddy reload --config /etc/caddy/Caddyfile
log "caddy validated + reloaded"
