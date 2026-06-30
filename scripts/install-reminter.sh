#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
# Install a ~30-minute timer for reminter.sh. macOS=launchd, Linux=cron fallback.
if [ "$(uname)" = "Darwin" ]; then
  plist="$HOME/Library/LaunchAgents/com.mdz.reminter.plist"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mdz.reminter</string>
  <key>ProgramArguments</key><array><string>$REPO_ROOT/scripts/reminter.sh</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardErrorPath</key><string>$REPO_ROOT/.reminter.log</string>
  <key>StandardOutPath</key><string>$REPO_ROOT/.reminter.log</string>
</dict></plist>
PLIST
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  log "installed launchd re-minter (every 30m): $plist"
else
  line="*/30 * * * * PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin $REPO_ROOT/scripts/reminter.sh >> $REPO_ROOT/.reminter.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'scripts/reminter.sh'; echo "$line" ) | crontab -
  log "installed cron re-minter (every 30m)"
fi
