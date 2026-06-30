# Shared helpers for control-plane scripts. Source at top:
#   . "$(dirname "$0")/lib/common.sh"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log()  { printf '\033[1;34m[ctl]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[ctl]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[ctl] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "required command not found: $c"
  done
}

# Run the control TS CLI: ctl <subcommand> [--flag=val ...]
ctl() { node --import tsx/esm "$REPO_ROOT/control/src/cli.ts" "$@"; }

# Edge mode marker written by platform-up.sh: "tunnel" (Caddy HTTP-only on :80) or
# "letsencrypt" (default — Caddy terminates TLS). Other scripts read this to render
# per-site snippets as http:// (tunnel) vs https (letsencrypt).
edge_mode() { cat "$REPO_ROOT/platform/.edge-mode" 2>/dev/null || echo letsencrypt; }
