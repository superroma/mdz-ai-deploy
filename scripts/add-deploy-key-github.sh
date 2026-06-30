#!/usr/bin/env bash
. "$(dirname "$0")/lib/common.sh"
require_cmd gh node
# usage: add-deploy-key-github.sh <site> <content_repo>   (owner/repo derived from the URL)
site="${1:?site}"; repo_url="${2:?content_repo}"; slug="$(ctl repo-slug --repo="$repo_url")"
pub="$REPO_ROOT/secrets/$site/deploy_key.pub"
[ -f "$pub" ] || die "missing $pub (run gen-deploy-key.sh first)"
gh repo deploy-key add "$pub" --repo "$slug" --title "mdz-$site" --allow-write \
  || warn "gh deploy-key add failed; add $pub to $slug manually with WRITE access"
