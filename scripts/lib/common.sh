# Shared helpers for control-plane scripts. Source at top:
#   . "$(dirname "$0")/lib/common.sh"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# nanoclaw checkout THIS toolkit owns — deploy-nanoclaw.sh clones it here (gitignored).
# We never touch a nanoclaw checkout outside this repo. Override NC_DIR only to point
# deliberately at a different checkout.
NC_DIR="${NC_DIR:-$REPO_ROOT/nanoclaw}"; export NC_DIR

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

# Assert nanoclaw is deployed on this host (its CLI is on PATH). Part B scripts
# call this so an incomplete /setup fails with an actionable message instead of a
# bare "command not found" — and so callers don't go hunting for a runtime that
# was never deployed here.
require_nanoclaw() {
  for c in ncl onecli; do
    command -v "$c" >/dev/null 2>&1 || die "nanoclaw is not deployed on this host ('$c' not on PATH). /setup is not finished — run its nanoclaw-deploy step (step 7, scripts/deploy-nanoclaw.sh) here, then retry."
  done
}

# Edge mode marker written by platform-up.sh: "tunnel" (Caddy HTTP-only on :80) or
# "letsencrypt" (default — Caddy terminates TLS). Other scripts read this to render
# per-site snippets as http:// (tunnel) vs https (letsencrypt).
edge_mode() { cat "$REPO_ROOT/platform/.edge-mode" 2>/dev/null || echo letsencrypt; }
