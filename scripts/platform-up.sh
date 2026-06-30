#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker
# EDGE_MODE=letsencrypt (default) — Caddy terminates TLS via ACME; needs ACME_EMAIL.
# EDGE_MODE=tunnel             — Caddy is HTTP-only on :80 behind a Cloudflare tunnel
#                               (TLS at the edge); no ACME_EMAIL required.
EDGE_MODE="${EDGE_MODE:-letsencrypt}"
docker network inspect mdz_edge >/dev/null 2>&1 || docker network create mdz_edge
if [ "$EDGE_MODE" = "tunnel" ]; then
  export CADDY_FILE="./caddy/Caddyfile.tunnel"
  log "EDGE_MODE=tunnel — Caddy HTTP-only on :80 (TLS terminates at the tunnel edge); ACME disabled"
else
  : "${ACME_EMAIL:?ACME_EMAIL required for EDGE_MODE=letsencrypt (export it, or use EDGE_MODE=tunnel)}"
  export CADDY_FILE="./caddy/Caddyfile"
fi
# Record the active edge mode so snippet-rendering scripts (register-route, tls-selftest)
# know whether to emit http:// (tunnel) or https (letsencrypt) site addresses.
printf '%s\n' "$EDGE_MODE" > "$REPO_ROOT/platform/.edge-mode"
docker compose -p mdz-edge-caddy --project-directory "$REPO_ROOT/platform" \
  -f "$REPO_ROOT/platform/docker-compose.platform.yml" up -d
log "platform (shared Caddy) up on mdz_edge (EDGE_MODE=$EDGE_MODE)"
