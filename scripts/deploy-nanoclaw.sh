#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd git
# Clone the nanoclaw checkout THIS toolkit owns (NC_DIR, default $REPO_ROOT/nanoclaw)
# and hand off to nanoclaw's OWN skill-driven setup. nanoclaw sets itself up via its
# Claude Code skills (deps, Claude auth, agent container, service) — we do not
# bash-orchestrate that, and we never touch a nanoclaw checkout outside this repo.
# usage: [NC_DIR=...] [NANOCLAW_REPO=...] deploy-nanoclaw.sh
repo_url="${NANOCLAW_REPO:-https://github.com/nanocoai/nanoclaw}"
if [ -d "$NC_DIR/.git" ]; then
  log "nanoclaw checkout present at $NC_DIR"
else
  log "cloning nanoclaw ($repo_url) into $NC_DIR"
  git clone "$repo_url" "$NC_DIR"
fi
cat >&2 <<EOF

nanoclaw is cloned at: $NC_DIR

Deploy it by running ITS OWN Claude Code skills there (they handle dependencies,
Claude auth, the agent container, and the service — this toolkit does not):

  cd "$NC_DIR" && claude
    /setup          # dependencies, Claude auth, agent container, service
    /add-telegram   # wire your Telegram bot token (from BotFather)
    /init-onecli    # OneCLI gateway; puts onecli/ncl on PATH

When nanoclaw's service is running and 'ncl'/'onecli' are on PATH, come back here,
grant content access, and provision agents:
  scripts/ensure-mount-allowlist.sh    # then restart nanoclaw
  /add-agent
EOF
log "nanoclaw checkout ready at $NC_DIR"
