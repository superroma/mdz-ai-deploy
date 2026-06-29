#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd dig
# usage: dns-check.sh <probe_host> <expected_ip>
host="${1:?probe_host}"; ip="${2:?expected_ip}"
resolved="$(dig +short "$host" A | tr '\n' ' ')"
log "$host A => ${resolved:-(none)}"
echo "$resolved" | tr ' ' '\n' | grep -qx "$ip" \
  && { log "DNS OK ($host -> $ip)"; exit 0; } \
  || { warn "DNS not pointing at $ip yet"; exit 1; }
