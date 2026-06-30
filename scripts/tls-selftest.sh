#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd docker curl
# usage: tls-selftest.sh <base_domain>   (fixed probe host spares LE rate limits)
base="${1:?base_domain}"
host="mdz-selftest.$base"
snip="$REPO_ROOT/platform/caddy/sites/zz-selftest.caddy"
trap 'rm -f "$snip"' EXIT
# tunnel mode → http:// so Caddy serves on :80 (TLS terminates at the tunnel edge)
addr="$host"; [ "$(edge_mode)" = tunnel ] && addr="http://$host"
printf '%s {\n\trespond "ok" 200\n}\n' "$addr" > "$snip"
"$REPO_ROOT/scripts/caddy-reload.sh"
ok=1
for _ in $(seq 1 20); do
  curl -fsS "https://$host" >/dev/null 2>&1 && { ok=0; break; }
  sleep 3
done
rm -f "$snip"; "$REPO_ROOT/scripts/caddy-reload.sh"
[ "$ok" = 0 ] && log "TLS self-test passed (real cert on $host)" || die "TLS self-test failed for $host"
