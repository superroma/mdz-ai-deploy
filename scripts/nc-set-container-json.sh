#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd node
# usage: NC_DIR=<nanoclaw checkout> nc-set-container-json.sh <agentGroupId> <field> <json-value>
: "${NC_DIR:?NC_DIR (nanoclaw checkout path) is required}"
[ -f "$NC_DIR/dist/db/container-configs.js" ] || die "nanoclaw not built at $NC_DIR (run pnpm build there)"
NC_DIR="$NC_DIR" node "$REPO_ROOT/scripts/nc/set-container-json.mjs" "$@"
