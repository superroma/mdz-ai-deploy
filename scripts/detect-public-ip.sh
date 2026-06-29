#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd curl
ip="$(curl -fsS https://api.ipify.org || true)"
[ -n "$ip" ] || ip="$(curl -fsS https://ifconfig.me || true)"
[ -n "$ip" ] || die "could not detect public IP"
printf '%s\n' "$ip"
