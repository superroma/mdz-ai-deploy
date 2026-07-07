#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd node
# usage: nc-set-container-json.sh <agentGroupId> <field> <json-value>
# NC_DIR defaults to the toolkit-owned checkout ($REPO_ROOT/nanoclaw); see common.sh.
[ -f "$NC_DIR/dist/db/container-configs.js" ] || die "nanoclaw not built at $NC_DIR (run its /setup first)"
NC_DIR="$NC_DIR" node "$REPO_ROOT/scripts/nc/set-container-json.mjs" "$@"
