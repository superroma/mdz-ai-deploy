#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd git docker node
# usage: NC_DIR=~/work/nanoclaw TELEGRAM_BOT_TOKEN=... deploy-nanoclaw.sh
: "${NC_DIR:?NC_DIR (nanoclaw checkout path) is required}"
[ -d "$NC_DIR/.git" ] || die "no nanoclaw checkout at $NC_DIR (clone nanocoai/nanoclaw there first)"
log "Deploying nanoclaw from $NC_DIR"
# 1. Install + build (nanoclaw uses pnpm)
( cd "$NC_DIR" && command -v pnpm >/dev/null || die "pnpm required"; pnpm install && pnpm build )
# 2. Build the agent container image
( cd "$NC_DIR/container" && bash build.sh )
# 3. Run nanoclaw's own setup (installs the launchd/systemd service, OneCLI init, etc.)
log "Run nanoclaw's setup interactively (its /setup or setup.sh) to install the service + OneCLI + Anthropic creds:"
log "  cd $NC_DIR && bash setup.sh    # then /init-onecli, and add-telegram with TELEGRAM_BOT_TOKEN"
# 4. Telegram adapter (idempotent; needs the token in env)
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -f "$NC_DIR/setup/add-telegram.sh" ]; then
  ( cd "$NC_DIR" && TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" bash setup/add-telegram.sh ) || warn "add-telegram failed; run it manually"
fi
log "nanoclaw deploy steps issued. Verify the service is running before provisioning agents."
