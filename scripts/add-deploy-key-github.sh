#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd gh
# usage: add-deploy-key-github.sh <site> <owner/repo>
site="${1:?site}"; slug="${2:?owner/repo}"
pub="$REPO_ROOT/secrets/$site/deploy_key.pub"
[ -f "$pub" ] || die "missing $pub (run gen-deploy-key.sh first)"
gh repo deploy-key add "$pub" --repo "$slug" --title "mdz-$site" --allow-write \
  || warn "gh deploy-key add failed; add $pub to $slug manually with WRITE access"
